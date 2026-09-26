/**
 * @module response
 *
 * Response wrapper with helpers for JSON/HTML/text bodies, redirects,
 * cookies, ETags, file streaming (with HTTP range support) and downloads.
 *
 * @example
 * app.get('/report.pdf', async (ctx) => {
 *   await ctx.res.sendFile('/data/report.pdf', { cacheControl: 'private, max-age=60' });
 * });
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { Cookies, serializeCookie } from './cookies.js';
import { NotFoundError, ForbiddenError } from './errors.js';

/** Statuses that must never carry a message body. */
const BODYLESS_STATUS = new Set([204, 205, 304]);

/**
 * Parse a `Range` header against a resource of known size.
 *
 * @param {string|undefined} header Raw Range header, e.g. "bytes=0-499".
 * @param {number} size Total resource size in bytes.
 * @returns {{start:number,end:number}|'invalid'|null}
 *   `{start,end}` for a satisfiable range, `'invalid'` for a malformed or
 *   unsatisfiable header (→ 416), `null` when no range was requested.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    if (suffix === 0) return 'invalid';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Compute a strong ETag from arbitrary body content.
 * @param {Buffer|string} body
 * @returns {string} Quoted strong ETag.
 */
export function computeEtag(body) {
  const hash = crypto.createHash('sha1').update(body).digest('base64url');
  return `"${hash}"`;
}

/**
 * Weak ETag derived from file metadata.
 * @param {number} size
 * @param {number} mtimeMs
 * @returns {string}
 */
