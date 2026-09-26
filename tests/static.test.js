/**
 * Static file serving tests: index resolution, MIME types, cache headers,
 * conditional requests (ETag/304), range requests, dotfiles, fallthrough
 * and traversal protection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, withServer, rawRequest } from './helpers.js';
import { createStatic, lookupMime } from '../lib/static.js';
import { ForbiddenError } from '../lib/errors.js';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(root, 'style.css'), 'body { color: rebeccapurple; }\n');
  fs.writeFileSync(path.join(root, 'about.html'), '<p>about page</p>');
  fs.writeFileSync(path.join(root, 'data.json'), '{"ok":true}');
  fs.writeFileSync(path.join(root, '.hidden'), 'secret');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'note.txt'), 'nested file');
  return root;
}

test('static middleware serves files with correct MIME + index resolution', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root));
  await withServer(app, async ({ url }) => {
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), '<h1>home</h1>');
    assert.match(index.headers.get('content-type'), /text\/html/);

    const css = await fetch(`${url}/style.css`);
    assert.equal(await css.text(), 'body { color: rebeccapurple; }\n');
    assert.match(css.headers.get('content-type'), /text\/css/);

    const nested = await fetch(`${url}/nested/note.txt`);
    assert.equal(await nested.text(), 'nested file');

    const json = await fetch(`${url}/data.json`);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.ok(json.headers.get('etag'));
  });
});

test('extensions option resolves /about → /about.html; miss falls through to 404', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root, { extensions: ['html'] }));
  app.get('/fallback', (ctx) => ctx.res.text('route'));
  await withServer(app, async ({ url }) => {
    const about = await fetch(`${url}/about`);
    assert.equal(await about.text(), '<p>about page</p>');

    const missing = await fetch(`${url}/no-such-file`);
    assert.equal(missing.status, 404);

    const route = await fetch(`${url}/fallback`);
    assert.equal(await route.text(), 'route');
  });
});

test('ETag + If-None-Match → 304 Not Modified', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root));
  await withServer(app, async ({ url }) => {
    const first = await fetch(`${url}/style.css`);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const second = await fetch(`${url}/style.css`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
  });
});

test('Cache-Control comes from maxAge/immutable options', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root, { maxAge: 86400, immutable: true }));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/index.html`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400, immutable');
  });
});

test('single range requests → 206 with Content-Range; invalid range → 416', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root));
  await withServer(app, async ({ url }) => {
    const css = fs.readFileSync(path.join(root, 'style.css'));
    const partial = await fetch(`${url}/style.css`, { headers: { range: 'bytes=0-4' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-4/${css.length}`);
    assert.equal(await partial.text(), css.subarray(0, 5).toString('utf8'));

    const suffix = await fetch(`${url}/style.css`, { headers: { range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), css.subarray(css.length - 3).toString('utf8'));

    const invalid = await rawRequest(`${url}/style.css`, { headers: { range: 'bytes=999999-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${css.length}`);
  });
});

test('dotfiles are denied by default (403), served with dotfiles:true', async () => {
  const root = makeFixture();
  const denyApp = createApp();
  denyApp.use(createStatic(root));
  await withServer(denyApp, async ({ url }) => {
    const res = await fetch(`${url}/.hidden`);
    assert.equal(res.status, 403);
  });

  const allowApp = createApp();
  allowApp.use(createStatic(root, { dotfiles: true }));
  await withServer(allowApp, async ({ url }) => {
    const res = await fetch(`${url}/.hidden`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'secret');
  });
});

test('fallthrough:false turns misses into thrown 404s', async () => {
  const root = makeFixture();
  const app = createApp();
  app.use(createStatic(root, { fallthrough: false }));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/nope.html`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});

test('traversal attempts stay inside the root (guard throws Forbidden)', async () => {
  const root = makeFixture();
  const middleware = createStatic(root);
  const ctx = { req: { method: 'GET', path: '/%2e%2e/%2e%2e/etc/passwd', headers: {} }, res: { set: () => {} } };
  await assert.rejects(() => middleware(ctx, async () => {}), ForbiddenError);
});

test('lookupMime covers common types and falls back to octet-stream', () => {
  assert.equal(lookupMime('photo.jpg'), 'image/jpeg');
  assert.equal(lookupMime('.png'), 'image/png');
  assert.equal(lookupMime('font.woff2'), 'font/woff2');
  assert.equal(lookupMime('archive.tar.gz'), 'application/gzip');
  assert.equal(lookupMime('mystery.zzz'), 'application/octet-stream');
  assert.equal(lookupMime(''), 'application/octet-stream');
});
