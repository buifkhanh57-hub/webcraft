/**
 * CORS, compression and rate-limiting middleware tests. Compression and
 * raw-header cases use the node:http client because undici transparently
 * decompresses responses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createApp, withServer, rawRequest } from './helpers.js';
import { cors } from '../lib/cors.js';
import { compress } from '../lib/compress.js';
import { rateLimit, RateLimiter, TokenBucket } from '../lib/ratelimit.js';

test('CORS echoes a whitelisted origin and answers preflights', async () => {
  const app = createApp();
  app.use(cors({
    origin: ['https://good.example', 'https://also.example'],
    credentials: true,
    maxAge: 600,
    exposedHeaders: ['X-Total-Count'],
  }));
  app.get('/data', (ctx) => ctx.res.json({ ok: true }));

  await withServer(app, async ({ url }) => {
    const simple = await fetch(`${url}/data`, { headers: { origin: 'https://good.example' } });
    assert.equal(simple.headers.get('access-control-allow-origin'), 'https://good.example');
    assert.equal(simple.headers.get('access-control-allow-credentials'), 'true');
    assert.match(simple.headers.get('vary'), /Origin/);
    assert.equal(simple.headers.get('access-control-expose-headers'), 'X-Total-Count');

    const preflight = await fetch(`${url}/data`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://also.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'x-token',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://also.example');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, PUT, PATCH, POST, DELETE');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'x-token');
    assert.equal(preflight.headers.get('access-control-max-age'), '600');
  });
});

test('CORS with origin:* echoes any origin; mismatches get no ACAO header', async () => {
  const wildcard = createApp();
  wildcard.use(cors({ origin: true }));
  wildcard.get('/', (ctx) => ctx.res.text('ok'));
  await withServer(wildcard, async ({ url }) => {
    const res = await fetch(`${url}/`, { headers: { origin: 'https://anywhere.dev' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://anywhere.dev');
  });

  const strict = createApp();
  strict.use(cors({ origin: 'https://trusted.example' }));
  strict.get('/', (ctx) => ctx.res.text('ok'));
  await withServer(strict, async ({ url }) => {
    const denied = await fetch(`${url}/`, { headers: { origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('compress() gzips compressible bodies above the threshold', async () => {
  const app = createApp();
  app.use(compress({ threshold: 64 }));
  app.get('/big', (ctx) => ctx.res.text('x'.repeat(2048)));
  app.get('/small', (ctx) => ctx.res.text('tiny'));
  app.get('/binary', (ctx) => ctx.res.send(Buffer.alloc(2048, 7)));

  await withServer(app, async ({ url }) => {
    const big = await rawRequest(`${url}/big`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(big.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(big.body).toString('utf8'), 'x'.repeat(2048));
    assert.ok(big.headers.vary.includes('Accept-Encoding'));

    const small = await fetch(`${url}/small`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(small.headers.get('content-encoding'), null);

    const binary = await fetch(`${url}/binary`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(binary.headers.get('content-encoding'), null);
  });
});

test('TokenBucket refills over time and reports retry windows', () => {
  const bucket = new TokenBucket(2, 1, 0); // 2 tokens, +1/s, starting at t=0
  assert.equal(bucket.tryTake(0), true);
  assert.equal(bucket.tryTake(0), true);
  assert.equal(bucket.tryTake(0), false);
  assert.equal(bucket.tryTake(1500), true); // 1.5 tokens accrued
  assert.equal(bucket.tryTake(1600), false);
  assert.ok(bucket.retryAfterMs(1600) > 0);
});

test('RateLimiter.take() tracks per-key buckets and sweeps idle ones', () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 2, sweepIntervalMs: 50 });
  limiter.startSweeping();
  try {
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, true);
    const third = limiter.take('a');
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterMs > 0);
    assert.equal(limiter.take('b').allowed, true);
    assert.equal(limiter.size, 2);
    limiter.buckets.get('b').lastRefill = Date.now() - 61_000; // older than the sweep cutoff
    limiter.sweep();
    assert.equal(limiter.size, 1);
  } finally {
    limiter.stopSweeping();
  }
});

test('rateLimit middleware returns 429 with Retry-After after exhaustion', async () => {
  const app = createApp();
  app.get('/limited', rateLimit({ windowMs: 60_000, max: 3, key: () => 'test-key' }), (ctx) => ctx.res.text('ok'));
  app.get('/free', rateLimit({ windowMs: 60_000, max: 1, skip: () => true }), (ctx) => ctx.res.text('ok'));
  await withServer(app, async ({ url }) => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${url}/limited`);
      assert.equal(res.status, 200);
    }
    const blocked = await fetch(`${url}/limited`);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 0);
    assert.equal((await blocked.json()).error.code, 'TOO_MANY_REQUESTS');

    const skipped = await fetch(`${url}/free`);
    assert.equal(skipped.status, 200);
    const still = await fetch(`${url}/free`);
    assert.equal(still.status, 200); // skip() bypasses the limiter entirely
  });
});
