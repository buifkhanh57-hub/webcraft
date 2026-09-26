/**
 * @module request
 *
 * Request wrapper: parsed URL, query, headers, cookies and body handling
 * (JSON, urlencoded, multipart-lite, plain text) with size limits.
 *
 * @example
 * app.post('/upload', async (ctx) => {
 *   const body = await ctx.req.body();
 *   ctx.res.json({ fields: body.fields, files: body.files.map((f) => f.filename) });
 * });
 */

import { parseCookies } from './cookies.js';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './errors.js';

/** Methods that never carry a request body. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Content-type aliases accepted by {@link Request#is} and {@link Request#accepts}. */
const TYPE_ALIASES = Object.freeze({
  html: 'text/html',
  json: 'application/json',
  text: 'text/plain',
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  xml: 'application/xml',
  form: 'application/x-www-form-urlencoded',
});

/**
 * Parse a query string into an object. Repeated keys become arrays and
 * `+` is treated as a space (application/x-www-form-urlencoded rules).
 *
 * @param {string} search Query string with or without the leading `?`.
 * @returns {Record<string, string|string[]>}
 *
 * @example
 * parseQuery('?tag=a&tag=b&q=hello+world');
 * // => { tag: ['a', 'b'], q: 'hello world' }
 */
export function parseQuery(search) {
  const out = Object.create(null);
  if (!search) return out;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return out;
  const params = new URLSearchParams(raw);
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const current = out[key];
      if (Array.isArray(current)) current.push(value);
      else out[key] = [current, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Extract the boundary from a multipart Content-Type header.
 * @param {string} contentType
 * @returns {string|null}
 */
export function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType || '');
  if (!match) return null;
  return match[1] || match[2];
}

/**
 * Parse a multipart/form-data body (a pragmatic subset of RFC 7578 that
 * covers typical form uploads: text fields plus files held in memory).
 *
 * @param {Buffer} buffer Raw request body.
 * @param {string} contentType Full Content-Type header (must contain boundary).
 * @returns {{fields: Record<string, string>, files: Array<{fieldname: string, filename: string, contentType: string, size: number, data: Buffer}>}}
 * @throws {UnsupportedMediaTypeError} When no boundary is present.
 *
 * @example
 * const { fields, files } = parseMultipart(rawBody, contentType);
 * files[0].filename; files[0].data.toString('utf8');
 */
