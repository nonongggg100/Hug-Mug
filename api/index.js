// Vercel serverless entry point. vercel.json routes every /api/* request here.
const { createHandler } = require("../lib/app");
const { pickStore } = require("../lib/store");

let handler = null;

module.exports = async (req, res) => {
  if (!handler) {
    const store = pickStore();
    if (!store) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({
        error: "Database not connected. Connect a Redis database to this Vercel project and enable its credentials for Production, then redeploy.",
      }));
    }
    handler = createHandler(store);
  }
  return handler(req, res);
};
