/**
 * Middleware pipeline, mounting and error-handling tests over real servers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, withServer } from './helpers.js';
import { compose, Pipeline, mount, branch } from '../lib/middleware.js';
import { HttpError, UnauthorizedError, NotFoundError, createHttpError, isHttpError } from '../lib/errors.js';

test('compose() runs middleware in registration order, both directions', async () => {
  const order = [];
  const mw = (label) => async (_ctx, next) => { order.push(`${label}>`); await next(); order.push(`<${label}`); };
  await compose([mw('a'), mw('b')])({}, async () => { order.push('H'); });
  assert.deepEqual(order, ['a>', 'b>', 'H', '<b', '<a']);
});

test('compose() rejects when next() is called twice; non-functions are rejected', async () => {
  const double = compose([async (_ctx, next) => { await next(); await next(); }]);
  await assert.rejects(() => double({}, async () => {}), /multiple times/);
  assert.throws(() => compose(['nope']), TypeError);
});

test('Pipeline: use/prepend/useAll/clear/run', async () => {
  const pipeline = new Pipeline();
  const seen = [];
  pipeline.use(async (_ctx, next) => { seen.push(1); await next(); });
  pipeline.useAll(async (_ctx, next) => { seen.push(2); await next(); }, async (_ctx, next) => { seen.push(3); await next(); });
  pipeline.prepend(async (_ctx, next) => { seen.push(0); await next(); });
  assert.equal(pipeline.length, 4);
  await pipeline.run({}, null);
  assert.deepEqual(seen, [0, 1, 2, 3]);
  pipeline.clear();
  assert.equal(pipeline.length, 0);
  assert.throws(() => pipeline.use('x'), TypeError);
});

test('app-level middleware wraps route handlers on every request', async () => {
  const app = createApp();
  const seen = [];
  app.use(async (ctx, next) => { seen.push(ctx.req.path); await next(); });
  app.get('/tracked', (ctx) => ctx.res.text('ok'));
  await withServer(app, async ({ url }) => {
    await fetch(`${url}/tracked`);
    assert.deepEqual(seen, ['/tracked']);
  });
});

test('mount() delegates a sub-app under a prefix (paths are rewritten)', async () => {
  const api = createApp();
  api.get('/users', (ctx) => ctx.res.json({ mountPath: ctx.req.path }));
  api.get('/users/:id', (ctx) => ctx.res.json({ id: ctx.params.id }));

  const site = createApp();
  site.use(mount('/api', api));
  site.get('/top', (ctx) => ctx.res.text('top'));

  await withServer(site, async ({ url }) => {
    const list = await fetch(`${url}/api/users`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { mountPath: '/users' });

    const one = await fetch(`${url}/api/users/7`);
    assert.deepEqual(await one.json(), { id: '7' });

    assert.equal((await fetch(`${url}/top`)).status, 200);
    const outside = await fetch(`${url}/api/missing`);
    assert.equal(outside.status, 404);
  });
});

test('branch() picks a chain by predicate', async () => {
  const app = createApp();
  app.use(branch(
    (ctx) => ctx.req.path.startsWith('/secure'),
    async (ctx, next) => { ctx.state.flag = 'secure'; await next(); },
    async (ctx, next) => { ctx.state.flag = 'open'; await next(); },
  ));
  app.all('/*path', (ctx) => ctx.res.json(ctx.state));
  await withServer(app, async ({ url }) => {
    assert.deepEqual(await (await fetch(`${url}/secure/x`)).json(), { flag: 'secure' });
    assert.deepEqual(await (await fetch(`${url}/public`)).json(), { flag: 'open' });
  });
});

test('HttpError subclasses render JSON with codes and headers', async () => {
  const app = createApp();
  app.get('/teapot', () => { throw createHttpError(418, 'short and stout'); });
  app.get('/auth', () => { throw new UnauthorizedError('token required'); });
  app.get('/gone', () => { throw new NotFoundError('nothing here'); });
  await withServer(app, async ({ url }) => {
    const teapot = await fetch(`${url}/teapot`);
    assert.equal(teapot.status, 418);
    const payload = await teapot.json();
    assert.equal(payload.error.code, 'HTTP_418');
    assert.equal(payload.error.message, 'short and stout');

    const auth = await fetch(`${url}/auth`);
    assert.equal(auth.status, 401);
    assert.match(auth.headers.get('www-authenticate'), /Bearer/);

    assert.equal((await fetch(`${url}/gone`)).status, 404);
  });
});

test('500 errors hide internal messages from clients', async () => {
  const app = createApp({ env: 'production' });
  app.get('/boom', () => { throw new Error('super-secret internals'); });
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/boom`);
    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.message, 'Internal Server Error');
    assert.ok(!JSON.stringify(payload).includes('super-secret'));
  });
});

test('onError() hook sees the error and can customise the response', async () => {
  const app = createApp();
  const seen = [];
  app.onError((err, ctx) => {
    seen.push(err.status);
    ctx.res.status(err.status).text(`custom:${err.status}`);
  });
  app.get('/x', () => { throw new HttpError(507, 'no space'); });
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/x`);
    assert.equal(res.status, 507);
    assert.equal(await res.text(), 'custom:507');
    assert.deepEqual(seen, [507]);
  });
});

test('notFound() replaces the default 404 renderer', async () => {
  const app = createApp();
  app.notFound((ctx) => ctx.res.status(404).json({ mine: true, path: ctx.req.path }));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/nowhere`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { mine: true, path: '/nowhere' });
  });
});

test('isHttpError duck-types across instances; HttpError.from wraps unknowns', () => {
  assert.ok(isHttpError(new NotFoundError()));
  assert.ok(isHttpError({ isHttpError: true }));
  assert.equal(isHttpError(new Error('x')), false);
  const wrapped = HttpError.from(new Error('inner'));
  assert.equal(wrapped.status, 500);
  assert.equal(wrapped.expose, false);
  assert.equal(HttpError.from('plain string').message, 'plain string');
});

test('server survives malformed HTTP (clientError → 400, no crash)', async () => {
  const app = createApp();
  app.get('/', (ctx) => ctx.res.text('alive'));
  await withServer(app, async ({ url, server }) => {
    const net = await import('node:net');
    await new Promise((resolve) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => {
        socket.end('GARBAGE / HTTP/1.1\r\nBroken: yes\r\n\r\n');
      });
      // Read the server's 400 reply so the socket reaches its close event.
      socket.on('data', () => {});
      socket.on('close', resolve);
      socket.on('error', () => resolve());
    });
    const res = await fetch(`${url}/`);
    assert.equal(await res.text(), 'alive');
  });
});
