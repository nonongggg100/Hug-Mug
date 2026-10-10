# Hog & Mug — Ordering Website

## Run it

Requires Node.js 18 or newer. No packages to install.

```bash
cd hog-and-mug
ADMIN_KEY=your-secret node server.js
```

- Shop: http://localhost:3000
- Admin orders page: http://localhost:3000/admin.html (log in with your `ADMIN_KEY`)

On Windows PowerShell: `$env:ADMIN_KEY="your-secret"; node server.js`

Orders and carts are saved in `data/db.json` (created automatically).

## Files

| File | Purpose |
|---|---|
| `server.js` | Local server (`node server.js`): serves `public/` and the API |
| `lib/app.js` | The app: cart, accounts, orders and admin API (shared by local and Vercel) |
| `lib/store.js` | Storage: JSON file locally, Upstash Redis on Vercel |
| `api/index.js` | Vercel serverless entry point |
| `vercel.json` | Vercel settings (static files from `public/`, API routing) |
| `public/index.html` | Customer front page (menu, cart, checkout) |
| `public/admin.html` | Staff page to view orders and change their status |
| `data/db.json` | Local data store (auto-created, not committed) |

## API

Each browser gets its own cart through a `cart_id` cookie. Prices and totals are always calculated on the server.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| GET | `/api/menu` | | List menu items |
| GET | `/api/cart?method=delivery\|pickup` | | Current cart with subtotal, delivery fee and total |
| POST | `/api/cart/items` | `{ "id": 11, "qty": 1 }` | Add an item to the cart |
| PATCH | `/api/cart/items/:id` | `{ "qty": 3 }` | Set quantity (0 removes) |
| DELETE | `/api/cart/items/:id` | | Remove an item |
| DELETE | `/api/cart` | | Empty the cart |
| POST | `/api/auth/register` | `{ name, email, phone, password }` | Create an account (password min 8 chars) and log in |
| POST | `/api/auth/login` | `{ email, password }` | Log in |
| POST | `/api/auth/logout` | | Log out |
| GET | `/api/auth/me` | | Current logged-in user, or `null` |
| PATCH | `/api/account` | `{ name, phone, address }` | Update my details (login required) |
| POST | `/api/account/password` | `{ currentPassword, newPassword }` | Change password (login required) |
| GET | `/api/account/orders` | | My order history (login required) |
| POST | `/api/orders` | `{ name, phone, method, address, payment, notes }` | Place an order from the cart (**login required**) |
| GET | `/api/orders/:id` | | Order status (owner only) |
| GET | `/api/admin/orders?status=new` | header `x-admin-key` | List orders (newest first) |
| PATCH | `/api/admin/orders/:id` | `{ "status": "preparing" }` + header `x-admin-key` | Update status |
| GET | `/api/admin/users` | header `x-admin-key` | List users with order count and total spent |
| PATCH | `/api/admin/users/:id` | `{ "disabled": true }` + header `x-admin-key` | Disable or re-enable a user |

## User accounts

- Guests can browse and fill the cart. Pressing **Checkout** asks them to log in or sign up, then continues straight to checkout with their details pre-filled.
- Header account menu: **My account** (edit details, change password), **My orders** (history and status), **Log out**.
- Passwords are hashed with scrypt and never stored in plain text. Logins stay active for 30 days (HttpOnly cookie).
- After 10 failed logins for the same email, further attempts are blocked for 15 minutes.
- Admin page → **Users** tab: search customers and see their orders and total spent. Disabling an account logs that customer out immediately and blocks new orders.

Statuses: `new`, `preparing`, `out_for_delivery`, `ready_for_pickup`, `completed`, `cancelled`.

## Settings

Edit the constants at the top of `lib/app.js`:

- `MENU`: items and prices
- `DELIVERY_FEE` (₱49) and `FREE_DELIVERY_OVER` (₱500)
- `PORT` env var (default 3000)

## Troubleshooting

- **"Load failed" / "Can't reach the server"**: make sure `node server.js` is running and you opened http://localhost:3000. Don't use VS Code "Live Server" or open `index.html` directly, because the API only exists on the Node server.
- After editing `server.js` or `lib/`, restart it (Ctrl + C, then run it again). If you use `nodemon`, the included `nodemon.json` stops it from restarting every time an order is saved.

## Deploy to Vercel

Vercel can't keep files between requests, so on Vercel the orders and accounts are stored in Redis instead of `data/db.json`. The app supports Upstash REST credentials and Vercel Redis's `REDIS_URL`. Locally, `node server.js` keeps using the JSON file.

### 1. Put the code on GitHub

In VS Code: open the `hog-and-mug` folder → **Source Control** (left sidebar) → **Publish to GitHub** → choose **Private** (recommended).

`.gitignore` keeps `data/` (customer accounts and orders) out of GitHub.

### 2. Import the project into Vercel

1. Sign in at https://vercel.com with your GitHub account.
2. **Add New… → Project**, then **Import** the `hog-and-mug` repo.
3. Leave **Framework Preset** as **Other** and leave the build settings empty (`vercel.json` already sets them).
4. Open **Environment Variables** and add `ADMIN_KEY` with a long secret (12+ characters). This is your admin page password.
5. Click **Deploy**. The site will load, but sign-up and orders won't work until step 3.

### 3. Add the database

1. In the project, open the **Storage** tab and create or connect a Redis database.
2. Connect it to this project for the **Production** environment. Vercel Redis provides `REDIS_URL`; Upstash REST connections provide `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Go to **Deployments**, open the **⋯** menu on the latest one → **Redeploy**.

### 4. Check it works

- Open `https://YOUR-PROJECT.vercel.app` → **Sign up** → add items → **Checkout** → place an order.
- Open `https://YOUR-PROJECT.vercel.app/admin.html` and log in with your `ADMIN_KEY` to see the order and the user.
- If something fails, open the project → **Logs** in Vercel to see the server error.

Every `git push` to `main` (VS Code: **Commit** then **Sync Changes**) redeploys automatically.

### Alternative: deploy from the terminal

```bash
npm install -g vercel
cd hog-and-mug
vercel            # first time: log in, link the project, creates a preview
vercel --prod     # publish to your production URL
```

Then do step 3 (database) and add `ADMIN_KEY` in the dashboard, and run `vercel --prod` again.

### Settings

| Variable | Where | Purpose |
|---|---|---|
| `ADMIN_KEY` | Vercel → Settings → Environment Variables | Admin page password, 12+ characters. Admin is disabled without it. |
| `REDIS_URL` | Added by Vercel Redis when connected to the project | Redis database connection |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added by an Upstash REST integration | Redis database connection |

To test locally against the same Redis database, set its `REDIS_URL` (or both Upstash REST variables) and `ADMIN_KEY`, then run `node server.js`.

### How it works on Vercel

- `public/` is served as static files; `api/index.js` handles every `/api/*` request (see `vercel.json`).
- `lib/app.js` is the shared app; `lib/store.js` has the file and Redis storage.
- Several Vercel instances can run at once. Each save checks that nobody else saved in between; if they did, the request is re-run with fresh data, so simultaneous orders never overwrite each other.
- Login attempt limits are kept in memory per instance, so they're looser on Vercel than locally.
- All data is one Redis record. That suits a small shop; for thousands of orders, move to a database like Postgres.

## Before going live

- Replace the placeholder business name, address and phone in `public/index.html`.
- For high order volume, swap the JSON file for a database such as SQLite or PostgreSQL.
