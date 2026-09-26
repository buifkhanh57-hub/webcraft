/**
 * @module static
 *
 * Static file server middleware: MIME detection (120+ extensions), ETag,
 * Last-Modified, Cache-Control, 304 revalidation, range requests (delegated
 * to {@link module:response}) and path traversal protection.
 *
 * @example
 * import { createStatic, lookupMime } from 'webcraft/lib/static.js';
 *
 * app.use(createStatic('./public', { maxAge: 3600, immutable: false }));
 * lookupMime('photo.jpg'); // 'image/jpeg'
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { BadRequestError, ForbiddenError, NotFoundError } from './errors.js';

/**
 * Extension → MIME type map. Keys exclude the leading dot.
 */
export const MIME_TYPES = Object.freeze({
  // Text / markup
  html: 'text/html', htm: 'text/html', shtml: 'text/html', xhtml: 'application/xhtml+xml', xht: 'application/xhtml+xml',
  css: 'text/css', txt: 'text/plain', text: 'text/plain', conf: 'text/plain', log: 'text/plain', ini: 'text/plain',
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  ics: 'text/calendar', rtf: 'application/rtf', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  toml: 'application/toml', json: 'application/json', map: 'application/json', jsonld: 'application/ld+json',
  rss: 'application/rss+xml', atom: 'application/atom+xml', mathml: 'application/mathml+xml',
  // Scripts
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  ts: 'text/javascript', tsx: 'text/javascript', mts: 'text/javascript',
  jsonp: 'text/javascript', webmanifest: 'application/manifest+json', manifest: 'text/cache-manifest',
  sh: 'application/x-sh', bash: 'application/x-sh', zsh: 'application/x-sh', fish: 'application/x-sh',
  bat: 'application/x-bat', cmd: 'application/x-bat', ps1: 'text/x-powershell', py: 'text/x-python',
  rb: 'text/x-ruby', pl: 'text/x-perl', php: 'application/x-httpd-php', lua: 'text/x-lua',
  go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java-source', kt: 'text/x-kotlin', swift: 'text/x-swift',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++src', cc: 'text/x-c++src', hpp: 'text/x-c++hdr', hh: 'text/x-c++hdr',
  cs: 'text/x-csharp', sql: 'application/sql', wasm: 'application/wasm', diff: 'text/x-diff', patch: 'text/x-diff',
  // Images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', apng: 'image/apng',
  bmp: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop',
  ai: 'application/illustrator', eps: 'application/postscript', dxf: 'image/vnd.dxf', dwg: 'image/vnd.dwg',
  // Audio
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mid: 'audio/midi', midi: 'audio/midi', weba: 'audio/webm', amr: 'audio/amr', aif: 'audio/aiff',
  aiff: 'audio/aiff', caf: 'audio/x-caf',
  // Video
  mp4: 'video/mp4', m4v: 'video/mp4', mpg: 'video/mpeg', mpeg: 'video/mpeg', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', qt: 'video/quicktime',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ogv: 'video/ogg',
  // Fonts
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  pfa: 'application/x-font', pfb: 'application/x-font', bdf: 'application/x-font-bdf',
  // Archives / binaries
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', bz2: 'application/x-bzip2',
  xz: 'application/x-xz', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  tar: 'application/x-tar', br: 'application/x-brotli', iso: 'application/x-iso9660-image',
  dmg: 'application/x-apple-diskimage', bin: 'application/octet-stream', exe: 'application/x-msdownload',
  dll: 'application/x-msdownload', msi: 'application/x-msi', deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm', jar: 'application/java-archive', war: 'application/java-archive',
  class: 'application/java-vm', apk: 'application/vnd.android.package-archive',
  // Documents / office
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  // Data / misc
  sqlite: 'application/vnd.sqlite3', db: 'application/octet-stream', sqlmap: 'text/xml',
  swf: 'application/x-shockwave-flash', ps: 'application/postscript', vcf: 'text/vcard',
  vtt: 'text/vtt', srt: 'application/x-subrip', torrent: 'application/x-bittorrent',
  ttc: 'font/collection', apkmod: 'application/octet-stream', pdb: 'application/vnd.palm',
});

/** Default cache lifetime (seconds) when none configured. */
const DEFAULT_MAX_AGE = 0;

/**
 * Look up the MIME type for a path or extension.
 * @param {string} fileOrExt Path, filename or bare extension (no dot needed).
 * @returns {string} MIME type, defaulting to `application/octet-stream`.
 *
 * @example
 * lookupMime('index.html');     // 'text/html'
 * lookupMime('.png');           // 'image/png'
 * lookupMime('unknown.zzz');    // 'application/octet-stream'
 */
