/**
 * Router + application core tests. Every case runs against a real HTTP
 * server on an ephemeral port and uses fetch (or the raw client where the
 * URL would otherwise be normalised).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, withServer, rawRequest } from './helpers.js';
import { Router, compilePath, normalizePath } from '../lib/router.js';

test('GET route responds with text, json and html helpers', async () => {
  const app = createApp();
  app.get('/text', (ctx) => ctx.res.text('plain text'));
  app.get('/json', (ctx) => ctx.res.json({ ok: true, n: 42 }));
  app.get('/html', (ctx) => ctx.res.html('<p>hi</p>'));
  await withServer(app, async ({ url }) => {
    const text = await fetch(`${url}/text`);
    assert.equal(text.status, 200);
    assert.equal(await text.text(), 'plain text');
    assert.match(text.headers.get('content-type'), /text\/plain/);

    const json = await fetch(`${url}/json`);
    assert.deepEqual(await json.json(), { ok: true, n: 42 });
    assert.match(json.headers.get('content-type'), /application\/json/);

    const html = await fetch(`${url}/html`);
    assert.equal(await html.text(), '<p>hi</p>');
    assert.match(html.headers.get('content-type'), /text\/html/);
  });
});

test('route params, percent decoding and wildcards', async () => {
  const app = createApp();
  app.get('/users/:id', (ctx) => ctx.res.json({ id: ctx.params.id }));
  app.get('/hello/:name', (ctx) => ctx.res.json({ name: ctx.params.name }));
  app.get('/files/*path', (ctx) => ctx.res.json({ path: ctx.params.path }));
  await withServer(app, async ({ url }) => {
    assert.deepEqual(await (await fetch(`${url}/users/42`)).json(), { id: '42' });
    // percent-encoded segment is decoded
    assert.deepEqual(await (await fetch(`${url}/hello/J%C3%BCrgen`)).json(), { name: 'Jürgen' });
    // wildcard spans multiple segments and is decoded
    assert.deepEqual(await (await fetch(`${url}/files/docs/2024/a%20b.txt`)).json(), { path: 'docs/2024/a b.txt' });
    // trailing slash is tolerated
    const slashed = await fetch(`${url}/users/7/`);
    assert.equal(slashed.status, 200);
    assert.deepEqual(await slashed.json(), { id: '7' });
  });
});

test('unknown route → 404 (JSON for fetch, HTML for browsers)', async () => {
  const app = createApp();
  await withServer(app, async ({ url }) => {
    const jsonRes = await fetch(`${url}/definitely-missing`);
    assert.equal(jsonRes.status, 404);
    const payload = await jsonRes.json();
    assert.equal(payload.error.status, 404);
    assert.equal(payload.error.code, 'NOT_FOUND');

    const htmlRes = await fetch(`${url}/definitely-missing`, { headers: { accept: 'text/html' } });
    assert.equal(htmlRes.status, 404);
    assert.match(await htmlRes.text(), /<html/);
  });
});

test('method mismatch → 405 with Allow header; HEAD is served by GET handlers', async () => {
  const app = createApp();
  app.get('/only-get', (ctx) => ctx.res.text('resource'));
  await withServer(app, async ({ url }) => {
    const post = await fetch(`${url}/only-get`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');

    const head = await fetch(`${url}/only-get`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), ''); // HEAD responses never carry a body
  });
});

test('route groups, named routes and URL building', async () => {
  const app = createApp();
  app.get('/', (ctx) => ctx.res.text('home'));
  app.group('/api/v1', (api) => {
    api.get('/users/:id', (ctx) => ctx.res.json({ id: ctx.params.id }), { name: 'api.users.show' });
    api.group('/admin', (admin) => {
      admin.get('/stats', (ctx) => ctx.res.text('stats'), { name: 'api.admin.stats' });
    });
  });
  assert.equal(app.url('api.users.show', { id: 9 }, { full: '1' }), '/api/v1/users/9?full=1');
  assert.equal(app.url('api.admin.stats'), '/api/v1/admin/stats');
  await withServer(app, async ({ url }) => {
    assert.equal((await fetch(`${url}/api/v1/users/9`)).status, 200);
    assert.equal((await fetch(`${url}/api/v1/admin/stats`)).status, 200);
    assert.equal((await (await fetch(`${url}/api/v1/admin/stats`)).text()), 'stats');
  });
});

test('duplicate route names are rejected', () => {
  const router = new Router();
  router.get('/a', () => {}, { name: 'same' });
  assert.throws(() => router.get('/b', () => {}, { name: 'same' }), /already registered/);
});

test('app.all matches every method; route-scoped middleware runs in order', async () => {
  const app = createApp();
  const calls = [];
  app.all('/any', (ctx, next) => { calls.push('mw'); return next(); }, (ctx) => {
    calls.push('handler');
    return ctx.res.json({ method: ctx.req.method });
  });
  await withServer(app, async ({ url }) => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      calls.length = 0;
      const res = await fetch(`${url}/any`, { method });
      assert.deepEqual(await res.json(), { method });
      assert.deepEqual(calls, ['mw', 'handler']);
    }
  });
});

test('query parsing: repeated keys become arrays', async () => {
  const app = createApp();
  app.get('/search', (ctx) => ctx.res.json(ctx.req.query));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/search?tag=a&tag=b&q=hello+world`);
    assert.deepEqual(await res.json(), { tag: ['a', 'b'], q: 'hello world' });
  });
});

test('request helpers: ip, hostname, is(), accepts(), header access', async () => {
  const app = createApp();
  app.get('/who', (ctx) => {
    ctx.res.json({
      ip: ctx.req.ip,
      hostname: ctx.req.hostname,
      protocol: ctx.req.protocol,
      secure: ctx.req.secure,
      isJson: ctx.req.is('json'),
      acceptsJson: ctx.req.accepts('html', 'json') === 'json',
      contentType: ctx.req.get('content-type') || null,
    });
  });
  await withServer(app, async ({ url, port }) => {
    const res = await fetch(`${url}/who`, {
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
    });
    const body = await res.json();
    assert.equal(body.ip, '10.0.0.1');
    assert.equal(body.hostname, `127.0.0.1:${port}`);
    assert.equal(body.protocol, 'http');
    assert.equal(body.secure, false);
    assert.equal(body.isJson, 'json');
    assert.equal(body.acceptsJson, true);
    assert.equal(body.contentType, 'application/json');
  });
});

test('redirect helper issues 302 with Location', async () => {
  const app = createApp();
  app.get('/old', (ctx) => ctx.redirect('/new'));
  app.get('/moved', (ctx) => ctx.redirect('/new', 301));
  app.get('/new', (ctx) => ctx.res.text('new'));
  await withServer(app, async ({ url }) => {
    const r302 = await fetch(`${url}/old`, { redirect: 'manual' });
    assert.equal(r302.status, 302);
    assert.equal(r302.headers.get('location'), '/new');
    const r301 = await fetch(`${url}/moved`, { redirect: 'manual' });
    assert.equal(r301.status, 301);
  });
});

test('send() infers the body type; set()/status() manage headers', async () => {
  const app = createApp();
  app.get('/obj', (ctx) => ctx.res.send({ a: 1 }));
  app.get('/buf', (ctx) => ctx.res.send(Buffer.from([1, 2, 3])));
  app.get('/num', (ctx) => ctx.res.send(201));
  app.get('/headers', (ctx) => ctx.res.set('X-Custom', 'yes').status(202).text('accepted'));
  await withServer(app, async ({ url }) => {
    assert.deepEqual(await (await fetch(`${url}/obj`)).json(), { a: 1 });
    const buf = await fetch(`${url}/buf`);
    assert.match(buf.headers.get('content-type'), /octet-stream/);
    assert.equal(new Uint8Array(await buf.arrayBuffer())[0], 1);
    const num = await fetch(`${url}/num`);
    assert.equal(num.status, 201);
    const headers = await fetch(`${url}/headers`);
    assert.equal(headers.status, 202);
    assert.equal(headers.headers.get('x-custom'), 'yes');
  });
});

test('HEAD via raw client keeps status and headers without body', async () => {
  const app = createApp();
  app.get('/hello', (ctx) => ctx.res.text('hello world'));
  await withServer(app, async ({ url }) => {
    const res = await rawRequest(`${url}/hello`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.match(res.headers['content-type'], /text\/plain/);
  });
});

test('compilePath + normalizePath units', () => {
  const { regex, keys } = compilePath('/posts/:id/comments/*rest');
  assert.deepEqual(keys.map((k) => k.name), ['id', 'rest']);
  assert.ok(regex.test('/posts/12/comments/a/b'));
  assert.ok(regex.test('/posts/12/comments/'));
  assert.equal(normalizePath('foo/'), '/foo');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
  assert.throws(() => compilePath(''), TypeError);
});
