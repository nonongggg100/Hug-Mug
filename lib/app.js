// Hog & Mug — app core shared by the local server (server.js) and Vercel (api/index.js).
// Zero dependencies. Storage is pluggable: a JSON file locally, Upstash Redis on Vercel.

const crypto = require("crypto");

const APP_VERSION = "1.4.0 (Vercel ready)";
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme"; // set your own in production
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
const ADMIN_KEY_OK = !(IS_PROD && (ADMIN_KEY === "changeme" || ADMIN_KEY.length < 12));

const DELIVERY_FEE = 49;
const FREE_DELIVERY_OVER = 500;
const MAX_QTY = 50;
const ORDER_STATUSES = ["new", "preparing", "out_for_delivery", "ready_for_pickup", "completed", "cancelled"];

// ---------- Menu (source of truth for prices) ----------
const MENU = [
  { id: 1,  cat: "Meals",       name: "Crispy Pork Belly Rice", desc: "Roasted pork belly, garlic rice, pickled papaya.", price: 220, emo: "🍚", bg: "#fde3e9" },
  { id: 2,  cat: "Meals",       name: "Chicken Adobo Bowl",     desc: "Slow-braised chicken, soft egg, steamed rice.",   price: 190, emo: "🍗", bg: "#fdebd8" },
  { id: 3,  cat: "Meals",       name: "Beef Tapa Plate",        desc: "Sweet-cured beef, fried egg, garlic rice.",       price: 210, emo: "🥩", bg: "#f6e0d3" },
  { id: 4,  cat: "Meals",       name: "Creamy Carbonara",       desc: "Bacon, parmesan, cream sauce, garlic bread.",     price: 180, emo: "🍝", bg: "#fff1d6" },
  { id: 5,  cat: "Snacks",      name: "Hog Burger",             desc: "Pork patty, cheddar, caramelized onions.",        price: 175, emo: "🍔", bg: "#fdebd8" },
  { id: 6,  cat: "Snacks",      name: "Loaded Fries",           desc: "Cheese sauce, bacon bits, spring onion.",         price: 120, emo: "🍟", bg: "#fff1d6" },
  { id: 7,  cat: "Snacks",      name: "Clubhouse Sandwich",     desc: "Ham, chicken, egg, lettuce, toasted bread.",      price: 150, emo: "🥪", bg: "#e8f2e0" },
  { id: 8,  cat: "Pastries",    name: "Butter Croissant",       desc: "Flaky, golden and baked every morning.",          price: 85,  emo: "🥐", bg: "#fff1d6" },
  { id: 9,  cat: "Pastries",    name: "Ensaymada",              desc: "Soft brioche, butter, sugar, grated cheese.",     price: 70,  emo: "🧁", bg: "#fde3e9" },
  { id: 10, cat: "Pastries",    name: "Chocolate Cookie",       desc: "Chewy center with dark chocolate chunks.",        price: 60,  emo: "🍪", bg: "#f6e0d3" },
  { id: 11, cat: "Hot Drinks",  name: "Hog House Latte",        desc: "Espresso, steamed milk, light foam.",             price: 140, emo: "☕", bg: "#f6e0d3" },
  { id: 12, cat: "Hot Drinks",  name: "Spanish Latte",          desc: "Espresso with sweetened condensed milk.",         price: 155, emo: "☕", bg: "#fdebd8" },
  { id: 13, cat: "Hot Drinks",  name: "Hot Tsokolate",          desc: "Rich native cacao, thick and creamy.",            price: 130, emo: "🍫", bg: "#f6e0d3" },
  { id: 14, cat: "Hot Drinks",  name: "Ginger Tea",             desc: "Fresh ginger brewed with honey.",                 price: 95,  emo: "🍵", bg: "#e8f2e0" },
  { id: 15, cat: "Cold Drinks", name: "Iced Caramel Macchiato", desc: "Vanilla, milk, espresso, caramel drizzle.",       price: 165, emo: "🧋", bg: "#fff1d6" },
  { id: 16, cat: "Cold Drinks", name: "Strawberry Milk",        desc: "Fresh strawberry purée and cold milk.",           price: 135, emo: "🥤", bg: "#fde3e9" },
  { id: 17, cat: "Cold Drinks", name: "Calamansi Cooler",       desc: "Calamansi, honey, sparkling water.",              price: 99,  emo: "🍋", bg: "#f4f7d8" },
];
const menuById = new Map(MENU.map(m => [m.id, m]));