export function fileEtag(size, mtimeMs) {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/**
 * Does `If-None-Match` match the provided ETag?
 * @param {string|undefined} ifNoneMatch
 * @param {string} etag
 * @returns {boolean}
 */
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const value = String(ifNoneMatch);
  if (value.trim() === '*') return true;
  return value
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//i, ''))
    .includes(etag.replace(/^W\//i, ''));
}

/**
 * Wrap `node:http` ServerResponse with framework helpers.
 */
export class Response {
  /**
   * @param {import('node:http').ServerResponse} raw
   * @param {import('node:http').IncomingMessage} [req] Used for range/etag logic.
   */
  constructor(raw, req) {
    this.raw = raw;
    this.req = req || raw.req || null;
    this.cookies = new Cookies(this.req || { headers: {} }, raw);
  }

  /** @returns {boolean} Whether headers were already flushed. */
  get headersSent() {
    return this.raw.headersSent;
  }

  /** @returns {boolean} Whether the response is fully written. */
  get writableEnded() {
    return this.raw.writableEnded;
  }

  /** @returns {number} Current status code. */
  get statusCode() {
    return this.raw.statusCode;
  }

  /**
   * Set the response status.
   * @param {number} code HTTP status code.
   * @returns {Response} this
   */
  setStatus(code) {
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new TypeError(`Invalid HTTP status code: ${code}`);
    }
    this.raw.statusCode = code;
    return this;
  }

  /** Alias of {@link Response#setStatus}. */
  status(code) {
    return this.setStatus(code);
  }

  /**
   * Set one or many headers.
   * @param {string|Record<string, string>} name
   * @param {string|number|string[]} [value]
   * @returns {Response} this
   */
  set(name, value) {
    if (typeof name === 'object' && name !== null) {
      for (const [key, val] of Object.entries(name)) this.raw.setHeader(key, val);
      return this;
    }
    this.raw.setHeader(name, value);
    return this;
  }

  /** Alias of {@link Response#set} for header-style calls. */
  header(name, value) {
    return this.set(name, value);
  }

  /**
   * Read a response header.
   * @param {string} name
   * @returns {string|number|string[]|undefined}
   */
  get(name) {
    return this.raw.getHeader(name);
  }

  /** @returns {boolean} Whether a header is present. */
  has(name) {
    return this.raw.hasHeader(name);
  }

  /**
   * Append a value to a header that may repeat (e.g. Set-Cookie).
   * @param {string} name
   * @param {string} value
   * @returns {Response} this
   */
  append(name, value) {
    const existing = this.raw.getHeader(name);
    if (!existing) this.raw.setHeader(name, [value]);
    else if (Array.isArray(existing)) this.raw.setHeader(name, [...existing, value]);
    else this.raw.setHeader(name, [existing, value]);
    return this;
  }

  /**
   * Remove a header.
   * @param {string} name
   * @returns {Response} this
   */
  removeHeader(name) {
    this.raw.removeHeader(name);
    return this;
  }

  /**
   * Set the Content-Type (adds charset for text types).
   * @param {string} mime Full MIME type or file extension.
   * @returns {Response} this
   */
  type(mime) {
    let value = String(mime);
    if (!value.includes('/')) {
      // Allow extension-style types; unknown extensions fall back to octet-stream
      value = mime === 'html' ? 'text/html' : value.startsWith('.') ? value.slice(1) : value;
      if (!value.includes('/')) value = 'application/octet-stream';
    }
    const charset = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))/i.test(value) ? '; charset=utf-8' : '';
    return this.set('Content-Type', `${value}${charset}`);
  }

  /**
   * Send a JSON body.
   * @param {*} data JSON-serialisable value.
   * @param {number} [status] Optional status override.
   * @returns {Response} this
   */
  json(data, status) {
    const body = JSON.stringify(data);
    if (status !== undefined) this.setStatus(status);
    if (!this.has('Content-Type')) this.type('application/json');
    return this.end(body);
  }

  /**
   * Send an HTML body.
   * @param {string} markup
   * @param {number} [status]
   * @returns {Response} this
   */
  html(markup, status) {
    if (status !== undefined) this.setStatus(status);
    if (!this.has('Content-Type')) this.type('text/html');
    return this.end(String(markup));
  }

  /**
   * Send a plain-text body.
   * @param {string} text
   * @param {number} [status]
   * @returns {Response} this
   */
  text(text, status) {
    if (status !== undefined) this.setStatus(status);
    if (!this.has('Content-Type')) this.type('text/plain');
    return this.end(String(text));
  }

  /**
   * Send arbitrary data with sensible defaults:
   * string → html, Buffer → binary, object → json, number → status text.
   * @param {string|Buffer|object|number} body
   * @returns {Response} this
   */
  send(body) {
    if (typeof body === 'number') {
      this.setStatus(body);
      return this.text(String(body));
    }
    if (Buffer.isBuffer(body)) {
      if (!this.has('Content-Type')) this.type('application/octet-stream');
      return this.end(body);
    }
    if (typeof body === 'object' && body !== null) return this.json(body);
    if (typeof body === 'string') {
      if (!this.has('Content-Type')) this.type('text/html');
      return this.end(body);
    }
    return this.end();
  }

  /**
   * Write an ETag for the given body and short-circuit with 304 when the
   * client already has it (`If-None-Match`).
   * @param {Buffer|string} body
   * @returns {boolean} true when a 304 was sent.
   */
  etag(body) {
    const tag = computeEtag(body);
    this.set('ETag', tag);
    if (etagMatches(this.req && this.req.headers ? this.req.headers['if-none-match'] : undefined, tag)) {
      this.notModified();
      return true;
    }
    return false;
  }

  /**
   * Terminate with a 304 Not Modified (body headers are stripped).
   * @returns {Response} this
   */
  notModified() {
    this.removeHeader('Content-Type');
    this.removeHeader('Content-Length');
    this.removeHeader('Transfer-Encoding');
    this.setStatus(304);
    this.raw.end();
    return this;
  }

  /**
   * Redirect to another URL.
   * @param {string} url Destination (absolute or relative).
   * @param {301|302|303|307|308} [status=302]
   * @returns {Response} this
   */
  redirect(url, status = 302) {
    if (![301, 302, 303, 307, 308].includes(status)) {
      throw new TypeError(`Invalid redirect status: ${status}`);
    }
    this.setStatus(status);
    this.set('Location', url);
    const safeUrl = String(url).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const body = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${safeUrl}"><title>Redirecting…</title></head><body><p>Redirecting to <a href="${safeUrl}">${safeUrl}</a></p></body></html>`;
    this.type('text/html');
    return this.end(body);
  }

  /**
   * Queue a Set-Cookie header.
   * @param {string} name
   * @param {string|number|boolean} value
   * @param {object} [options] See {@link module:cookies.serializeCookie}.
   * @returns {Response} this
   */
  cookie(name, value, options = {}) {
    return this.append('Set-Cookie', serializeCookie(name, value, options));
  }

  /**
   * Expire a cookie on the client.
   * @param {string} name
   * @param {object} [options]
   * @returns {Response} this
   */
  clearCookie(name, options = {}) {
    return this.cookie(name, '', { ...options, path: options.path || '/', maxAge: 0, expires: new Date(0) });
  }

  /**
   * Set Content-Disposition attachment (with optional file path).
   * @param {string} [filename] Suggested download name.
   * @returns {Response} this
   */
  attachment(filename) {
    if (filename) this.set('Content-Disposition', `attachment; filename="${String(filename).replace(/["\\]/g, '')}"`);
    else this.set('Content-Disposition', 'attachment');
    return this;
  }

  /**
   * Stream a readable stream as the response body.
   * @param {import('node:stream').Readable} stream
   * @returns {Promise<void>} Resolves when the response finishes.
   */
  stream(stream) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      stream.on('error', fail);
      this.raw.on('finish', finish);
      stream.pipe(this.raw);
    });
  }

  /**
   * Stream a file from disk with ETag, Last-Modified, Cache-Control and
   * single-range support (206 / 416).
   *
   * @param {string} filePath Absolute or root-relative path.
   * @param {object} [options]
   * @param {string} [options.root] Resolve `filePath` relative to this dir.
   * @param {object} [options.headers] Extra headers to set.
   * @param {string} [options.cacheControl] Cache-Control value.
   * @param {boolean} [options.etag=true] Compute and honour ETag.
   * @param {boolean} [options.lastModified=true] Send Last-Modified.
   * @param {boolean} [options.acceptRanges=true] Enable range requests.
   * @param {boolean} [options.dotfiles=false] Allow paths with dot segments.
   * @returns {Promise<void>} Resolves when streaming finished.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {ForbiddenError} When access is denied.
   *
   * @example
   * await ctx.res.sendFile('/assets/logo.png', { root: '/srv/www', cacheControl: 'public, max-age=3600' });
   */
  async sendFile(filePath, options = {}) {
    const root = options.root ? path.resolve(options.root) : null;
    const target = root ? path.resolve(root, filePath) : path.resolve(filePath);
    if (root && !(target === root || target.startsWith(root + path.sep))) {
      throw new ForbiddenError('File access outside of root directory');
    }
    if (options.dotfiles !== true && path.basename(target).startsWith('.')) {
      throw new ForbiddenError('Dotfiles are not served');
    }

    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        throw new NotFoundError(`File not found: ${path.basename(target)}`);
      }
      if (err && err.code === 'EACCES') throw new ForbiddenError('File access denied');
      throw err;
    }
    if (!stat.isFile()) throw new NotFoundError(`Not a file: ${path.basename(target)}`);

    const size = stat.size;
    const etagValue = options.etag === false ? null : fileEtag(size, stat.mtimeMs);
    if (etagValue) this.set('ETag', etagValue);
    if (options.lastModified !== false) this.set('Last-Modified', stat.mtime.toUTCString());
    if (options.cacheControl) this.set('Cache-Control', options.cacheControl);
    if (options.acceptRanges !== false) this.set('Accept-Ranges', 'bytes');
    if (options.headers) this.set(options.headers);
    if (!this.has('Content-Type')) {
      const ext = path.extname(target).slice(1).toLowerCase();
      this.set('Content-Type', ext === 'html' || ext === 'htm' ? 'text/html; charset=utf-8' : 'application/octet-stream');
    }

    const requestHeaders = (this.req && this.req.headers) || {};
    if (etagValue && etagMatches(requestHeaders['if-none-match'], etagValue)) {
      return this.notModified();
    }
    if (
      etagValue === null &&
      options.lastModified !== false &&
      requestHeaders['if-modified-since'] &&
      new Date(requestHeaders['if-modified-since']).getTime() >= Math.floor(stat.mtimeMs)
    ) {
      return this.notModified();
    }

    const rangeHeader = options.acceptRanges === false ? null : requestHeaders.range;
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') {
      this.setStatus(416);
      this.set('Content-Range', `bytes */${size}`);
      return this.end();
    }
    if (range) {
      this.setStatus(206);
      this.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      this.set('Content-Length', String(range.end - range.start + 1));
      if (this.req && this.req.method === 'HEAD') return this.end();
      const partial = fs.createReadStream(target, { start: range.start, end: range.end });
      return this.stream(partial);
    }

    this.set('Content-Length', String(size));
    if (this.req && this.req.method === 'HEAD') return this.end();
    const full = fs.createReadStream(target);
    return this.stream(full);
  }

  /**
   * Send a file as a download attachment.
   * @param {string} filePath
   * @param {string} [filename] Defaults to the basename of filePath.
   * @param {object} [options] Passed to {@link Response#sendFile}.
   * @returns {Promise<void>}
   */
  async download(filePath, filename, options = {}) {
    this.attachment(filename || path.basename(filePath));
    return this.sendFile(filePath, options);
  }

  /**
   * Finalise the response with an optional body.
   * @param {string|Buffer} [body]
   * @returns {Response} this
   */
  end(body) {
    if (BODYLESS_STATUS.has(this.raw.statusCode)) {
      this.removeHeader('Content-Length');
      this.raw.end();
      return this;
    }
    if (body === undefined || body === null) {
      this.raw.end();
      return this;
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (!this.raw.headersSent && !this.has('Content-Length') && !(this.req && this.req.method === 'HEAD')) {
      this.set('Content-Length', String(buffer.length));
    }
    this.raw.end(buffer);
    return this;
  }
}

// Keep a reference for modules that need Readable (e.g. wrapping strings)
export { Readable };
