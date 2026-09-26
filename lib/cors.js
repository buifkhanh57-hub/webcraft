/**
 * @module cors
 *
 * Cross-Origin Resource Sharing middleware with preflight support.
 *
 * @example
 * import { cors } from 'webcraft/lib/cors.js';
 *
 * app.use(cors({ origin: 'https://app.example.com', credentials: true }));
 */

/**
 * Normalise an origin option into a resolved `Access-Control-Allow-Origin`
 * value for the current request.
 *
 * @param {string|RegExp|string[]|boolean|function(string, object): (string|boolean)} origin
 * @param {string|undefined} reqOrigin The request `Origin` header.
 * @param {object} ctx The webcraft context.
 * @returns {string|false} Header value or false to omit.
 */
function resolveOrigin(origin, reqOrigin, ctx) {
  if (origin === true) return reqOrigin || '*';
  if (origin === false) return false;
  if (origin === '*') return reqOrigin === undefined ? '*' : reqOrigin || '*';
  if (!reqOrigin) return false;
  if (typeof origin === 'string') return origin === reqOrigin ? reqOrigin : false;
  if (origin instanceof RegExp) return origin.test(reqOrigin) ? reqOrigin : false;
  if (Array.isArray(origin)) return origin.includes(reqOrigin) ? reqOrigin : false;
  if (typeof origin === 'function') {
    const result = origin(reqOrigin, ctx);
    if (result === true) return reqOrigin;
    if (result === false || result === undefined || result === null) return false;
    return String(result);
  }
  return false;
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
  if (Array.isArray(existing)) {
    const set = new Set(existing.flatMap((v) => String(v).split(',').map((s) => s.trim())).filter(Boolean));
    set.add(value);
    return [...set].join(', ');
  }
  const set = new Set(String(existing).split(',').map((s) => s.trim()).filter(Boolean));
  set.add(value);
  return [...set].join(', ');
}

/**
 * Create the CORS middleware.
 *
 * @param {object} [options]
 * @param {string|RegExp|string[]|boolean|function} [options.origin='*']
 *   Allowed origin(s). Functions receive `(requestOrigin, ctx)` and return
 *   the resolved origin, `true` (echo), or `false` (deny).
 * @param {string|string[]} [options.methods='GET,HEAD,PUT,PATCH,POST,DELETE']
 *   Methods advertised for preflight requests.
 * @param {string|string[]} [options.allowedHeaders] Preflight header whitelist.
 *   Defaults to echoing `Access-Control-Request-Headers`.
 * @param {string|string[]} [options.exposedHeaders] Headers readable by JS.
 * @param {boolean} [options.credentials=false] Allow cookies/credentials.
 * @param {number} [options.maxAge] Preflight cache duration in seconds.
 * @param {boolean} [options.preflightContinue=false] Call `next()` on OPTIONS
 *   instead of terminating with a 204.
 * @param {number} [options.optionsSuccessStatus=204] Status for preflight.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.use(cors({
 *   origin: [/\.example\.com$/, 'https://admin.example.com'],
 *   credentials: true,
 *   maxAge: 86_400,
 * }));
 */
export function cors(options = {}) {
  const {
    origin = '*',
    methods = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    allowedHeaders,
    exposedHeaders,
    credentials = false,
    maxAge,
    preflightContinue = false,
    optionsSuccessStatus = 204,
  } = options;

  const methodsValue = Array.isArray(methods) ? methods.join(', ') : String(methods);
  const exposedValue = exposedHeaders ? (Array.isArray(exposedHeaders) ? exposedHeaders.join(', ') : String(exposedHeaders)) : null;
  const maxAgeValue = maxAge !== undefined ? String(Math.floor(Number(maxAge))) : null;

  return async function corsMiddleware(ctx, next) {
    const req = ctx.req;
    const res = ctx.res;
    const requestOrigin = req.headers.origin;
    const allowOrigin = resolveOrigin(origin, requestOrigin, ctx);

    if (allowOrigin) {
      res.set('Access-Control-Allow-Origin', allowOrigin);
      res.set('Vary', appendVary(res.raw, 'Origin'));
      if (credentials) res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (exposedValue) res.set('Access-Control-Expose-Headers', exposedValue);

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', methodsValue);
      if (allowedHeaders) {
        const value = Array.isArray(allowedHeaders) ? allowedHeaders.join(', ') : String(allowedHeaders);
        res.set('Access-Control-Allow-Headers', value);
      } else if (req.headers['access-control-request-headers']) {
        res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
      }
      if (maxAgeValue) res.set('Access-Control-Max-Age', maxAgeValue);
      if (preflightContinue) return next();
      res.status(optionsSuccessStatus);
      res.raw.end();
      return;
    }

    return next();
  };
}