// ---------- Data (loaded fresh for every request, see createHandler) ----------
let db = null;      // the current request's copy of the data
let dirty = false;  // set when the request changed something that must be saved
let pendingLogs = []; // printed only once the request's changes are saved (requests may be retried)
const log = msg => pendingLogs.push(msg);
const normalize = data => ({ carts: {}, orders: [], users: [], sessions: {}, nextOrderNo: 1001, ...(data || {}) });
function saveDb() { dirty = true; }

// Remove carts untouched for 7 days
function pruneCarts() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [id, c] of Object.entries(db.carts)) if (c.updatedAt < cutoff) delete db.carts[id];
  for (const [t, s] of Object.entries(db.sessions)) if (s.expiresAt < Date.now()) delete db.sessions[t];
}

// ---------- Helpers ----------
function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}
const fail = (res, status, error) => send(res, status, { error });

// The raw body is read once up front (req.rawBody) so a request can be safely re-run
async function readBody(req) {
  const raw = req.rawBody || "";
  if (raw.length > 100_000) throw new Error("too_large");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("bad_json"); }
}
function readRawBody(req) {
  // On Vercel the platform may have already parsed the body
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
  }
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve("");
  // Already read by the platform (e.g. Vercel with an empty body): nothing left to wait for
  if (req.readableEnded) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let raw = "";
    setTimeout(() => reject(new Error("body_timeout")), 10_000).unref();
    req.on("data", chunk => { raw += chunk; if (raw.length > 100_000) { req.destroy(); reject(new Error("too_large")); } });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Append a cookie without overwriting others set in the same response
function addCookie(res, cookie) {
  // Behind HTTPS (e.g. on Render/Railway), only send cookies over secure connections
  if (res.req && String(res.req.headers["x-forwarded-proto"] || "").startsWith("https")) cookie += "; Secure";
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, cookie) : cookie);
}

