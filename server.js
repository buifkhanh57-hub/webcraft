/**
 * js-mini-api — a zero-dependency JSON REST API built with plain Node.js.
 * Start with: node server.js   (then curl http://localhost:3000/tasks)
 */

"use strict";

const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------- data store ---
const tasks = new Map();
function seed() {
  ["Learn Node.js", "Write tests", "Ship to production"].forEach((title, i) => {
    const id = crypto.randomUUID();
    tasks.set(id, {
      id,
      title,
      done: i === 2,
      createdAt: new Date().toISOString(),
    });
  });
}

// ------------------------------------------------------------- helpers ------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const log = (method, path, status, ms) =>
  console.log(`[${new Date().toISOString()}] ${method} ${path} -> ${status} (${ms}ms)`);

// ------------------------------------------------------------- routes -------
const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$"
  );
  routes.push({ method, regex, keys, handler });
}

route("GET", "/health", async (req, res) => sendJson(res, 200, { status: "ok", uptime: process.uptime() }));

route("GET", "/tasks", async (req, res) => {
  const all = Array.from(tasks.values());
  sendJson(res, 200, { count: all.length, items: all });
});

route("GET", "/tasks/:id", async (req, res, params) => {
  const task = tasks.get(params.id);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  sendJson(res, 200, task);
});

route("POST", "/tasks", async (req, res) => {
  const body = await readBody(req);
  if (!body.title || typeof body.title !== "string") {
    return sendJson(res, 400, { error: "'title' is required" });
  }
  const id = crypto.randomUUID();
  const task = {
    id,
    title: body.title.trim(),
    done: Boolean(body.done),
    createdAt: new Date().toISOString(),
  };
  tasks.set(id, task);
  sendJson(res, 201, task);
});

route("PUT", "/tasks/:id", async (req, res, params) => {
  const task = tasks.get(params.id);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  const body = await readBody(req);
  if (typeof body.title === "string") task.title = body.title.trim();
  if (typeof body.done === "boolean") task.done = body.done;
  tasks.set(params.id, task);
  sendJson(res, 200, task);
});

route("DELETE", "/tasks/:id", async (req, res, params) => {
  if (!tasks.delete(params.id)) return sendJson(res, 404, { error: "task not found" });
  sendJson(res, 204, {});
});

// ------------------------------------------------------------- server -------
const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = path.match(r.regex);
    if (!match) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));
    try {
      await r.handler(req, res, params);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    log(req.method, path, res.statusCode, Number(process.hrtime.bigint() - started) / 1e6);
    return;
  }
  sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
  log(req.method, path, 404, Number(process.hrtime.bigint() - started) / 1e6);
});

server.listen(PORT, () => {
  seed();
  console.log(`js-mini-api listening on http://localhost:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  });
}
