/**
 * Cookie session tests: signed round-trip through real HTTP exchanges,
 * tampering, expiry, destruction and flash messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, withServer, cookieValue } from './helpers.js';
import { CookieSessionStore, Session, session } from '../lib/session.js';

test('session round-trip: set on one request, read on the next via the cookie', async () => {
  const app = createApp();
  app.session({ secret: 'test-secret', key: 'wc.sid' });
  app.post('/login', (ctx) => { ctx.session.set('user', 'ada'); ctx.res.json({ ok: true }); });
  app.get('/me', (ctx) => ctx.res.json({ user: ctx.session.get('user') ?? null, isNew: ctx.session.isNew }));
  app.post('/logout', (ctx) => { ctx.session.destroy(); ctx.res.json({ bye: true }); });

  await withServer(app, async ({ url }) => {
    const login = await fetch(`${url}/login`, { method: 'POST' });
    assert.equal(login.status, 200);
    const raw = login.headers.getSetCookie().find((c) => c.startsWith('wc.sid='));
    assert.ok(raw, 'session cookie is set');
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    const cookie = `wc.sid=${cookieValue([raw], 'wc.sid')}`;

    const me = await fetch(`${url}/me`, { headers: { cookie } });
    assert.deepEqual(await me.json(), { user: 'ada', isNew: false });

    const logout = await fetch(`${url}/logout`, { method: 'POST', headers: { cookie } });
    const clearCookie = logout.headers.getSetCookie().find((c) => c.startsWith('wc.sid='));
    assert.match(clearCookie, /Max-Age=0/);

    // A browser drops the expired cookie, so the next request arrives without one.
    const after = await fetch(`${url}/me`);
    assert.deepEqual(await after.json(), { user: null, isNew: true });
  });
});

test('tampered cookie signatures are rejected (fresh session)', async () => {
  const app = createApp();
  app.session({ secret: 'test-secret' });
  app.get('/probe', (ctx) => ctx.res.json({ user: ctx.session.get('user') ?? null }));
  await withServer(app, async ({ url }) => {
    const res = await fetch(`${url}/probe`, { headers: { cookie: 'wc.sid=eyJkOn0.0000deadbeef' } });
    assert.deepEqual(await res.json(), { user: null });
  });
});

test('CookieSessionStore: encode/decode, garbage, wrong secret, expiry', () => {
  const store = new CookieSessionStore({ secret: 's1' });
  assert.deepEqual(store.decode(store.encode({ a: 1, b: 'two' })), { a: 1, b: 'two' });
  assert.equal(store.decode('garbage'), null);
  assert.equal(store.decode(''), null);
  assert.equal(store.decode('onlysignature'), null);

  const other = new CookieSessionStore({ secret: 'other' });
  assert.equal(other.decode(store.encode({ a: 1 })), null);

  const expired = new CookieSessionStore({ secret: 's1', maxAge: -1000 });
  assert.equal(expired.decode(expired.encode({ a: 1 })), null);
});

test('Session object: set/get/delete/has/clear/flash/toJSON', () => {
  const s = new Session({ existing: 1 });
  assert.equal(s.isNew, false);
  s.set('n', 1);
  assert.equal(s.get('n'), 1);
  assert.ok(s.has('n'));
  assert.equal(s.delete('n'), true);
  assert.equal(s.delete('n'), false);
  s.set('flashMsg', 'saved');
  assert.equal(s.flash('flashMsg'), 'saved'); // read-once
  assert.equal(s.flash('flashMsg'), undefined);
  s.set('x', 1);
  s.clear();
  assert.deepEqual(s.toJSON(), {});
  s.set('y', 2);
  s.destroy();
  assert.ok(s.destroyed);
  assert.deepEqual(s.toJSON(), {});
  assert.equal(s.set('k', undefined), s); // set(undefined) deletes
  assert.equal(s.get('k'), undefined);
});

test('session middleware requires a non-empty secret', () => {
  assert.throws(() => session({}), TypeError);
  assert.throws(() => session({ secret: '' }), TypeError);
});

test('flash message survives exactly one request', async () => {
  const app = createApp();
  app.session({ secret: 'flash-secret' });
  app.get('/put', (ctx) => { ctx.session.set('notice', 'welcome'); ctx.res.text('stored'); });
  app.get('/take', (ctx) => ctx.res.text(String(ctx.session.flash('notice') ?? 'gone')));

  await withServer(app, async ({ url }) => {
    const put = await fetch(`${url}/put`);
    let cookie = `wc.sid=${cookieValue(put.headers.getSetCookie(), 'wc.sid')}`;

    const first = await fetch(`${url}/take`, { headers: { cookie } });
    assert.equal(await first.text(), 'welcome');
    // The flash() call rewrote the cookie — keep the freshest one.
    const refreshed = cookieValue(first.headers.getSetCookie(), 'wc.sid');
    if (refreshed) cookie = `wc.sid=${refreshed}`;

    const second = await fetch(`${url}/take`, { headers: { cookie } });
    assert.equal(await second.text(), 'gone');
  });
});
