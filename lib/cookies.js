/**
 * @module cookies
 *
 * Cookie parsing and serialisation built on top of `Set-Cookie` semantics
 * (RFC 6265). No dependencies: everything is done with plain string handling.
 *
 * @example
 * import { parseCookies, serializeCookie } from 'webcraft/lib/cookies.js';
 *
 * const jar = parseCookies(req.headers.cookie);        // { theme: 'dark' }
 * const header = serializeCookie('token', 'abc', { httpOnly: true, maxAge: 3600 });
 * // => "token=abc; Max-Age=3600; Path=/; HttpOnly"
 */

/** Attributes allowed inside `Set-Cookie`. */
const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None', 'strict', 'lax', 'none']);
const PRIORITY_VALUES = new Set(['Low', 'Medium', 'High']);

/**
 * Percent-decode a cookie component, tolerating malformed sequences.
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a `Cookie` request header into a plain object.
 * Repeated names collapse into an array (like PHP/Rails behaviour).
 *
 * @param {string|undefined} header Raw `Cookie` header value.
 * @returns {Record<string, string|string[]>} Map of cookie name → value.
 *
 * @example
 * parseCookies('a=1; b=hello%20world; a=2');
 * // => { a: ['1', '2'], b: 'hello world' }
 */
export function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  const pairs = header.split(';');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    let name;
    let value;
    if (eq === -1) {
      name = trimmed;
      value = '';
    } else {
      name = trimmed.slice(0, eq).trim();
      value = trimmed.slice(eq + 1).trim();
    }
    if (!name) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    value = safeDecode(value);
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      const current = out[name];
      if (Array.isArray(current)) current.push(value);
      else out[name] = [current, value];
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Validate a cookie name/value pair. Throws on characters forbidden by the
 * cookie grammar (semicolons, commas, control characters, ...).
 * @param {string} name
 * @param {string} value
 * @throws {TypeError} When the name or value is invalid.
 */
function assertValidCookie(name, value) {
  if (!name || /[\s;,\\]/.test(name)) {
    throw new TypeError(`Invalid cookie name: "${name}"`);
  }
  if (/[\r\n;\\]/.test(value)) {
    throw new TypeError(`Invalid cookie value for "${name}"`);
  }
}

/**
 * Serialise one `Set-Cookie` header string.
 *
 * @param {string} name Cookie name.
 * @param {string|number|boolean} value Cookie value (percent-encoded).
 * @param {object} [options]
 * @param {number} [options.maxAge] Lifetime in **seconds**.
 * @param {Date} [options.expires] Absolute expiry date.
 * @param {string} [options.path='/'] Cookie path.
 * @param {string} [options.domain] Domain attribute.
 * @param {boolean} [options.secure] Send only over HTTPS.
 * @param {boolean} [options.httpOnly] Hide from `document.cookie`.
 * @param {'Strict'|'Lax'|'None'} [options.sameSite] SameSite policy.
 * @param {'Low'|'Medium'|'High'} [options.priority] Cookie priority.
 * @param {boolean} [options.partitioned] CHIPS partitioned cookie.
 * @returns {string} A complete `Set-Cookie` value.
 *
 * @example
 * serializeCookie('sid', 'xyz', { httpOnly: true, sameSite: 'Lax', maxAge: 86400 });
 */
export function serializeCookie(name, value, options = {}) {
  if (value === undefined || value === null) value = '';
  const strValue = String(value);
  assertValidCookie(name, strValue);
  const parts = [`${name}=${encodeURIComponent(strValue)}`];

  if (options.maxAge !== undefined && options.maxAge !== null) {
    const maxAge = Number(options.maxAge);
    if (!Number.isFinite(maxAge)) throw new TypeError('maxAge must be a finite number of seconds');
    parts.push(`Max-Age=${Math.floor(maxAge)}`);
  }
  if (options.expires !== undefined && options.expires !== null) {
    if (!(options.expires instanceof Date)) throw new TypeError('expires must be a Date instance');
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.path !== undefined && options.path !== null) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure) parts.push('Secure');
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite !== undefined && options.sameSite !== null) {
    const normalized = String(options.sameSite).charAt(0).toUpperCase() + String(options.sameSite).slice(1).toLowerCase();
    if (!SAME_SITE_VALUES.has(normalized)) {
      throw new TypeError(`Invalid sameSite value: ${options.sameSite}`);
    }
    parts.push(`SameSite=${normalized}`);
  }
  if (options.priority) {
    const normalized = String(options.priority).charAt(0).toUpperCase() + String(options.priority).slice(1).toLowerCase();
    if (!PRIORITY_VALUES.has(normalized)) throw new TypeError(`Invalid priority value: ${options.priority}`);
    parts.push(`Priority=${normalized}`);
  }
  if (options.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

/**
 * Convenience wrapper binding cookie helpers to a raw request/response pair.
 * Created automatically for every webcraft context (`ctx.req.cookies`,
 * `ctx.res.cookie(...)`, `ctx.res.clearCookie(...)`).
 */
export class Cookies {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this._cache = null;
  }

  /**
   * Lazily parsed cookie jar of the incoming request.
   * @returns {Record<string, string|string[]>}
   */
  get jar() {
    if (this._cache === null) {
      this._cache = parseCookies(this.req.headers.cookie);
    }
    return this._cache;
  }

  /**
   * Read a cookie value.
   * @param {string} name
   * @returns {string|undefined} Last value when the name repeats.
   */
  get(name) {
    const value = this.jar[name];
    return Array.isArray(value) ? value[value.length - 1] : value;
  }

  /**
   * Read every value for a cookie name.
   * @param {string} name
   * @returns {string[]}
   */
  getAll(name) {
    const value = this.jar[name];
    return Array.isArray(value) ? value.slice() : value === undefined ? [] : [value];
  }

  /** @returns {boolean} True when the request carries this cookie. */
  has(name) {
    return Object.prototype.hasOwnProperty.call(this.jar, name);
  }

  /**
   * Queue a `Set-Cookie` header on the response.
   * @param {string} name
   * @param {string|number|boolean} value
   * @param {object} [options] Same as {@link serializeCookie}.
   * @returns {Cookies} this
   */
  set(name, value, options = {}) {
    const existing = this.res.getHeader('Set-Cookie');
    const header = serializeCookie(name, value, options);
    if (!existing) this.res.setHeader('Set-Cookie', [header]);
    else if (Array.isArray(existing)) this.res.setHeader('Set-Cookie', [...existing, header]);
    else this.res.setHeader('Set-Cookie', [existing, header]);
    return this;
  }

  /**
   * Expire a cookie on the client.
   * @param {string} name
   * @param {object} [options] `path`/`domain` must match the original cookie.
   * @returns {Cookies} this
   */
  delete(name, options = {}) {
    return this.set(name, '', { ...options, path: options.path || '/', maxAge: 0, expires: new Date(0) });
  }
}
