/**
 * @module middleware
 *
 * Middleware composition utilities. A middleware is an async function
 * `(ctx, next) => Promise<void>`; calling `next()` runs the rest of the
 * chain. Errors thrown anywhere bubble up to the framework error handler.
 *
 * @example
 * import { compose, Pipeline, mount } from 'webcraft/lib/middleware.js';
 *
 * const chain = compose([timing, auth, handler]);
 * await chain(ctx);
 */

import { normalizePath } from './router.js';

/**
 * Compose middleware into a single function.
 *
 * @param {Array<function(import('./webcraft.js').Context, function(): Promise<void>): *>} middleware
 * @returns {function(import('./webcraft.js').Context, function(): Promise<void>=): Promise<void>}
 * @throws {TypeError} When the middleware list is invalid.
 *
 * @example
 * const chain = compose([logger, auth, handler]);
 * await chain(ctx); // handler runs last
 */
export function compose(middleware) {
  if (!Array.isArray(middleware)) throw new TypeError('Middleware stack must be an array');
  for (const fn of middleware) {
    if (typeof fn !== 'function') throw new TypeError(`Middleware must be functions, got ${typeof fn}`);
  }

  return function composed(context, next) {
    let index = -1;
    /**
     * @param {number} i
     * @returns {Promise<void>}
     */
    function dispatch(i) {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;
      const fn = i === middleware.length ? next : middleware[i];
      if (!fn) return Promise.resolve();
      try {
        return Promise.resolve(fn(context, dispatch.bind(null, i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return dispatch(0);
  };
}

/**
 * An ordered, mutable middleware collection. Applications own one Pipeline
 * for app-level middleware and add route-scoped middleware per route.
 */
export class Pipeline {
  constructor() {
    /** @type {Function[]} */
    this.stack = [];
  }

  /**
   * Append a middleware to the end of the pipeline.
   * @param {Function} fn `(ctx, next) => *`
   * @returns {Pipeline} this
   */
  use(fn) {
    if (typeof fn !== 'function') throw new TypeError(`use() expects a function, got ${typeof fn}`);
    this.stack.push(fn);
    return this;
  }

  /**
   * Prepend a middleware (runs before everything registered so far).
   * @param {Function} fn
   * @returns {Pipeline} this
   */
  prepend(fn) {
    if (typeof fn !== 'function') throw new TypeError(`prepend() expects a function, got ${typeof fn}`);
    this.stack.unshift(fn);
    return this;
  }

  /**
   * Register several middlewares at once.
   * @param {...Function} fns
   * @returns {Pipeline} this
   */
  useAll(...fns) {
    for (const fn of fns) this.use(fn);
    return this;
  }

  /**
   * Run the pipeline against a context.
   * @param {object} ctx
   * @param {function(object): Promise<void>} [final] Terminal handler invoked
   *   when every middleware called `next()`.
   * @returns {Promise<void>}
   */
  run(ctx, final) {
    return compose(this.stack)(ctx, final);
  }

  /** Number of registered middlewares. */
  get length() {
    return this.stack.length;
  }

  /** Remove every middleware. */
  clear() {
    this.stack.length = 0;
  }
}

/**
 * Mount an application or handler under a path prefix. When the incoming
 * path matches, the prefix is stripped and control is delegated; the
 * remainder of the parent chain is *not* executed.
 *
 * @param {string} prefix Mount point, e.g. '/api'.
 * @param {object|Function} target A webcraft application (needs
 *   `handleRequest`) or an async `(ctx, next)` function.
 * @returns {(ctx: object, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * const api = createApp();
 * api.get('/users', listUsers);
 * app.use(mount('/api', api));
 */
export function mount(prefix, target) {
  if (typeof target !== 'function' && typeof target.handleRequest !== 'function') {
    throw new TypeError('mount() expects an app or middleware function');
  }
  const base = normalizePath(prefix);

  return async function mounted(ctx, next) {
    const path = ctx.req.path;
    const matches = path === base || path.startsWith(`${base}/`);
    if (!matches) return next();

    const rest = path.slice(base.length) || '/';
    if (typeof target.handleRequest === 'function') {
      // app.handle() applies the path override before dispatching.
      await target.handle(ctx.req.raw, ctx.res.raw, { path: rest });
      return undefined;
    }
    // Function targets see the stripped path for the duration of the call.
    const previousOverride = ctx.req.overridePath;
    ctx.req.overridePath = rest;
    ctx.mountPrefix = base;
    ctx.mountPath = rest;
    try {
      return await target(ctx, next);
    } finally {
      ctx.req.overridePath = previousOverride;
    }
  };
}

/**
 * Branch middleware: run one of two chains depending on a predicate.
 * Useful for request-scoped behaviour without duplicating registration.
 *
 * @param {function(object): boolean} predicate
 * @param {Function} ifMiddleware Runs when the predicate is true.
 * @param {Function} [elseMiddleware] Runs otherwise (optional).
 * @returns {Function} Composed middleware.
 */
export function branch(predicate, ifMiddleware, elseMiddleware) {
  return async function branched(ctx, next) {
    if (predicate(ctx)) {
      await compose([ifMiddleware])(ctx, next);
    } else if (elseMiddleware) {
      await compose([elseMiddleware])(ctx, next);
    } else {
      return next();
    }
    return undefined;
  };
}
