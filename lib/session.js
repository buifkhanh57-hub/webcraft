/**
 * @module session
 *
 * Cookie-based sessions signed with HMAC-SHA256. The session payload is
 * stored directly inside the cookie (no server-side storage), so it is ideal
 * for small session data like user ids, preferences and flash messages.
 *
 * Cookie format: `base64url(json payload).hmac-sha256-hex`
 *
 * @example
 * import { session, Session } from 'webcraft/lib/session.js';
 *
 * app.use(session({ secret: 'keyboard-cat', maxAge: 3600_000 }));
 *
 * app.get('/counter', (ctx) => {
 *   const n = (ctx.session.get('n') || 0) + 1;
 *   ctx.session.set('n', n);
 *   ctx.res.json({ n });
 * });
 */

import crypto from 'node:crypto';
import { serializeCookie } from './cookies.js';

/** Default session cookie name. */
export const DEFAULT_COOKIE_NAME = 'wc.sid';

/** Maximum practical cookie size — browsers reject cookies above 4096 bytes. */
export const MAX_COOKIE_BYTES = 4000;

/**
 * Encode/decode + sign/verify session payloads.
 */
export class CookieSessionStore {
  /**
   * @param {object} options
   * @param {string|Buffer} options.secret HMAC secret (required).
   * @param {string} [options.key='wc.sid'] Cookie name.
   * @param {number} [options.maxAge=86400000] Session lifetime in ms.
   * @param {string} [options.algorithm='sha256'] Hash algorithm for HMAC.
   * @throws {TypeError} When the secret is missing.
   */
  constructor(options = {}) {
    const secret = options.secret;
    if (secret === undefined || secret === null || secret === '') {
      throw new TypeError('session() requires a non-empty secret');
    }
    this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
    this.key = options.key || DEFAULT_COOKIE_NAME;
    this.maxAge = Number.isFinite(options.maxAge) ? options.maxAge : 86_400_000;
    this.algorithm = options.algorithm || 'sha256';
    this.cookieOptions = {
      path: options.path || '/',
      httpOnly: options.httpOnly !== false,
      secure: options.secure !== undefined ? options.secure : false,
      sameSite: options.sameSite || 'Lax',
      domain: options.domain,
    };
  }

  /**
   * Compute the HMAC for a payload.
   * @param {string} payload Base64url payload string.
   * @returns {string} Hex digest.
   */
  sign(payload) {
    return crypto.createHmac(this.algorithm, this.secret).update(payload).digest('hex');
  }

  /**
   * Constant-time comparison of two digests.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  compare(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Serialise session data into a signed cookie value.
   * @param {object} data Plain JSON-safe session object.
   * @param {number} [maxAgeMs] Overrides the store default.
   * @returns {string} `payload.signature`
   */
  encode(data, maxAgeMs) {
    const age = Number.isFinite(maxAgeMs) ? maxAgeMs : this.maxAge;
    const payloadObject = { d: data, exp: Date.now() + age };
    const payload = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /**
   * Verify and decode a cookie value.
   * @param {string} value Raw cookie value.
   * @returns {object|null} Session data, or null when invalid/expired.
   */
  decode(value) {
    if (typeof value !== 'string') return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    if (!payload || !signature) return null;
    const expected = this.sign(payload);
    if (!this.compare(expected, signature)) return null;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.exp !== 'number') return null;
    if (Date.now() > parsed.exp) return null;
    return parsed.d && typeof parsed.d === 'object' ? parsed.d : {};
  }
}

/**
 * Mutable session object attached to the request context.
 */
export class Session {
  /**
   * @param {object} [initial] Restored session data.
   */
  constructor(initial = {}) {
    this.data = initial && typeof initial === 'object' ? { ...initial } : {};
    this.dirty = false;
    this.destroyed = false;
    this.isNew = Object.keys(this.data).length === 0;
  }