export function lookupMime(fileOrExt) {
  if (!fileOrExt) return 'application/octet-stream';
  const base = String(fileOrExt).split(/[\\/]/).pop() || '';
  const ext = (base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * True when the MIME type should carry an explicit charset.
 * @param {string} mime
 * @returns {boolean}
 */
export function needsCharset(mime) {
  return /^text\//i.test(mime) || /^(application\/(json|javascript|xml|x-www-form-urlencoded|yaml|toml))/i.test(mime);
}

/**
 * Decode a URL path segment, tolerating malformed sequences.
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
 * Create static file serving middleware.
 *
 * @param {string} root Root directory (absolute or relative to cwd).
 * @param {object} [options]
 * @param {string|string[]} [options.index='index.html'] Directory index file(s).
 * @param {number} [options.maxAge=0] Cache-Control max-age in seconds.
 * @param {boolean} [options.immutable=false] Append `immutable` to Cache-Control.
 * @param {boolean} [options.dotfiles=false] Serve dotfiles (default: deny → 403).
 * @param {string[]} [options.extensions] Suffixes tried when the path misses
 *   (e.g. `['html']` makes `/about` resolve to `/about.html`).
 * @param {boolean} [options.fallthrough=true] Call `next()` when no file
 *   matches; when false a 404 error is thrown instead.
 * @param {string} [options.cacheControl] Full override of Cache-Control.
 * @param {boolean} [options.etag=true] Send strong ETags.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.use(createStatic('./public', {
 *   maxAge: 86400,
 *   extensions: ['html'],
 *   skip: undefined,
 * }));
 */
export function createStatic(root, options = {}) {
  const rootDir = path.resolve(root);
  const indexes = options.index === false ? [] : Array.isArray(options.index) ? options.index : [options.index || 'index.html'];
  const maxAge = Number.isFinite(options.maxAge) ? Math.floor(options.maxAge) : DEFAULT_MAX_AGE;
  const immutable = options.immutable === true;
  const allowDotfiles = options.dotfiles === true;
  const extensions = Array.isArray(options.extensions) ? options.extensions : [];
  const fallthrough = options.fallthrough !== false;
  const cacheControl = options.cacheControl || (maxAge > 0 ? `public, max-age=${maxAge}${immutable ? ', immutable' : ''}` : maxAge === 0 && options.cacheControl !== undefined ? 'no-cache' : undefined);

  return async function staticMiddleware(ctx, next) {
    const { req, res } = ctx;
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const decoded = safeDecode(req.path);
    if (decoded.includes('\0')) {
      if (fallthrough) return next();
      throw new BadRequestError('Null byte in path');
    }

    // Traversal protection: the resolved path must stay inside root
    const relative = decoded.replace(/^\/+/, '');
    const target = path.resolve(rootDir, relative);
    if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
      throw new ForbiddenError('Path traversal detected');
    }
    if (!allowDotfiles && relative.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
      throw new ForbiddenError('Dotfiles are not served');
    }

    let stat = await statOrNull(target);
    let filePath = target;

    if (stat && stat.isDirectory()) {
      for (const indexName of indexes) {
        const candidate = path.join(target, indexName);
        const indexStat = await statOrNull(candidate);
        if (indexStat && indexStat.isFile()) {
          filePath = candidate;
          stat = indexStat;
          break;
        }
      }
      if (!stat || stat.isDirectory()) {
        if (fallthrough) return next();
        throw new NotFoundError('Directory listing is disabled');
      }
    }

    if (!stat) {
      for (const ext of extensions) {
        const candidate = `${target}.${String(ext).replace(/^\./, '')}`;
        const candidateStat = await statOrNull(candidate);
        if (candidateStat && candidateStat.isFile()) {
          filePath = candidate;
          stat = candidateStat;
          break;
        }
      }
    }

    if (!stat) {
      if (fallthrough) return next();
      throw new NotFoundError(`Not found: ${decoded}`);
    }

    const mime = lookupMime(filePath);
    res.set('Content-Type', needsCharset(mime) ? `${mime}; charset=utf-8` : mime);
    if (cacheControl) res.set('Cache-Control', cacheControl);

    // sendFile() computes the ETag and honours If-None-Match / Range itself;
    // dotfiles were already authorised (or not) by this middleware.
    await res.sendFile(filePath, {
      root: undefined,
      etag: options.etag,
      cacheControl: undefined,
      headers: {},
      dotfiles: allowDotfiles,
    });
  };
}

/**
 * Stat a path, returning null instead of throwing.
 * @param {string} p
 * @returns {Promise<import('node:fs').Stats|null>}
 */
async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}
