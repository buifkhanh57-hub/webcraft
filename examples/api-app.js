/**
 * @file examples/api-app.js
 *
 * Example JSON API built with webcraft. Demonstrates:
 * - request logging, CORS and compression middleware
 * - schema validation for create/update payloads
 * - token-bucket rate limiting on the login route
 * - 404 / error handling, graceful shutdown
 *
 * Run:
 *   node examples/api-app.js            # listens on :3000
 *   PORT=4000 node examples/api-app.js  # custom port
 *
 * Try:
 *   curl -s localhost:3000/health
 *   curl -s localhost:3000/api/users
 *   curl -s -X POST localhost:3000/api/users -H 'content-type: application/json' \
 *        -d '{"name":"Ada Lovelace","email":"ada@example.com","age":36}'
 *   curl -s -X POST localhost:3000/api/login -d '{"username":"ada","password":"secret"}'
 */

import process from 'node:process';
import { createApp } from '../lib/webcraft.js';
import { requestLogger } from '../lib/logger.js';
import { cors } from '../lib/cors.js';
import { compress } from '../lib/compress.js';
import { rateLimit } from '../lib/ratelimit.js';
import { Schema, validate } from '../lib/validation.js';
import { NotFoundError } from '../lib/errors.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* In-memory data store                                                */
/* ------------------------------------------------------------------ */

/** @type {Array<{id: number, name: string, email: string, age: number|null, createdAt: string}>} */
const users = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', age: 36, createdAt: '2024-01-15T09:00:00.000Z' },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.com', age: 45, createdAt: '2024-02-20T12:30:00.000Z' },
  { id: 3, name: 'Alan Turing', email: 'alan@example.com', age: 41, createdAt: '2024-03-01T15:45:00.000Z' },
];
let nextId = 4;

/** Simple credential store for the login demo. */
const credentials = new Map([
  ['ada', 'compiler-pioneer'],
  ['grace', 'nanosecond'],
]);

/* ------------------------------------------------------------------ */
/* Validation schemas                                                  */
/* ------------------------------------------------------------------ */

const createUserSchema = new Schema({
  name: (f) => f.required().string().trim().length(2, 80),
  email: (f) => f.required().string().trim().lower().email(),
  age: (f) => f.number().min(13).max(120),
});

const updateUserSchema = new Schema({
  name: (f) => f.string().trim().length(2, 80),
  email: (f) => f.string().trim().lower().email(),
  age: (f) => f.number().min(13).max(120),
});

const paginationSchema = new Schema({
  page: (f) => f.number().min(1).default(1),
  limit: (f) => f.number().min(1).max(100).default(20),
}, );

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

const app = createApp({ env: process.env.NODE_ENV || 'development' });

// Middleware (order matters)
app.use(requestLogger(app.logger, { skip: (ctx) => ctx.req.path === '/health' }));
app.use(cors({ origin: true, credentials: false, maxAge: 86_400 }));
app.use(compress({ threshold: 512 }));

app.get('/health', (ctx) => {
  ctx.res.json({ status: 'ok', uptime: process.uptime(), users: users.length });
});

/**
 * GET /api/users — paginated list with optional ?q= filtering.
 */
app.get('/api/users', (ctx) => {
  const { page, limit } = paginationSchema.validateOrThrow(ctx.req.query);
  const q = typeof ctx.req.query.q === 'string' ? ctx.req.query.q.toLowerCase() : '';
  const filtered = q
    ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.includes(q))
    : users;
  const start = (page - 1) * limit;
  ctx.res.json({
    data: filtered.slice(start, start + limit),
    meta: {
      total: filtered.length,
      page,
      limit,
      pages: Math.max(1, Math.ceil(filtered.length / limit)),
    },
  });
});

/**
 * GET /api/users/:id — single user or 404.
 */
app.get('/api/users/:id', (ctx) => {
  const id = Number(ctx.params.id);
  const user = users.find((u) => u.id === id);
  if (!user) throw new NotFoundError(`User ${ctx.params.id} not found`);
  ctx.res.json({ data: user });
});

/**
 * POST /api/users — create with schema validation (422 on failure).
 */
app.post('/api/users', validate(createUserSchema), (ctx) => {
  if (users.some((u) => u.email === ctx.data.email)) {
    ctx.res.status(409).json({
      error: { code: 'CONFLICT', message: `Email ${ctx.data.email} is already registered` },
    });
    return;
  }
  const user = {
    id: nextId,
    name: ctx.data.name,
    email: ctx.data.email,
    age: ctx.data.age ?? null,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  nextId += 1;
  ctx.res.status(201).json({ data: user });
});

/**
 * PUT /api/users/:id — partial update.
 */
app.put('/api/users/:id', validate(updateUserSchema), (ctx) => {
  const id = Number(ctx.params.id);
  const user = users.find((u) => u.id === id);
  if (!user) throw new NotFoundError(`User ${ctx.params.id} not found`);
  if (ctx.data.name !== undefined) user.name = ctx.data.name;
  if (ctx.data.email !== undefined) user.email = ctx.data.email;
  if (ctx.data.age !== undefined) user.age = ctx.data.age;
  ctx.res.json({ data: user });
});

/**
 * DELETE /api/users/:id — remove a user.
 */
app.delete('/api/users/:id', (ctx) => {
  const id = Number(ctx.params.id);
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) throw new NotFoundError(`User ${ctx.params.id} not found`);
  const [removed] = users.splice(index, 1);
  ctx.res.json({ data: removed, deleted: true });
});

/**
 * POST /api/login — rate limited to 5 attempts per minute per IP.
 */
app.post(
  '/api/login',
  rateLimit({
    windowMs: 60_000,
    max: 5,
    message: 'Too many login attempts. Cool down and try again.',
  }),
  async (ctx) => {
    const body = await ctx.req.body();
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      ctx.res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'username and password are required strings' },
      });
      return;
    }
    const valid = credentials.get(username) === password;
    if (!valid) {
      ctx.res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid username or password' },
      });
      return;
    }
    ctx.res.json({ ok: true, token: `demo-token-for-${username}` });
  },
);

/**
 * POST /api/echo — introspect the parsed request (body type detection demo).
 */
app.post('/api/echo', async (ctx) => {
  const body = await ctx.req.body();
  const isMultipart = body && typeof body === 'object' && Array.isArray(body.files);
  ctx.res.json({
    method: ctx.req.method,
    contentType: ctx.req.contentType || null,
    bodyKind: isMultipart ? 'multipart' : Array.isArray(body) ? 'array' : typeof body,
    body,
  });
});

// Custom JSON 404 for unknown API paths
app.notFound((ctx) => {
  ctx.res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${ctx.req.method} ${ctx.req.path}`,
      hint: 'GET /health or /api/users are good starting points',
    },
  });
});

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const server = await app.listen(PORT, HOST);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.logger.info(`Received ${signal}, shutting down…`);
    await server.close({ timeout: 5000 });
    process.exit(0);
  });
}

export default app;
