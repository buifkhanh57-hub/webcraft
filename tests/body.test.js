/**
 * Body parsing tests: JSON, urlencoded, multipart, text, unknown types,
 * empty bodies, size limits, cookies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, withServer } from './helpers.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';

test('JSON bodies round-trip', async () => {
  const app = createApp();
  app.post('/echo', async (ctx) => {
    ctx.res.json({ received: await ctx.req.body() });
  });
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', tags: ['x', 'y'], nested: { ok: true } }),
    });
    assert.deepEqual(await res.json(), { received: { name: 'Ada', tags: ['x', 'y'], nested: { ok: true } } });
  });
});

test('malformed JSON → 400 Bad Request', async () => {
  const app = createApp();
  app.post('/echo', async (ctx) => ctx.res.json(await ctx.req.body()));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_REQUEST');
  });
});

test('urlencoded form bodies are parsed (repeated keys → arrays)', async () => {
  const app = createApp();
  app.post('/form', async (ctx) => ctx.res.json(await ctx.req.body()));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=hello+world&tag=a&tag=b',
    });
    assert.deepEqual(await res.json(), { title: 'hello world', tag: ['a', 'b'] });
  });
});

test('multipart bodies expose fields and files', async () => {
  const app = createApp();
  app.post('/upload', async (ctx) => {
    const parsed = await ctx.req.body();
    ctx.res.json({
      fields: parsed.fields,
      files: parsed.files.map((f) => ({
        fieldname: f.fieldname,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        content: f.data.toString('utf8'),
      })),
    });
  });
  await withServer(app, async ({ url }) => {
    const form = new FormData();
    form.set('title', 'My upload');
    form.set('note', new Blob(['file-body-123'], { type: 'text/plain' }), 'note.txt');
    const res = await fetch(`${url}/upload`, { method: 'POST', body: form });
    const payload = await res.json();
    assert.equal(payload.fields.title, 'My upload');
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].filename, 'note.txt');
    assert.equal(payload.files[0].content, 'file-body-123');
    assert.equal(payload.files[0].fieldname, 'note');
  });
});

test('text/plain bodies become strings; unknown types become Buffers', async () => {
  const app = createApp();
  app.post('/text', async (ctx) => ctx.res.json({ kind: typeof (await ctx.req.body()), value: await ctx.req.body() }));
  app.post('/weird', async (ctx) => {
    const body = await ctx.req.body();
    ctx.res.json({ isBuffer: Buffer.isBuffer(body), bytes: body.length });
  });
  await withServer(app, async ({ url }) => {
    const text = await fetch(`${url}/text`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'just text' });
    assert.deepEqual(await text.json(), { kind: 'string', value: 'just text' });
    const weird = await fetch(`${url}/weird`, { method: 'POST', headers: { 'content-type': 'application/x-unknown' }, body: '0123456789' });
    assert.deepEqual(await weird.json(), { isBuffer: true, bytes: 10 });
  });
});

test('empty POST bodies parse to {}', async () => {
  const app = createApp();
  app.post('/empty', async (ctx) => ctx.res.json(await ctx.req.body()));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/empty`, { method: 'POST' });
    assert.deepEqual(await res.json(), {});
  });
});

test('oversized bodies → 413 (per-request limit and app maxBodySize)', async () => {
  const app = createApp({ maxBodySize: 32 });
  app.post('/strict', async (ctx) => ctx.res.json(await ctx.req.body()));
  app.post('/inline-limit', async (ctx) => ctx.res.json(await ctx.req.body({ limit: 8 })));
  await withServer(app, async ({ url }) => {
    const big = 'x'.repeat(64);
    const appLimit = await fetch(`${url}/strict`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: big });
    assert.equal(appLimit.status, 413);
    const inline = await fetch(`${url}/inline-limit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'y'.repeat(16) });
    assert.equal(inline.status, 413);
  });
});

test('cookie parsing and serialisation', () => {
  const parsed = parseCookies('a=1; b=hello%20world; a=2; quoted="z"; bare');
  assert.deepEqual(parsed.a, ['1', '2']);
  assert.equal(parsed.b, 'hello world');
  assert.equal(parsed.quoted, 'z');
  assert.equal(parsed.bare, '');

  const header = serializeCookie('sid', 'v/1', { httpOnly: true, maxAge: 3600, sameSite: 'lax', path: '/' });
  assert.equal(header, 'sid=v%2F1; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax');
  assert.throws(() => serializeCookie('bad;name', 'x'), TypeError);
});

test('res.cookie() and res.clearCookie() emit Set-Cookie headers', async () => {
  const app = createApp();
  app.get('/set', (ctx) => ctx.res.cookie('theme', 'dark', { httpOnly: true }).json({ ok: true }));
  app.get('/clear', (ctx) => ctx.res.clearCookie('theme').json({ ok: true }));
  await withServer(app, async ({ url }) => {
    const set = await fetch(`${url}/set`);
    const [cookie] = set.headers.getSetCookie();
    assert.match(cookie, /^theme=dark/);
    assert.match(cookie, /HttpOnly/);

    const cleared = await fetch(`${url}/clear`);
    const [gone] = cleared.headers.getSetCookie();
    assert.match(gone, /^theme=;/);
    assert.match(gone, /Max-Age=0/);
  });
});