// Each browser gets its own cart via an HttpOnly cookie
function getCart(req, res) {
  let id = parseCookies(req).cart_id;
  if (!id || !db.carts[id]) {
    id = crypto.randomUUID();
    db.carts[id] = { items: {}, updatedAt: Date.now() };
    saveDb();
    addCookie(res, `cart_id=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  }
  return db.carts[id];
}

function cartSummary(cart, method = "delivery") {
  const items = Object.entries(cart.items)
    .map(([id, qty]) => {
      const m = menuById.get(Number(id));
      return m ? { id: m.id, name: m.name, emo: m.emo, price: m.price, qty, lineTotal: m.price * qty } : null;
    })
    .filter(Boolean);
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const delivery = method === "pickup" || subtotal === 0 || subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE;
  return { items, count: items.reduce((s, i) => s + i.qty, 0), subtotal, delivery, total: subtotal + delivery };
}

const cleanStr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const isAdmin = req => ADMIN_KEY_OK && safeEqual(req.headers["x-admin-key"] || "", ADMIN_KEY);

// ---------- Users & sessions ----------
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return safeEqual(hash, user.passwordHash);
}
// What the browser is allowed to see about a user
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, address: u.address || "", createdAt: u.createdAt });

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { userId, expiresAt: Date.now() + SESSION_DAYS * 24 * 3600 * 1000 };
  addCookie(res, `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}`);
}
function getUser(req) {
  const token = parseCookies(req).session;
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expiresAt < Date.now()) { delete db.sessions[token]; return null; }
  const user = db.users.find(u => u.id === s.userId);
  return user && !user.disabled ? user : null;
}
function endSessionsFor(userId) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === userId) delete db.sessions[t];
}

// Simple brute-force protection: max 10 failed logins per email+IP per 15 minutes
const loginFails = new Map();
function tooManyAttempts(key) {
  const r = loginFails.get(key);
  return r && r.count >= 10 && Date.now() - r.first < 15 * 60 * 1000;
}
function recordFail(key) {
  const r = loginFails.get(key);
  if (!r || Date.now() - r.first > 15 * 60 * 1000) loginFails.set(key, { count: 1, first: Date.now() });
  else r.count++;
}


// ---------- API ----------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  let m;

  if (pathname.startsWith("/api/admin/") && !ADMIN_KEY_OK)
    return fail(res, 503, "Admin is disabled: set the ADMIN_KEY environment variable (12+ characters) and redeploy.");

  // Menu
  if (pathname === "/api/menu" && method === "GET") return send(res, 200, MENU);
  if (pathname === "/api/version" && method === "GET") return send(res, 200, { version: APP_VERSION });

  // Cart
  if (pathname === "/api/cart" && method === "GET") {
    const cart = getCart(req, res);
    return send(res, 200, cartSummary(cart, url.searchParams.get("method")));
  }
  if (pathname === "/api/cart" && method === "DELETE") {
    const cart = getCart(req, res);
    cart.items = {}; cart.updatedAt = Date.now(); saveDb();
    return send(res, 200, cartSummary(cart));
  }
  // Add item: POST /api/cart/items { id, qty? }
  if (pathname === "/api/cart/items" && method === "POST") {
    const body = await readBody(req);
    const item = menuById.get(Number(body.id));
    if (!item) return fail(res, 400, "Unknown menu item");
    const qty = body.qty === undefined ? 1 : Number(body.qty);
    if (!Number.isInteger(qty) || qty < 1) return fail(res, 400, "Quantity must be a positive whole number");
    const cart = getCart(req, res);
    cart.items[item.id] = Math.min((cart.items[item.id] || 0) + qty, MAX_QTY);
    cart.updatedAt = Date.now(); saveDb();
    return send(res, 201, cartSummary(cart, url.searchParams.get("method")));
  }
  // Set quantity / remove item
  if ((m = pathname.match(/^\/api\/cart\/items\/(\d+)$/))) {
    const cart = getCart(req, res);
    const id = Number(m[1]);
    if (method === "PATCH") {
      const { qty } = await readBody(req);
      if (!Number.isInteger(qty) || qty < 0) return fail(res, 400, "Quantity must be 0 or more");
      if (!menuById.has(id)) return fail(res, 400, "Unknown menu item");
      if (qty === 0) delete cart.items[id]; else cart.items[id] = Math.min(qty, MAX_QTY);
    } else if (method === "DELETE") {
      delete cart.items[id];
    } else return fail(res, 405, "Method not allowed");
    cart.updatedAt = Date.now(); saveDb();
    return send(res, 200, cartSummary(cart, url.searchParams.get("method")));
  }

  // ---- Auth ----
  // Sign up: POST /api/auth/register { name, email, phone, address, password }
  if (pathname === "/api/auth/register" && method === "POST") {
    const body = await readBody(req);
    const name = cleanStr(body.name, 80);
    const email = cleanStr(body.email, 120).toLowerCase();
    const phone = cleanStr(body.phone, 30);
    const address = cleanStr(body.address, 300);
    const password = typeof body.password === "string" ? body.password : "";
    const errors = [];
    if (!name) errors.push("Name is required");
    if (!EMAIL_RE.test(email)) errors.push("A valid email is required");
    if (!PHONE_RE.test(phone)) errors.push("A valid phone number is required");
    if (!address) errors.push("Address is required");
    if (password.length < 8) errors.push("Password must be at least 8 characters");
    if (db.users.some(u => u.email === email)) errors.push("An account with this email already exists");
    if (errors.length) return send(res, 400, { error: errors.join(". "), errors });

    const { salt, hash } = hashPassword(password);
    const user = { id: crypto.randomUUID(), name, email, phone, address, salt, passwordHash: hash, createdAt: new Date().toISOString(), disabled: false };
    db.users.push(user);
    createSession(res, user.id);
    saveDb();
    log(`New user ${email}`);
    return send(res, 201, publicUser(user));
  }

  // Log in: POST /api/auth/login { email, password }
  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    const email = cleanStr(body.email, 120).toLowerCase();
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "";
    const key = email + "|" + ip;
    if (tooManyAttempts(key)) return fail(res, 429, "Too many attempts. Please wait 15 minutes and try again.");
    const user = db.users.find(u => u.email === email);
    if (!user || !checkPassword(String(body.password || ""), user)) {
      recordFail(key);
      return fail(res, 401, "Incorrect email or password");
    }
    if (user.disabled) return fail(res, 403, "This account has been disabled. Please contact us.");
    loginFails.delete(key);
    createSession(res, user.id);
    saveDb();
    return send(res, 200, publicUser(user));
  }

  // Log out: POST /api/auth/logout
  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(req).session;
    if (token && db.sessions[token]) { delete db.sessions[token]; saveDb(); }
    addCookie(res, "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return send(res, 200, { ok: true });
  }

  // Current user: GET /api/auth/me
  if (pathname === "/api/auth/me" && method === "GET") {
    const user = getUser(req);
    return send(res, 200, { user: user ? publicUser(user) : null });
  }

  // ---- My account (login required) ----
  if (pathname.startsWith("/api/account")) {
    const user = getUser(req);
    if (!user) return fail(res, 401, "Please log in");

    if (pathname === "/api/account" && method === "PATCH") {
      const body = await readBody(req);
      const name = body.name !== undefined ? cleanStr(body.name, 80) : user.name;
      const phone = body.phone !== undefined ? cleanStr(body.phone, 30) : user.phone;
      const address = body.address !== undefined ? cleanStr(body.address, 300) : user.address;
      if (!name) return fail(res, 400, "Name is required");
      if (!PHONE_RE.test(phone)) return fail(res, 400, "A valid phone number is required");
      Object.assign(user, { name, phone, address });
      saveDb();
      return send(res, 200, publicUser(user));
    }
    if (pathname === "/api/account/password" && method === "POST") {
      const { currentPassword, newPassword } = await readBody(req);
      if (!checkPassword(String(currentPassword || ""), user)) return fail(res, 400, "Current password is incorrect");
      if (typeof newPassword !== "string" || newPassword.length < 8) return fail(res, 400, "New password must be at least 8 characters");
      const { salt, hash } = hashPassword(newPassword);
      user.salt = salt; user.passwordHash = hash;
      endSessionsFor(user.id);   // log out everywhere else…
      createSession(res, user.id); // …but keep this browser logged in
      saveDb();
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/account/orders" && method === "GET") {
      const mine = db.orders.filter(o => o.userId === user.id).slice().reverse()
        .map(o => ({ id: o.id, orderNo: o.orderNo, createdAt: o.createdAt, status: o.status, type: o.type, items: o.items, total: o.total }));
      return send(res, 200, mine);
    }
    return fail(res, 404, "Not found");
  }

  // Place order: POST /api/orders  (login required)
  if (pathname === "/api/orders" && method === "POST") {
    const user = getUser(req);
    if (!user) return fail(res, 401, "Please log in to place your order");

    const body = await readBody(req);
    const cart = getCart(req, res);
    const orderType = body.method === "pickup" ? "pickup" : "delivery";
    const summary = cartSummary(cart, orderType);

    const customer = {
      name: cleanStr(body.name, 80) || user.name,
      email: user.email,
      phone: cleanStr(body.phone, 30) || user.phone,
      address: orderType === "delivery" ? cleanStr(body.address, 300) : "",
    };
    const errors = [];
    if (summary.items.length === 0) errors.push("Your cart is empty");
    if (!customer.name) errors.push("Name is required");
    if (!PHONE_RE.test(customer.phone)) errors.push("A valid phone number is required");
    if (orderType === "delivery" && !customer.address) errors.push("Delivery address is required");
    if (errors.length) return send(res, 400, { error: errors.join(". "), errors });

    const order = {
      id: crypto.randomUUID(),
      orderNo: "HM-" + db.nextOrderNo++,
      userId: user.id,
      createdAt: new Date().toISOString(),
      status: "new",
      type: orderType,
      payment: ["Cash on delivery", "GCash", "Card"].includes(body.payment) ? body.payment : "Cash on delivery",
      notes: cleanStr(body.notes, 300),
      customer,
      items: summary.items,
      subtotal: summary.subtotal,
      delivery: summary.delivery,
      total: summary.total,
    };
    db.orders.push(order);
    // Remember the latest delivery address for next time
    if (customer.address) user.address = customer.address;
    cart.items = {}; cart.updatedAt = Date.now();
    pruneCarts(); saveDb();
    log(`New order ${order.orderNo} — ₱${order.total} — ${customer.name} <${user.email}>`);
    return send(res, 201, { orderNo: order.orderNo, total: order.total, status: order.status, id: order.id });
  }

  // Order status lookup (owner only): GET /api/orders/:id
  if ((m = pathname.match(/^\/api\/orders\/([\w-]+)$/)) && method === "GET") {
    const user = getUser(req);
    const o = db.orders.find(x => x.id === m[1]);
    if (!o || !user || o.userId !== user.id) return fail(res, 404, "Order not found");
    return send(res, 200, { orderNo: o.orderNo, status: o.status, total: o.total, createdAt: o.createdAt });
  }

  // ---- Admin (requires header x-admin-key) ----
  if (pathname === "/api/admin/orders" && method === "GET") {
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");
    const status = url.searchParams.get("status");
    const list = db.orders.filter(o => !status || o.status === status).slice().reverse();
    return send(res, 200, list);
  }
  if ((m = pathname.match(/^\/api\/admin\/orders\/([\w-]+)$/)) && method === "PATCH") {
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");
    const o = db.orders.find(x => x.id === m[1]);
    if (!o) return fail(res, 404, "Order not found");
    const { status } = await readBody(req);
    if (!ORDER_STATUSES.includes(status)) return fail(res, 400, "Invalid status");
    o.status = status; o.updatedAt = new Date().toISOString(); saveDb();
    return send(res, 200, o);
  }

  // Users list: GET /api/admin/users
  if (pathname === "/api/admin/users" && method === "GET") {
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");
    const list = db.users.slice().reverse().map(u => {
      const orders = db.orders.filter(o => o.userId === u.id && o.status !== "cancelled");
      return {
        ...publicUser(u),
        disabled: !!u.disabled,
        orderCount: orders.length,
        totalSpent: orders.reduce((s, o) => s + o.total, 0),
        lastOrderAt: orders.length ? orders[orders.length - 1].createdAt : null,
      };
    });
    return send(res, 200, list);
  }
  // Enable/disable a user: PATCH /api/admin/users/:id { disabled: true|false }
  if ((m = pathname.match(/^\/api\/admin\/users\/([\w-]+)$/)) && method === "PATCH") {
    if (!isAdmin(req)) return fail(res, 401, "Unauthorized");
    const u = db.users.find(x => x.id === m[1]);
    if (!u) return fail(res, 404, "User not found");
    const { disabled } = await readBody(req);
    if (typeof disabled !== "boolean") return fail(res, 400, "disabled must be true or false");
    u.disabled = disabled;
    if (disabled) endSessionsFor(u.id); // kick them out immediately
    saveDb();
    return send(res, 200, { ...publicUser(u), disabled: u.disabled });
  }

  return fail(res, 404, "Not found");
}

// ---------- Request runner ----------
// Collects the response in memory so a request can be re-run if another server
// instance saved data at the same moment (optimistic locking).
class BufferedResponse {
  constructor(req) { this.req = req; this.statusCode = 200; this.headers = {}; this.body = ""; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  getHeader(k) { return this.headers[k.toLowerCase()]; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); }
  end(body = "") { this.body = body; }
}

// One request at a time per server instance; across instances the store's
// compare-and-set save detects conflicts and the request is retried.
let queue = Promise.resolve();
const exclusive = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

function createHandler(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    // Vercel rewrite passes the original path as ?__p=cart/items/3
    if (url.searchParams.has("__p")) {
      url.pathname = "/api/" + url.searchParams.get("__p");
      url.searchParams.delete("__p");
    }
    const out = await exclusive(async () => {
      try { req.rawBody = await readRawBody(req); }
      catch { return Object.assign(new BufferedResponse(req), { statusCode: 413, body: JSON.stringify({ error: "Request too large" }), headers: { "content-type": "application/json; charset=utf-8" } }); }

      const MAX_ATTEMPTS = 12;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { data, version } = await store.load();
        db = normalize(data);
        dirty = false;
        pendingLogs = [];
        const buf = new BufferedResponse(req);
        try {
          await handleApi(req, buf, url);
        } catch (e) {
          if (e.message === "bad_json") fail(buf, 400, "Invalid JSON");
          else if (e.message === "too_large") fail(buf, 413, "Request too large");
          else { console.error(e); fail(buf, 500, "Server error"); }
          return buf; // don't save half-finished changes
        }
        if (!dirty) return buf;
        if (Math.random() < 0.05) pruneCarts();
        if (await store.save(db, version)) { pendingLogs.forEach(m => console.log(m)); return buf; }
        // Conflict: another instance saved first. Wait a random, growing delay and re-run.
        await new Promise(r => setTimeout(r, Math.random() * 25 * 2 ** Math.min(attempt, 6)));
      }
      return Object.assign(new BufferedResponse(req), { statusCode: 503, body: JSON.stringify({ error: "The shop is busy, please try again." }), headers: { "content-type": "application/json; charset=utf-8" } });
    });
    res.statusCode = out.statusCode;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.setHeader("Cache-Control", "no-store");
    res.end(out.body);
  };
}

async function countUsers(store) {
  const { data } = await store.load();
  return normalize(data).users.length;
}

module.exports = { createHandler, countUsers, APP_VERSION, ADMIN_KEY, ADMIN_KEY_OK, IS_PROD };