  /**
   * Read a value.
   * @param {string} key
   * @returns {*} undefined when missing.
   */
  get(key) {
    return this.data[key];
  }

  /**
   * Write a value (marks the session dirty so the cookie is refreshed).
   * Passing `undefined` removes the key. Always returns the session so
   * calls can be chained.
   * @param {string} key
   * @param {*} value JSON-safe value.
   * @returns {Session} this
   */
  set(key, value) {
    if (value === undefined) {
      this.delete(key);
      return this;
    }
    this.data[key] = value;
    this.dirty = true;
    this.isNew = false;
    return this;
  }

  /**
   * Remove a value.
   * @param {string} key
   * @returns {boolean} Whether the key existed.
   */
  delete(key) {
    if (!Object.prototype.hasOwnProperty.call(this.data, key)) return false;
    delete this.data[key];
    this.dirty = true;
    return true;
  }

  /** @returns {boolean} */
  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  /** Clear every value. */
  clear() {
    this.data = {};
    this.dirty = true;
  }

  /**
   * Destroy the session: the cookie will be expired and data wiped.
   */
  destroy() {
    this.data = {};
    this.dirty = true;
    this.destroyed = true;
  }

  /** @returns {string[]} Keys present in the session. */
  keys() {
    return Object.keys(this.data);
  }

  /** @returns {object} Snapshot of the session data. */
  toJSON() {
    return { ...this.data };
  }

  /**
   * Flash message helper: read and immediately delete.
   * @param {string} key
   * @returns {*} Stored value or undefined.
   */
  flash(key) {
    const value = this.data[key];
    if (value !== undefined) this.delete(key);
    return value;
  }
}

/**
 * Create session middleware. After `next()` resolves, a fresh signed cookie
 * is attached when the session was modified (or expired on destroy()).
 *
 * @param {object} [options] All {@link CookieSessionStore} options plus:
 * @param {boolean} [options.autoCommit=true] Write the cookie automatically.
 * @param {number} [options.limit=4000] Warn when the cookie would exceed this size.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.use(session({ secret: process.env.SESSION_SECRET, sameSite: 'Strict' }));
 */
export function session(options = {}) {
  const store = new CookieSessionStore(options);
  const autoCommit = options.autoCommit !== false;
  const limit = Number.isFinite(options.limit) ? options.limit : MAX_COOKIE_BYTES;

  return async function sessionMiddleware(ctx, next) {
    const rawCookie = ctx.req.cookies[store.key];
    const restored = rawCookie ? store.decode(rawCookie) : null;
    ctx.session = new Session(restored || {});
    ctx.sessionStore = store;

    let committed = false;
    const commit = () => {
      if (committed || !ctx.session || !ctx.res || ctx.res.raw.headersSent) return;
      committed = true;
      if (ctx.session.destroyed) {
        ctx.res.cookie(store.key, '', { ...store.cookieOptions, maxAge: 0, expires: new Date(0) });
      } else if (ctx.session.dirty) {
        const value = store.encode(ctx.session.data);
        const cookieHeader = serializeCookie(store.key, value, { ...store.cookieOptions, maxAge: Math.floor(store.maxAge / 1000) });
        if (Buffer.byteLength(cookieHeader, 'utf8') > limit) {
          ctx.app?.logger?.warn?.(`Session cookie "${store.key}" exceeds ${limit} bytes — drop unnecessary keys`);
        }
        ctx.res.cookie(store.key, value, { ...store.cookieOptions, maxAge: Math.floor(store.maxAge / 1000) });
      }
    };

    // Commit the cookie just before the response is finalised so handlers
    // can freely end the response inside their own code.
    const raw = ctx.res.raw;
    const originalEnd = raw.end.bind(raw);
    raw.end = function sessionEnd(...args) {
      commit();
      return originalEnd(...args);
    };

    try {
      await next();
    } finally {
      if (autoCommit && ctx.session) commit();
    }
  };
}