export function parseMultipart(buffer, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new UnsupportedMediaTypeError('Missing multipart boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = Object.create(null);
  const files = [];

  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    // "--boundary--" closes the message
    if (buffer.slice(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--') break;
    // Skip CRLF after boundary
    let partStart = afterDelimiter;
    if (buffer[partStart] === 0x0d && buffer[partStart + 1] === 0x0a) partStart += 2;

    const next = buffer.indexOf(delimiter, partStart);
    if (next === -1) break;
    // Strip the CRLF that precedes the next boundary
    let partEnd = next;
    if (partEnd >= 2 && buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) partEnd -= 2;

    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerBlock = part.slice(0, headerEnd).toString('utf8');
      const data = part.slice(headerEnd + 4);
      const headers = parsePartHeaders(headerBlock);
      const disposition = headers['content-disposition'] || '';
      const name = /name="([^"]*)"/i.exec(disposition);
      const filename = /filename="([^"]*)"/i.exec(disposition);
      const fieldName = name ? name[1] : 'field';
      if (filename) {
        files.push({
          fieldname: fieldName,
          filename: safeDecode(filename[1]) || 'unnamed',
          contentType: headers['content-type'] || 'application/octet-stream',
          size: data.length,
          data,
        });
      } else {
        const value = data.toString('utf8');
        if (Object.prototype.hasOwnProperty.call(fields, fieldName)) {
          const current = fields[fieldName];
          if (Array.isArray(current)) current.push(value);
          else fields[fieldName] = [current, value];
        } else {
          fields[fieldName] = value;
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}

/**
 * Parse the header block of one multipart part.
 * @param {string} block Raw header text.
 * @returns {Record<string, string>} Lowercased header names.
 */
function parsePartHeaders(block) {
  const headers = Object.create(null);
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

/**
 * Percent-decode, tolerating malformed sequences.
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
 * Wrap `node:http` IncomingMessage with convenient accessors.
 * Created for every request by the application context.
 */
export class Request {
  /**
   * @param {import('node:http').IncomingMessage} raw
   */
  constructor(raw) {
    this.raw = raw;
    this.originalUrl = raw.url || '/';
    this._parsed = null;
    this._query = null;
    this._cookies = null;
    this._bodyCache = undefined;
    this.overridePath = null;
    /** Optional default body size limit (bytes) injected by the application config. */
    this.defaultBodyLimit = null;
  }

  /** @returns {URL} Parsed absolute URL (host is synthetic). */
  get parsed() {
    if (this._parsed === null) {
      this._parsed = new URL(this.originalUrl, 'http://localhost');
    }
    return this._parsed;
  }

  /** @returns {string} HTTP method (uppercase). */
  get method() {
    return (this.raw.method || 'GET').toUpperCase();
  }

  /** @returns {string} Raw request URL including query string. */
  get url() {
    return this.originalUrl;
  }

  /** @returns {string} Path portion of the URL (undecoded). */
  get path() {
    if (this.overridePath) return normalize(this.overridePath);
    return this.parsed.pathname;
  }

  /** @returns {string} Query string without the leading `?`. */
  get search() {
    return this.parsed.search.replace(/^\?/, '');
  }

  /** @returns {Record<string, string|string[]>} Parsed query parameters. */
  get query() {
    if (this._query === null) {
      this._query = parseQuery(this.parsed.search);
    }
    return this._query;
  }

  /** @returns {Record<string, string|string[]>} Parsed cookies. */
  get cookies() {
    if (this._cookies === null) {
      this._cookies = parseCookies(this.raw.headers.cookie);
    }
    return this._cookies;
  }

  /** @returns {Record<string, string|string[]>} Lowercased request headers. */
  get headers() {
    return this.raw.headers;
  }

  /**
   * Read a single header (case-insensitive).
   * @param {string} name
   * @returns {string|undefined}
   */
  get(name) {
    return this.raw.headers[String(name).toLowerCase()];
  }

  /** @returns {string|undefined} Content-Type header value. */
  get contentType() {
    return this.raw.headers['content-type'];
  }

  /** @returns {number|undefined} Content-Length as a number. */
  get contentLength() {
    const raw = this.raw.headers['content-length'];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  /** @returns {string} Best-effort client IP (honours X-Forwarded-For). */
  get ip() {
    const forwarded = this.raw.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first;
    }
    return this.raw.socket?.remoteAddress || '';
  }

  /** @returns {string} 'https' | 'http' based on proxy headers or socket. */
  get protocol() {
    const proto = this.raw.headers['x-forwarded-proto'];
    if (proto) return String(proto).split(',')[0].trim();
    return this.raw.socket?.encrypted ? 'https' : 'http';
  }

  /** @returns {string} Host header (honours X-Forwarded-Host). */
  get hostname() {
    const forwarded = this.raw.headers['x-forwarded-host'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return this.raw.headers.host || '';
  }

  /** @returns {boolean} Whether the request arrived over TLS. */
  get secure() {
    return this.protocol === 'https';
  }

  /** @returns {string} Full absolute URL (synthetic host when behind proxy). */
  get href() {
    return `${this.protocol}://${this.hostname || 'localhost'}${this.originalUrl}`;
  }

  /** @returns {boolean} XMLHttpRequest/Fetch indicator. */
  get xhr() {
    return String(this.raw.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
  }

  /**
   * Check the request Content-Type against aliases or MIME strings.
   * @param {...string} types e.g. `req.is('json', 'urlencoded')`.
   * @returns {string|false} The matched type argument, or false.
   */
  is(...types) {
    const contentType = (this.contentType || '').split(';')[0].trim().toLowerCase();
    if (!contentType) return false;
    for (const type of types) {
      const normalized = TYPE_ALIASES[type] || String(type).toLowerCase();
      if (contentType === normalized) return type;
      if (normalized.endsWith('/*') && contentType.startsWith(normalized.slice(0, -1))) return type;
      if (normalized.includes('/') && contentType.startsWith(`${normalized}/`)) return type;
    }
    return false;
  }

  /**
   * Content negotiation via the Accept header.
   * @param {...string} types Candidate types (aliases allowed).
   * @returns {string|false} Best matching candidate or false.
   */
  accepts(...types) {
    const header = this.raw.headers.accept;
    if (!header || header === '*/*') return types[0] ? types[0] : false;
    const offers = types.map((type) => {
      const full = TYPE_ALIASES[type] || String(type).toLowerCase();
      return { alias: type, mime: full, type: full.split('/')[0], subtype: full.split('/')[1] || '*' };
    });
    const parsed = String(header)
      .split(',')
      .map((part) => {
        const [value, ...params] = part.trim().split(';');
        let q = 1;
        for (const param of params) {
          const m = /^q=([0-9.]+)$/i.exec(param.trim());
          if (m) q = Number.parseFloat(m[1]) || 0;
        }
        const [type, subtype = '*'] = value.toLowerCase().split('/');
        return { type, subtype, q };
      })
      .filter((entry) => entry.q > 0)
      .sort((a, b) => b.q - a.q);

    for (const entry of parsed) {
      for (const offer of offers) {
        const typeMatch = entry.type === '*' || entry.type === offer.type;
        const subMatch = entry.subtype === '*' || entry.subtype === offer.subtype;
        if (typeMatch && subMatch) return offer.alias;
      }
    }
    return false;
  }

  /**
   * Read the raw body as a Buffer (with caching + size limit).
   * @param {object} [options]
   * @param {number} [options.limit=1048576] Maximum bytes accepted.
   * @returns {Promise<Buffer>}
   * @throws {PayloadTooLargeError} When the body exceeds the limit.
   */
  async readRaw(options = {}) {
    const fallback = Number.isFinite(this.defaultBodyLimit) ? this.defaultBodyLimit : 1024 * 1024;
    const limit = Number.isFinite(options.limit) ? options.limit : fallback;
    if (this._bodyCache !== undefined) return this._bodyCache;
    const declared = this.contentLength;
    if (declared !== undefined && declared > limit) {
      throw new PayloadTooLargeError(`Body exceeds limit of ${limit} bytes`);
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of this.raw) {
      received += chunk.length;
      if (received > limit) {
        throw new PayloadTooLargeError(`Body exceeds limit of ${limit} bytes`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    this._bodyCache = buffer;
    return buffer;
  }

  /**
   * Parse the request body according to Content-Type.
   *
   * - `application/json` → parsed object (empty body → `{}`)
   * - `application/x-www-form-urlencoded` → field object
   * - `multipart/form-data` → `{ fields, files }`
   * - `text/plain` → string
   * - anything else → Buffer (or `{}` when empty)
   *
   * @param {object} [options]
   * @param {number} [options.limit] Maximum body size in bytes.
   * @returns {Promise<*>} Parsed body.
   * @throws {PayloadTooLargeError} On oversized bodies.
   */
  async body(options = {}) {
    if (this._bodyCache !== undefined) {
      return parseBody(this._bodyCache, this.contentType, this.method);
    }
    const buffer = await this.readRaw(options);
    return parseBody(buffer, this.contentType, this.method);
  }

  /**
   * Read and parse the body as JSON.
   * @param {object} [options] Passed to {@link Request#raw}.
   * @returns {Promise<*>}
   */
  async json(options = {}) {
    const buffer = await this.readRaw(options);
    const text = buffer.toString('utf8').trim();
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch (err) {
      const error = new BadRequestError('Malformed JSON body');
      error.cause = err;
      throw error;
    }
  }

  /**
   * Read the body as a UTF-8 string.
   * @param {object} [options] Passed to {@link Request#raw}.
   * @returns {Promise<string>}
   */
  async text(options = {}) {
    const buffer = await this.readRaw(options);
    return buffer.toString('utf8');
  }

  /**
   * Read the body as urlencoded fields.
   * @param {object} [options] Passed to {@link Request#raw}.
   * @returns {Promise<Record<string, string|string[]>>}
   */
  async form(options = {}) {
    const buffer = await this.readRaw(options);
    return parseQuery(buffer.toString('utf8'));
  }

  /** @returns {boolean} Whether this request can carry a body. */
  get canHaveBody() {
    return !BODYLESS_METHODS.has(this.method);
  }
}

/**
 * Normalise an override path (used by {@link module:middleware.mount}).
 * @param {string} p
 * @returns {string}
 */
function normalize(p) {
  let out = String(p || '/');
  if (!out.startsWith('/')) out = `/${out}`;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out || '/';
}

/**
 * Body parsing strategy shared by {@link Request#body} and the cache path.
 * @param {Buffer} buffer
 * @param {string|undefined} contentType
 * @param {string} method
 * @returns {*}
 */
function parseBody(buffer, contentType, method) {
  if (buffer.length === 0) {
    return BODYLESS_METHODS.has(method) ? {} : {};
  }
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  switch (mime) {
    case 'application/json':
    case 'text/json': {
      const text = buffer.toString('utf8').trim();
      if (text === '') return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new BadRequestError('Malformed JSON body');
      }
    }
    case 'application/x-www-form-urlencoded':
      return parseQuery(buffer.toString('utf8'));
    case 'multipart/form-data':
      return parseMultipart(buffer, contentType || '');
    case 'text/plain':
      return buffer.toString('utf8');
    default:
      return buffer;
  }
}
