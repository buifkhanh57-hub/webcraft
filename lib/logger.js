/**
 * @module logger
 *
 * Tiny colourised logger plus a request-logging middleware. Levels are
 * ordered (trace < debug < info < warn < error < fatal) and everything below
 * the configured threshold is suppressed.
 *
 * @example
 * import { createLogger, requestLogger } from 'webcraft/lib/logger.js';
 *
 * const log = createLogger({ level: 'info' });
 * log.info('server started on port %d', 3000);
 *
 * app.use(requestLogger(log));
 */

import { inspect } from 'node:util';

/** Numeric priority per level. */
export const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/** ANSI escape sequences used when colour is enabled. */
const COLORS = Object.freeze({
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
});

const RESET = '\x1b[0m';

/**
 * Resolve whether ANSI colours should be used.
 * @param {boolean|'auto'} colorize
 * @param {NodeJS.WriteStream} stream
 * @returns {boolean}
 */
function resolveColor(colorize, stream) {
  if (colorize === true) return true;
  if (colorize === false) return false;
  return Boolean(stream.isTTY) && process.env.FORCE_COLOR !== '0' && process.env.NO_COLOR === undefined;
}

/**
 * Format a timestamp as local HH:MM:SS.mmm.
 * @param {Date} [date]
 * @returns {string}
 */
export function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

/**
 * Create a logger instance.
 *
 * @param {object} [options]
 * @param {'trace'|'debug'|'info'|'warn'|'error'|'fatal'} [options.level='info']
 *   Minimum level that will be emitted.
 * @param {boolean|'auto'} [options.colorize='auto'] Use ANSI colours.
 * @param {NodeJS.WriteStream} [options.stream=process.stderr] Output stream.
 * @param {string} [options.prefix] Static prefix prepended to every line.
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const levelName = LEVELS[options.level] !== undefined ? options.level : 'info';
  const threshold = LEVELS[levelName];
  const stream = options.stream || process.stderr;
  const useColor = resolveColor(options.colorize === undefined ? 'auto' : options.colorize, stream);
  const prefix = options.prefix ? `[${options.prefix}] ` : '';

  /**
   * @typedef {object} Logger
   * @property {function(...*): void} trace
   * @property {function(...*): void} debug
   * @property {function(...*): void} info
   * @property {function(...*): void} warn
   * @property {function(...*): void} error
   * @property {function(...*): void} fatal
   * @property {function(string): Logger} child
   * @property {function(string): boolean} isEnabled
   */

  /**
   * Emit one formatted line.
   * @param {keyof typeof LEVELS} level
   * @param {*[]} args
   */
  function emit(level, args) {
    if (LEVELS[level] < threshold) return;
    const message = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        return inspect(arg, { depth: 4, breakLength: 120 });
      })
      .join(' ');
    const stamp = timestamp();
    const lvl = level.toUpperCase().padEnd(5, ' ');
    if (useColor) {
      stream.write(`${COLORS[level]}${stamp}${RESET} ${COLORS[level]}${lvl}${RESET} ${prefix}${message}\n`);
    } else {
      stream.write(`${stamp} ${lvl} ${prefix}${message}\n`);
    }
  }

  /** @type {Logger} */
  const logger = {
    trace: (...args) => emit('trace', args),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    fatal: (...args) => emit('fatal', args),
    child: (childPrefix) => createLogger({ ...options, prefix: options.prefix ? `${options.prefix}${childPrefix}` : childPrefix }),
    isEnabled: (name) => LEVELS[name] !== undefined && LEVELS[name] >= threshold,
  };
  return logger;
}

/**
 * Colourise an HTTP status code.
 * @param {number} status
 * @param {boolean} useColor
 * @returns {string}
 */
function colorStatus(status, useColor) {
  const code = String(status);
  if (!useColor) return code;
  if (status >= 500) return `\x1b[31m${code}${RESET}`;
  if (status >= 400) return `\x1b[33m${code}${RESET}`;
  if (status >= 300) return `\x1b[36m${code}${RESET}`;
  if (status >= 200) return `\x1b[32m${code}${RESET}`;
  return code;
}

/**
 * Format a byte count for logs (e.g. "1.2kb").
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '-';
  if (bytes === 0) return '0b';
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

/**
 * Create a request logging middleware.
 *
 * @param {Logger} [logger] Logger produced by {@link createLogger}.
 * @param {object} [options]
 * @param {function(import('./webcraft.js').Context): boolean} [options.skip]
 *   Return true to skip logging for a request (e.g. health checks).
 * @param {function(object): string} [options.format] Custom formatter receiving
 *   `{ method, url, status, ms, bytes, ip, color }` and returning the line.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.use(requestLogger(log, { skip: (ctx) => ctx.req.path === '/health' }));
 */
export function requestLogger(logger = createLogger({ level: 'info' }), options = {}) {
  const skip = typeof options.skip === 'function' ? options.skip : null;
  const format = typeof options.format === 'function' ? options.format : null;
  const useColor = Boolean(logger.isEnabled && logger.isEnabled('info') && process.stdout.isTTY !== false && options.colorize !== false);

  return function requestLoggingMiddleware(ctx, next) {
    const start = process.hrtime.bigint();
    const { req } = ctx;
    const res = ctx.res.raw;

    const onFinished = () => {
      res.removeListener('finish', onFinished);
      res.removeListener('close', onFinished);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const info = {
        method: req.method,
        url: req.originalUrl || req.url,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        bytes: Number(res.getHeader('Content-Length')) || undefined,
        ip: req.ip,
        color: useColor,
      };
      if (skip && skip(ctx)) return;
      const line = format ? format(info) : `${info.method} ${info.url} ${colorStatus(info.status, useColor)} ${info.ms}ms ${formatBytes(info.bytes)}`;
      if (info.status >= 500) logger.error(line);
      else if (info.status >= 400) logger.warn(line);
      else logger.info(line);
    };

    res.on('finish', onFinished);
    res.on('close', onFinished);
    return next();
  };
}
