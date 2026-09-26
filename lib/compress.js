/**
 * @module compress
 *
 * Response compression middleware (gzip / deflate / brotli) implemented with
 * the built-in `node:zlib` module. Responses are only compressed when the
 * client advertises support via `Accept-Encoding`, the content type is
 * compressible, and the body is above the size threshold.
 *
 * @example
 * import { compress } from 'webcraft/lib/compress.js';
 *
 * app.use(compress({ threshold: 1024 }));
 */

import zlib from 'node:zlib';

/** Content types compressible by default. */
const COMPRESSIBLE = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/x-www-form-urlencoded',
  'application/vnd.api+json',
  'application/manifest+json',
  'image/svg+xml',
  'font/ttf',
  'font/otf',
  'application/wasm',
];

/**
 * Default content-type filter.
 * @param {string} type Header value, e.g. "application/json; charset=utf-8".
 * @returns {boolean}
 */
export function isCompressibleType(type) {
  if (!type) return false;
  const mime = String(type).split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE.some((candidate) => mime.startsWith(candidate) || mime === candidate);
}

/**
 * Parse an `Accept-Encoding` header into a ranked map.
 * @param {string} header
 * @returns {Map<string, number>} encoding → quality (0 when refused).
 */
export function parseAcceptEncoding(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const [token, ...params] = trimmed.split(';').map((s) => s.trim());
    let q = 1;
    for (const param of params) {
      const m = /^q=([0-9.]+)$/i.exec(param);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }
    const key = token.toLowerCase();
    // Later entries refine earlier ones
    out.set(key, Math.min(q, out.has(key) ? out.get(key) : 1));
  }
  return out;
}

/**
 * Choose the best encoding from client preferences.
 * @param {string} header Raw Accept-Encoding header.
 * @param {string[]} preferences Server preference order (most preferred first).
 * @returns {string|null} Chosen encoding or null.
 */
export function pickEncoding(header, preferences = ['br', 'gzip', 'deflate']) {
  const accepted = parseAcceptEncoding(header);
  const identityQ = accepted.has('identity') ? accepted.get('identity') : accepted.has('*') ? accepted.get('*') : 1;
  if (identityQ === 0 && !preferences.some((enc) => (accepted.get(enc) ?? 0) > 0)) return null;
  for (const encoding of preferences) {
    const q = accepted.has(encoding) ? accepted.get(encoding) : accepted.has('*') ? accepted.get('*') : undefined;
    if (q !== undefined && q > 0) return encoding;
  }
  return null;
}

/**
 * Combine an existing `Vary` header with an extra token.
 * @param {object} res ServerResponse-like object with getHeader.
 * @param {string} value
 * @returns {string}
 */
function appendVary(res, value) {
  const existing = res.getHeader('Vary');
  if (!existing) return value;
  const set = new Set(
    String(existing)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  set.add(value);
  return [...set].join(', ');
}

/**
 * Create the compression middleware. Wrap it as the outermost middleware so
 * every downstream response can be compressed.
 *
 * @param {object} [options]
 * @param {number} [options.threshold=1024] Minimum Content-Length in bytes.
 * @param {number} [options.level] zlib compression level (0-9).
 * @param {number} [options.chunkSize] zlib chunk size.
 * @param {string[]} [options.encodings=['br','gzip','deflate']] Server prefs.
 * @param {function(string): boolean} [options.filter] Content-type filter.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.use(compress({ threshold: 2048, level: 6 }));
 */
export function compress(options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 1024;
  const level = options.level;
  const chunkSize = options.chunkSize;
  const encodings = options.encodings || ['br', 'gzip', 'deflate'];
  const filter = typeof options.filter === 'function' ? options.filter : isCompressibleType;

  return async function compressMiddleware(ctx, next) {
    const raw = ctx.res.raw;
    const originalWrite = raw.write.bind(raw);
    const originalEnd = raw.end.bind(raw);

    let stream = null;
    let decided = false;
    let decision = false;

    /** Decide once whether this response gets compressed. */
    const decide = () => {
      if (decided) return decision;
      decided = true;
      const status = raw.statusCode;
      if (raw.headersSent) return false;
      if (status < 200 || status === 204 || status === 304) return false;
      if (ctx.res.get('Content-Encoding')) return false;
      const type = ctx.res.get('Content-Type');
      if (!filter(type)) return false;
      const lengthHeader = ctx.res.get('Content-Length');
      if (lengthHeader !== undefined && Number(lengthHeader) < threshold) return false;
      const chosen = pickEncoding(ctx.req.headers['accept-encoding'], encodings);
      if (!chosen) return false;

      ctx.res.removeHeader('Content-Length');
      ctx.res.set('Content-Encoding', chosen);
      ctx.res.set('Vary', appendVary(raw, 'Accept-Encoding'));

      const zlibOptions = {};
      if (Number.isFinite(level)) zlibOptions.level = level;
      if (Number.isFinite(chunkSize)) zlibOptions.chunkSize = chunkSize;
      if (chosen === 'br') stream = zlib.createBrotliCompress({ chunkSize: zlibOptions.chunkSize });
      else if (chosen === 'gzip') stream = zlib.createGzip(zlibOptions);
      else stream = zlib.createDeflate(zlibOptions);

      // Manual piping: compressed bytes must bypass the patched write/end
      // wrappers and hit the raw ServerResponse directly.
      stream.on('data', (chunk) => {
        const ok = originalWrite(chunk);
        if (!ok && typeof stream.pause === 'function') {
          stream.pause();
          raw.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => originalEnd());
      stream.on('error', () => raw.destroy());
      decision = true;
      return true;
    };

    /** Normalise Node's overloaded (chunk, encoding, callback) arguments. */
    const normaliseArgs = (args) => {
      let chunk = args[0];
      let encoding = args[1];
      let callback = args[2];
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      }
      return { chunk, encoding, callback };
    };

    raw.write = function compressedWrite(...args) {
      const { chunk, encoding, callback } = normaliseArgs(args);
      if (chunk !== undefined && decide()) return stream.write(chunk, encoding, callback);
      return originalWrite(chunk, encoding, callback);
    };

    raw.end = function compressedEnd(...args) {
      const { chunk, encoding, callback } = normaliseArgs(args);
      if (chunk !== undefined && decide()) return stream.end(chunk, encoding, callback);
      if (chunk === undefined && decide()) return stream.end();
      return originalEnd(chunk, encoding, callback);
    };

    try {
      await next();
    } finally {
      if (stream && !raw.writableEnded) stream.end();
    }
  };
}
