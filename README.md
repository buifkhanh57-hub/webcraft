# webcraft

> A zero-dependency web framework for Node.js — routing, middleware, sessions,
> templates, static files, validation and more, built entirely on the standard
> library.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)
![Type](https://img.shields.io/badge/modules-ESM-informational)
![Tests](https://img.shields.io/badge/tests-83%20passing-brightgreen)

---

## Overview

**webcraft** is a small, explicit web framework for people who want to understand
every line between the socket and the response. It has **zero runtime
dependencies**: everything — the router, the middleware compositor, body
parsing, cookies, signed sessions, the template engine, static file serving,
compression, CORS, rate limiting — is implemented directly on top of
`node:http`, `node:crypto`, `node:zlib` and friends.

It is written in plain modern **ESM JavaScript** (no TypeScript, no build step),
organised as ~16 focused modules, and ships with a CLI that can scaffold a new
application in seconds.

If you have ever wanted a framework shaped like Express or Koa but small enough
to read in an afternoon, webcraft is that.

## Features

- **Router** — `:params`, `*wildcards`, nested groups, named routes with URL
  building, 405 detection with `Allow` headers, case-insensitive matching.
- **Middleware** — Koa-style async `(ctx, next)` composition at app, group,
  route and mounted-sub-app level.
- **Request parsing** — JSON, urlencoded forms, multipart uploads (files held
  in memory), plain text and raw buffers, with configurable size limits.
- **Response helpers** — `json()`, `html()`, `text()`, `send()`, `redirect()`,
  `cookie()`, ETag/304 revalidation, HTTP range requests, file downloads and
  streaming.
- **Sessions** — HMAC-SHA256-signed cookie sessions with flash messages, no
  server-side storage required.
- **Template engine** — a tiny, eval-free engine with HTML escaping, raw
  output, conditionals, loops, partials and file loading.
- **Static files** — MIME detection for 120+ extensions, ETags,
  Cache-Control, range requests, dotfile protection and traversal guards.
- **Validation** — declarative, chainable schemas with coercion, nesting and
  structured 422 error payloads.
- **Production utilities** — gzip/deflate/brotli compression, CORS with
  preflight support, token-bucket rate limiting, colourised logging, an HTTP
  error hierarchy and graceful shutdown.
- **CLI** — `webcraft new` scaffolds a complete starter app; `webcraft routes`
  prints the route table of any app module.

## Requirements

| Requirement | Minimum                                   |
| ----------- | ----------------------------------------- |
| Node.js     | **18.0.0** (built and tested on Node 24)  |
| npm         | any version bundled with Node             |
| Language    | plain ESM JavaScript — nothing to compile |

There are **no runtime dependencies**. `npm install` completes instantly
because there is nothing to download.

## Installation

```bash
# From a published package
npm install webcraft

# Or from a local checkout of this repository
git clone https://github.com/buifkhanh57-hub/webcraft.git
cd webcraft
npm test        # run the test suite
```

## Quick Start

Create a file called `app.mjs`:

```js
import { createApp } from 'webcraft';

const app = createApp();

app.get('/', (ctx) => ctx.res.text('Hello, webcraft!'));

app.get('/users/:id', (ctx) => {
  ctx.res.json({ id: ctx.params.id, name: 'Ada Lovelace' });
});

app.post('/echo', async (ctx) => {
  const body = await ctx.req.body();
  ctx.res.json({ youSent: body });
});

const server = await app.listen(3000);
console.log(`Listening on ${server.url}`);
```

Run it and try it:

```bash
node app.mjs
curl -s localhost:3000/
curl -s localhost:3000/users/42
curl -s -X POST localhost:3000/echo \
     -H 'content-type: application/json' -d '{"hello":"world"}'
```

Or scaffold a full project (routes, views, static assets, README):

```bash
npx webcraft new my-site
cd my-site && npm install && npm start
```

## Usage

### Application

| Method                             | Description                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| `createApp(options)`               | Create an app. Options: `env`, `router`, `logger`, `maxBodySize`, `server`. |
| `app.use(fn)`                      | Register app-level middleware `(ctx, next) => Promise`.         |
| `app.get/post/put/patch/delete/head/options/all(pattern, ...handlers)` | Register routes; the last handler is terminal, earlier ones are route-scoped middleware. |
| `app.group(prefix, fn)`            | Nest routes under a prefix; groups nest arbitrarily deep.       |
| `app.static(root, opts)`           | Serve a directory as middleware.                                |
| `app.session(opts)`                | Enable signed cookie sessions (`secret` required).              |
| `app.engine(opts)`                 | Configure the template engine (`root`, `extension`, `cache`).   |
| `app.onError(fn)`                  | Global error hook `(error, ctx)`.                               |
| `app.notFound(fn)`                 | Custom 404 renderer.                                            |
| `app.url(name, params, query)`     | Build a URL from a named route.                                 |
| `app.describeRoutes()`             | Snapshot of the route table (used by the CLI).                  |
| `app.listen(port, host)`           | Start the server; resolves with `{ server, port, url, close }`. |
| `app.close(opts)`                  | Graceful shutdown with connection draining.                     |

### Router

| Feature            | Example                                    | Result                                  |
| ------------------ | ------------------------------------------ | --------------------------------------- |
| Param segment      | `/users/:id`                               | `ctx.params.id` — one path segment       |
| Wildcard           | `/files/*path`                             | `ctx.params.path` — rest of the path     |
| Route group        | `app.group('/api/v1', (api) => ...)`       | `/api/v1/users`                          |
| Named route        | `app.get('/posts/:id', h, { name: 'posts.show' })` | `app.url('posts.show', { id: 7 })` → `/posts/7` |
| Trailing slash     | `/users/42/`                               | Matches `/users/42`                      |
| Method fallback    | `HEAD` on a `GET` route                    | Handled by the GET handler (body stripped) |
| 405 detection      | `POST` on a GET-only route                 | `405` with `Allow: GET, HEAD`            |

### Context (`ctx`)

Every handler receives one context object:

| Property / Helper        | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `ctx.req`                | The wrapped request (see below).                                |
| `ctx.res`                | The wrapped response (see below).                               |
| `ctx.params`             | Route parameters for the current match.                         |
| `ctx.query`              | Parsed query string (`req.query` shortcut).                     |
| `ctx.state`              | Per-request scratch object for middleware.                      |
| `ctx.data`               | Cleaned values produced by validation middleware.               |
| `ctx.session`            | Session object when `app.session()` is enabled.                 |
| `ctx.set(name, value)`   | Set a response header.                                          |
| `ctx.status(code)`       | Set the response status.                                        |
| `ctx.json/html/text/send(data)` | Response body shortcuts.                                 |
| `ctx.redirect(url, status)` | 302 by default; 301/303/307/308 supported.                   |
| `ctx.render(name, data)` | Render a template (requires `app.engine()`).                    |

### Request helpers (`ctx.req`)

| Helper                     | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `req.path`, `req.query`    | Pathname and parsed query (repeated keys become arrays).           |
| `req.headers`, `req.get()` | Lowercased header access.                                          |
| `req.cookies`              | Parsed `Cookie` header.                                            |
| `req.body(options)`        | Parse by Content-Type: JSON, urlencoded, multipart, text or Buffer.|
| `req.json()` / `req.text()` / `req.form()` | Explicit body readers.                             |
| `req.is('json', ...)`      | Content-Type check with aliases (`json`, `html`, `form`, ...).     |
| `req.accepts('json', 'html')` | Content negotiation against the `Accept` header.                |
| `req.ip`, `req.protocol`, `req.hostname`, `req.secure` | Proxy-aware request metadata. |

### Response helpers (`ctx.res`)

| Helper                            | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `res.status(code)`                | Chainable status setter.                               |
| `res.set/get/has/append()`        | Header management.                                     |
| `res.json/html/text(data, status)`| Typed bodies with correct `Content-Type`.              |
| `res.send(body)`                  | Infers the type from the value.                        |
| `res.redirect(url, status)`       | Redirect with a small HTML fallback body.              |
| `res.cookie(name, value, opts)`   | Queue a `Set-Cookie` (maxAge, httpOnly, sameSite...).  |
| `res.clearCookie(name, opts)`     | Expire a cookie.                                       |
| `res.etag(body)`                  | Strong ETag + automatic `304` short-circuit.           |
| `res.sendFile(path, opts)`        | Stream a file with ETag, ranges and dotfile control.   |
| `res.download(path, filename)`    | `sendFile` with `Content-Disposition: attachment`.     |
| `res.stream(readable)`            | Pipe a stream to the response.                         |

### Validation rules

Schemas are built from chainable field definitions:

```js
import { Schema, validateBody } from 'webcraft';

const userSchema = new Schema({
  name:  (f) => f.required().string().trim().length(2, 80),
  email: (f) => f.required().string().lower().email(),
  age:   (f) => f.number().min(13).max(120),
  role:  (f) => f.oneOf(['user', 'admin']).default('user'),
});

app.post('/users', validateBody(userSchema), (ctx) => {
  ctx.res.status(201).json(ctx.data); // cleaned values, or a 422 with details
});
```

| Rule                         | Applies to            | Effect                                        |
| ---------------------------- | --------------------- | --------------------------------------------- |
| `required()` / `optional()`  | all                   | Presence check (empty strings count as missing) |
| `string()` / `number()` / `boolean()` | all          | Type enforcement with coercion from strings   |
| `object().fields({...})`     | objects               | Nested schema; errors are dot-pathed          |
| `array().items(fn\|spec)`    | arrays                | Per-element schema; errors are indexed        |
| `min(n)` / `max(n)`          | numbers, strings      | Value or length bounds                        |
| `length(min, max)`           | strings, arrays       | Exact range                                   |
| `email()` / `url()`          | strings               | Format checks                                 |
| `regex(pattern)`             | strings               | Custom pattern                                |
| `oneOf(values)`              | all                   | Whitelist                                     |
| `custom(fn)`                 | all                   | Return truthy, or `{ ok, message }`           |
| `default(value)`             | all                   | Applied when the field is missing             |
| `trim()` / `lower()` / `upper()` | strings           | Normalisation before rules run                |

Options: `{ coerce, stripUnknown, abortEarly }`; middleware helpers
`validateBody(schema)` and `validateQuery(schema)` put cleaned values in
`ctx.data` or throw a structured `422 ValidationError`.

### Template syntax

| Syntax                        | Meaning                                              |
| ----------------------------- | ---------------------------------------------------- |
| `{{ name }}`                  | Interpolated, HTML-escaped variable (dot paths OK)    |
| `{{{ html }}}`                | Raw, unescaped output                                 |
| `{{#if cond}}…{{else}}…{{/if}}` | Conditionals (`==`, `!=`, `>`, `<`, `and`, `or`, `!`) |
| `{{#each items}}…{{/each}}`   | Iteration with `this`, `@index`, `@key`, `@first`, `@last` |
| `{{> partial}}`               | Include a partial (inherits context)                  |
| `{{> partial ctx}}`           | Include a partial with a different root object        |
| `{{! comment }}`              | Comment — stripped from output                        |

Expressions are compiled to closures — there is **no `eval`** anywhere.

### Built-in middleware

| Middleware                  | Import                          | Purpose                                     |
| --------------------------- | ------------------------------- | ------------------------------------------- |
| `session(options)`          | `lib/session.js`                | Signed cookie sessions + flash messages     |
| `createStatic(root, opts)`  | `lib/static.js`                 | Static file serving                         |
| `cors(options)`             | `lib/cors.js`                   | CORS with preflight handling                |
| `compress(options)`         | `lib/compress.js`               | gzip / deflate / brotli response compression|
| `rateLimit(options)`        | `lib/ratelimit.js`              | Token-bucket rate limiting (429 + headers)  |
| `requestLogger(logger)`     | `lib/logger.js`                 | Request timing/status logging               |
| `mount(prefix, target)`     | `lib/middleware.js`             | Mount a sub-app or middleware under a prefix|
| `branch(pred, a, b)`        | `lib/middleware.js`             | Conditional middleware chains               |

## Configuration

```js
const app = createApp({
  env: 'production',          // 'development' | 'production' | 'test'
  maxBodySize: 1_048_576,     // default body limit in bytes (1 MiB)
  server: {                   // passed to the HTTP server
    requestTimeout: 30_000,
    headersTimeout: 35_000,
    keepAliveTimeout: 5_000,
  },
});

app.session({
  secret: process.env.SESSION_SECRET, // required
  key: 'wc.sid',                      // cookie name
  maxAge: 86_400_000,                 // session lifetime (ms)
  cookie: { httpOnly: true, sameSite: 'Lax', secure: false },
});

app.engine({ root: 'views', extension: '.html', cache: true });

app.static('./public', { maxAge: 86_400, extensions: ['html'] });
```

In `development` the error pages include stack traces and the logger runs at
`debug`; in `production`, 5xx messages are hidden from clients and logs run at
`info`.

## Project Structure

```
webcraft/
├── package.json               # ESM ("type": "module"), zero dependencies
├── LICENSE                    # MIT
├── README.md
├── cli.js                     # `webcraft new` scaffolder + `webcraft routes`
├── lib/                       # the framework (one module per concern)
│   ├── webcraft.js            # createApp(): composes everything into one object
│   ├── router.js              # patterns, params, groups, named routes, 405s
│   ├── middleware.js          # compose(), Pipeline, mount(), branch()
│   ├── request.js             # URL/query/cookie/body parsing (incl. multipart)
│   ├── response.js            # body helpers, cookies, ETag, ranges, sendFile
│   ├── server.js              # server factory, timeouts, graceful shutdown
│   ├── errors.js              # HttpError hierarchy (400…503) with JSON bodies
│   ├── cookies.js             # RFC 6265 parse/serialize
│   ├── session.js             # HMAC-signed cookie sessions + flash
│   ├── template.js            # eval-free template engine (if/each/partials)
│   ├── static.js              # static middleware + 120+ MIME types
│   ├── validation.js          # Schema/FieldSchema + validate*() middleware
│   ├── compress.js            # gzip/deflate/brotli middleware
│   ├── cors.js                # CORS middleware
│   ├── ratelimit.js           # token buckets + rateLimit() middleware
│   └── logger.js              # levelled logger + requestLogger()
├── examples/
│   ├── api-app.js             # JSON API: validation, CORS, compression, 429s
│   ├── blog-app.js            # blog: templates, sessions, static assets
│   ├── views/                 # templates for the blog example
│   │   ├── layout.html
│   │   ├── home.html
│   │   ├── post.html
│   │   ├── login.html
│   │   └── admin.html
│   └── public/css/blog.css    # stylesheet served at /assets/css/blog.css
└── tests/                     # node:test suite — real servers, real fetch
    ├── helpers.js             # ephemeral-port bootstrap + raw HTTP client
    ├── router.test.js
    ├── body.test.js
    ├── static.test.js
    ├── template.test.js
    ├── session.test.js
    ├── validation.test.js
    ├── middleware.test.js
    ├── security.test.js       # CORS, compression, rate limiting
    └── cli.test.js            # scaffolding + `routes` command
```

## Architecture

Every request flows through the same small pipeline:

```
node:http Server (lib/server.js)
      │  timeouts, clientError → 400, graceful shutdown
      ▼
app.handleRequest(req, res)                    (lib/webcraft.js)
      │  builds ctx { req, res, params, state, session, data }
      ▼
Pipeline.run(ctx, dispatch)                    (lib/middleware.js)
      │  app-level middleware in registration order:
      │  logger → cors → compress → session → static → mounted sub-apps …
      ▼
dispatch(ctx)                                  (lib/webcraft.js)
      │  router.find(method, path) → { route, params } | 405 | 404
      ▼
[route middleware …] → route.handler(ctx)      (lib/router.js)
      │  handlers call ctx.res.json/html/… which end the response
      ▼
error path (on the way back up)
      │  anything thrown becomes an HttpError → JSON or HTML error page
      ▼
res.end() → session cookie commit → socket drain → close
```

Design rules that keep this honest:

- **One context per request.** Middleware share `ctx.state`; handlers read
  `ctx.params`, `ctx.query`, `ctx.session` and `ctx.data`.
- **Errors are control flow.** Handlers `throw new NotFoundError(...)`; the
  framework converts it into the right JSON or HTML representation, honouring
  `Accept` and the environment.
- **Nothing is cached by accident.** Route patterns, template ASTs and
  expression resolvers are compiled once; bodies are read once (`req.body()`
  caches its buffer).
- **Shutdown is explicit.** `app.close()` stops accepting connections, drains
  in-flight requests and force-closes stragglers after a timeout.

## Testing

The suite uses the built-in `node:test` runner. Every HTTP test starts a real
server on an **ephemeral port** (`app.listen(0)`) and talks to it with `fetch`
or a raw `node:http` client — no mocks.

```bash
npm test          # node --test "tests/*.test.js"
node --test tests/router.test.js   # a single file
```

| File                    | Covers                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `router.test.js`        | params, wildcards, groups, 404/405, HEAD, redirects, helpers |
| `body.test.js`          | JSON, urlencoded, multipart, size limits, cookies            |
| `static.test.js`        | MIME, indexes, ETag/304, ranges, dotfiles, traversal         |
| `template.test.js`      | escaping, if/each, partials, file templates, errors          |
| `session.test.js`       | login/logout round-trips, tampering, expiry, flash           |
| `validation.test.js`    | every rule, coercion, nesting, 422 payloads                  |
| `middleware.test.js`    | compose order, mount, branch, error hooks, malformed HTTP    |
| `security.test.js`      | CORS preflights, gzip output, rate limiting                  |
| `cli.test.js`           | `new` scaffolding, `--force`, `routes` inspector             |

83 tests pass in about four seconds on Node 24.

## FAQ

**Why zero dependencies?**
Fewer moving parts: no supply-chain risk, instant installs, and code you can
read end-to-end in one sitting. Everything needed ships with Node itself.

**Is it production-ready?**
It implements the hard parts correctly (signed sessions, ETag revalidation,
range requests, graceful shutdown, hidden 5xx messages), but it is a young
framework. Read the source — that is the point.

**Can I use it with TypeScript?**
Yes — the modules are plain ESM; add your own `.d.ts` or use JSDoc types.

**How do sessions survive restarts?**
They do not — the payload lives in the client cookie. Anything sensitive or
large belongs in a server-side store.

**How large can uploads be?**
Multipart files are held in memory. Tune `maxBodySize` (default 1 MiB) and use
`req.body({ limit })` for finer control.

**How do I deploy it?**
`app.listen(port, host)` is a normal Node server — put it behind any reverse
proxy, or let it terminate traffic directly. `X-Forwarded-*` headers are
honoured for `ip`, `protocol` and `hostname`.

## Roadmap

- [ ] Route-level `HEAD`/`OPTIONS` auto-generation polish
- [ ] Streaming multipart parsing for large uploads
- [ ] Optional server-side session stores (memory + signed-cookie fallback)
- [ ] Built-in CSP/security-headers middleware
- [ ] HTML minification for template output
- [ ] TypeScript type definitions
- [ ] Benchmark suite against Express/Fastify baselines

## License

MIT — see [LICENSE](./LICENSE).

---
**by Bui Bao Khanh**
