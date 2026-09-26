/**
 * Shared test helpers: silent logger, ephemeral-port server bootstrap and a
 * raw HTTP client for cases where `fetch` normalises too much (HEAD bodies,
 * range requests, compressed payloads, traversal paths).
 */

import http from 'node:http';
import { Writable } from 'node:stream';
import { createApp as baseCreateApp } from '../lib/webcraft.js';
import { createLogger } from '../lib/logger.js';

/** A Writable that swallows every byte — keeps test output clean. */
const nullStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });

/** @returns {object} A logger that never emits. */
export function silentLogger() {
  return createLogger({ level: 'fatal', stream: nullStream });
}

/**
 * Create an app with the noisy default logger replaced.
 * @param {object} [options]
 * @returns {object}
 */
export function createApp(options = {}) {
  return baseCreateApp({ logger: silentLogger(), ...options });
}

/**
 * Start an app on an ephemeral port (port 0).
 * @param {object} app
 * @param {string} [host='127.0.0.1']
 * @returns {Promise<{server: object, port: number, url: string, close: function(object=): Promise<void>}>}
 */
export async function start(app, host = '127.0.0.1') {
  const listening = await app.listen(0, host);
  return listening;
}

/**
 * Run `fn` against a running server, closing it afterwards even on failure.
 * @param {object} app
 * @param {function({port: number, url: string}): Promise<void>} fn
 * @returns {Promise<void>}
 */
export async function withServer(app, fn) {
  const listening = await start(app);
  try {
    await fn(listening);
  } finally {
    await listening.close({ timeout: 1000 });
  }
}

/**
 * Minimal HTTP/1.1 client used when fetch's URL normalisation or automatic
 * decompression would hide what the server actually sends.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
export function rawRequest(url, options = {}) {
  const { method = 'GET', headers = {}, body = null, path: overridePath } = options;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: overridePath || `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * Extract a cookie value from a Set-Cookie header line.
 * @param {string[]} setCookies
 * @param {string} name
 * @returns {string|null}
 */
export function cookieValue(setCookies, name) {
  for (const line of setCookies || []) {
    if (line.startsWith(`${name}=`)) {
      return line.slice(name.length + 1).split(';')[0];
    }
  }
  return null;
}
