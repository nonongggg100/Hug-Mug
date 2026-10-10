// Storage backends. Both expose:
//   load()               -> { data, version }
//   save(data, version)  -> true if saved, false if someone else saved first (caller retries)

const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

// ---------- Local JSON file (node server.js) ----------
class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.name = `file (${this.file})`;
  }
  async load() {
    try { return { data: JSON.parse(fs.readFileSync(this.file, "utf8")), version: null }; }
    catch { return { data: null, version: null }; }
  }
  async save(data) {
    // A single local process handles one request at a time, so no conflict check is needed
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace
    return true;
  }
}

// ---------- Upstash Redis over REST (Vercel) ----------
// Saves only if the version hasn't changed since load(), so simultaneous
// requests on different serverless instances can never overwrite each other.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[2]) or ''
if cur ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('INCR', KEYS[2])
return 1`;

class UpstashStore {
  constructor(url, token, prefix = "hogmug") {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.dataKey = `${prefix}:db`;
    this.versionKey = `${prefix}:version`;
    this.name = "Upstash Redis";
  }
  async call(pathname, body) {
    const res = await fetch(this.url + pathname, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Redis request failed (${res.status}): ${await res.text()}`);
    return res.json();
  }
  async load() {
    const [d, v] = await this.call("/pipeline", [["GET", this.dataKey], ["GET", this.versionKey]]);
    if (d.error || v.error) throw new Error("Redis error: " + (d.error || v.error));
    return { data: d.result ? JSON.parse(d.result) : null, version: v.result || "" };
  }
  async save(data, version) {
    const r = await this.call("/", ["EVAL", CAS_SCRIPT, "2", this.dataKey, this.versionKey, String(version ?? ""), JSON.stringify(data)]);
    if (r.error) throw new Error("Redis error: " + r.error);
    return Number(r.result) === 1;
  }
}

class RedisStore {
  constructor(url, prefix = "hogmug") {
    this.client = createClient({ url });
    this.client.on("error", err => console.error("Redis client error:", err.message));
    this.connection = null;
    this.dataKey = `${prefix}:db`;
    this.versionKey = `${prefix}:version`;
    this.name = "Redis";
  }
  async ensureConnected() {
    if (!this.connection) {
      this.connection = this.client.connect().catch(err => {
        this.connection = null;
        throw err;
      });
    }
    await this.connection;
  }
  async load() {
    await this.ensureConnected();
    const [data, version] = await Promise.all([
      this.client.get(this.dataKey),
      this.client.get(this.versionKey),
    ]);
    return { data: data ? JSON.parse(data) : null, version: version || "" };
  }
  async save(data, version) {
    await this.ensureConnected();
    const result = await this.client.eval(CAS_SCRIPT, {
      keys: [this.dataKey, this.versionKey],
      arguments: [String(version ?? ""), JSON.stringify(data)],
    });
    return Number(result) === 1;
  }
}

// Pick a store from environment variables.
// Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN
// (Upstash's own dashboard calls them UPSTASH_REDIS_REST_URL / _TOKEN).
function pickStore({ dataDir } = {}) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  if (process.env.REDIS_URL) return new RedisStore(process.env.REDIS_URL);
  if (process.env.VERCEL) return null; // no writable disk on Vercel: a database is required
  return new FileStore(dataDir || process.env.DATA_DIR || path.join(__dirname, "..", "data"));
}

module.exports = { FileStore, UpstashStore, RedisStore, pickStore };
