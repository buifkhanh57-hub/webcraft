/**
 * @module router
 *
 * HTTP router with path parameters, wildcards, route groups, named routes
 * and 405 (Method Not Allowed) detection. Routes are matched in insertion
 * order and patterns are compiled to regular expressions once.
 *
 * Supported syntax:
 *   /users/:id          → params.id = one segment
 *   /files/*path        → params.path = the rest of the path (may contain "/")
 *   /static/file.png    → literal segments (regex-special chars are escaped)
 *
 * @example
 * const router = new Router();
 * router.get('/hello/:name', (ctx) => ctx.res.text(`Hello ${ctx.params.name}`));
 * router.group('/admin', (admin) => {
 *   admin.get('/dashboard', showDashboard, { name: 'admin.dashboard' });
 * });
 * router.url('admin.dashboard'); // '/admin/dashboard'
 */

/** HTTP methods understood by the router. */
export const HTTP_METHODS = Object.freeze([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE',
]);

/** Matches a legal route parameter name. */
const PARAM_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Escape a literal string for embedding in a regular expression.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a URL path for matching: collapse to a single trailing slash
 * rule by removing any trailing slash (except on the root path).
 * @param {string} pathname
 * @returns {string}
 */
export function normalizePath(pathname) {
  if (!pathname) return '/';
  let p = String(pathname);
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

/**
 * Safely decode a path segment, keeping the raw value on malformed input.
 * @param {string} value
 * @returns {string}
 */
export function safeDecodeSegment(value) {
  if (!value.includes('%') && !value.includes('+')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Compile a route pattern into a regular expression plus a key map.
 *
 * @param {string} pattern Route pattern, e.g. `/posts/:id` or `/files/*rest`.
 * @param {object} [options]
 * @param {boolean} [options.ignoreCase=true] Case-insensitive matching.
 * @returns {{regex: RegExp, keys: Array<{name: string, wildcard: boolean}>}}
 * @throws {TypeError} When the pattern is not a string or a param name is invalid.
 *
 * @example
 * const { regex, keys } = compilePath('/users/:id/files/*rest');
 * regex.test('/users/42/files/a/b.txt'); // true
 * keys; // [{name:'id',wildcard:false},{name:'rest',wildcard:true}]
 */
export function compilePath(pattern, options = {}) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError(`Route pattern must be a non-empty string, got: ${typeof pattern}`);
  }
  const ignoreCase = options.ignoreCase !== false;
  const source = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const keys = [];
  let rx = '^';
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === ':') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const name = source.slice(i + 1, j);
      if (!name || !PARAM_NAME_RE.test(name)) {
        throw new TypeError(`Invalid parameter name in pattern "${pattern}"`);
      }
      keys.push({ name, wildcard: false });
      rx += '([^/]+)';
      i = j;
      continue;
    }
    if (ch === '*') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const name = source.slice(i + 1, j) || 'wildcard';
      if (name !== 'wildcard' && !PARAM_NAME_RE.test(name)) {
        throw new TypeError(`Invalid wildcard name in pattern "${pattern}"`);
      }
      keys.push({ name, wildcard: true });
      rx += '(.*)';
      i = j;
      continue;
    }
    rx += escapeRegex(ch);
    i += 1;
  }

  rx += '/?$';
  return { regex: new RegExp(rx, ignoreCase ? 'i' : ''), keys };
}

/**
 * A single registered route.
 */
export class Route {
  /**
   * @param {string} method HTTP method or '*' for any method.
   * @param {string} pattern Path pattern.
   * @param {Function} handler Request handler `(ctx) => void|Promise<void>`.
   * @param {object} [options]
   * @param {string} [options.name] Route name for URL building.
   * @param {boolean} [options.ignoreCase=true]
   * @param {Function[]} [options.middleware] Route-scoped middleware.
   */
  constructor(method, pattern, handler, options = {}) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Route ${method} ${pattern} requires a handler function`);
    }
    this.method = String(method).toUpperCase();
    this.pattern = pattern.startsWith('/') ? pattern : `/${pattern}`;
    this.handler = handler;
    this.name = options.name;
    this.middleware = Array.isArray(options.middleware) ? options.middleware.slice() : [];
    const { regex, keys } = compilePath(this.pattern, { ignoreCase: options.ignoreCase });
    this.regex = regex;
    this.keys = keys;
  }

  /**
   * Test a (already normalised) pathname and extract params.
   * @param {string} pathname
   * @returns {Record<string, string>|null} Params or null when no match.
   */
  match(pathname) {
    const result = this.regex.exec(pathname);
    if (!result) return null;
    const params = Object.create(null);
    for (let i = 0; i < this.keys.length; i += 1) {
      const key = this.keys[i];
      const value = result[i + 1];
      if (value === undefined) continue;
      params[key.name] = key.wildcard ? safeDecodeSegment(value) : safeDecodeSegment(value);
    }
    return params;
  }

  /** @returns {string} Human readable identity, e.g. "GET /users/:id". */
  toString() {
    return `${this.method} ${this.pattern}`;
  }
}

/**
 * The router itself. Create one via `new Router()` or use the one owned by
 * the application (`app.get(...)` delegates here).
 */
export class Router {
  /**
   * @param {object} [options]
   * @param {string} [options.prefix=''] Prefix prepended to every pattern.
   */
  constructor(options = {}) {
    this.prefix = options.prefix ? normalizePath(options.prefix) : '';
    /** @type {Route[]} */
    this.routes = [];
    /** @type {Map<string, Route>} */
    this.named = new Map();
  }

  /**
   * Register a route for one method (or '*' for all methods).
   *
   * @param {string} method HTTP method, or '*'.
   * @param {string} pattern Path pattern.
   * @param {...Function} handlers Middleware functions followed by the final
   *   handler. At least one function is required; the last one is the handler.
   * @param {object} [options] When the last argument is an object it is
   *   treated as route options (`{ name, ignoreCase, middleware }`).
   * @returns {Route} The created route.
   * @throws {Error} When the route name is already taken.
   */
  add(method, pattern, ...handlers) {
    if (handlers.length === 0) {
      throw new TypeError(`Route ${method} ${pattern} needs at least one handler`);
    }
    let options = {};
    const last = handlers[handlers.length - 1];
    if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
      options = handlers.pop();
    }
    const middleware = handlers.slice(0, -1);
    const handler = handlers[handlers.length - 1];
    const routeOptions = {
      name: options.name,
      ignoreCase: options.ignoreCase,
      middleware: [...middleware, ...(options.middleware || [])],
    };
    const route = new Route(method, this.prefix + (pattern.startsWith('/') ? pattern : `/${pattern}`), handler, routeOptions);
    if (route.name) {
      if (this.named.has(route.name)) {
        throw new Error(`Route name "${route.name}" is already registered`);
      }
      this.named.set(route.name, route);
    }
    this.routes.push(route);
    return route;
  }

  /** Register a GET route. */
  get(pattern, ...handlers) { return this.add('GET', pattern, ...handlers); }

  /** Register a POST route. */
  post(pattern, ...handlers) { return this.add('POST', pattern, ...handlers); }

  /** Register a PUT route. */
  put(pattern, ...handlers) { return this.add('PUT', pattern, ...handlers); }

  /** Register a PATCH route. */
  patch(pattern, ...handlers) { return this.add('PATCH', pattern, ...handlers); }

  /** Register a DELETE route. */
  delete(pattern, ...handlers) { return this.add('DELETE', pattern, ...handlers); }

  /** Register a HEAD route. */
  head(pattern, ...handlers) { return this.add('HEAD', pattern, ...handlers); }

  /** Register an OPTIONS route. */
  options(pattern, ...handlers) { return this.add('OPTIONS', pattern, ...handlers); }

  /** Register a route matching ANY HTTP method. */
  all(pattern, ...handlers) { return this.add('*', pattern, ...handlers); }

  /**
   * Create a route group: every pattern registered inside `fn` is prefixed
   * with `prefix` (groups nest arbitrarily deep).
   *
   * @param {string} prefix Group prefix, e.g. '/admin'.
   * @param {function(Router): void} fn Receives the sub-router.
   * @param {object} [options] Reserved for future use.
   * @returns {Router} The sub-router (also merged into this router).
   *
   * @example
   * router.group('/api/v1', (api) => {
   *   api.get('/users', listUsers);      // GET /api/v1/users
   *   api.group('/users', (users) => {
   *     users.get('/:id', getUser);      // GET /api/v1/users/:id
   *   });
   * });
   */
  group(prefix, fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('group() requires a setup function');
    const sub = new Router({ prefix: this.prefix + normalizePath(prefix), ...options });
    fn(sub);
    for (const route of sub.routes) {
      if (route.name) {
        if (this.named.has(route.name)) throw new Error(`Route name "${route.name}" is already registered`);
        this.named.set(route.name, route);
      }
      this.routes.push(route);
    }
    return sub;
  }

  /**
   * Find a route for a method + pathname.
   *
   * @param {string} method HTTP method.
   * @param {string} pathname Raw request path.
   * @returns {{route: Route, params: object}|{methodMismatch: true, allowed: string[]}|null}
   *   A match, a 405 descriptor, or null for a plain 404.
   */
  find(method, pathname) {
    const path = normalizePath(pathname);
    const upperMethod = String(method || 'GET').toUpperCase();
    // HEAD requests are served by GET handlers; Node strips the body automatically.
    const effectiveMethod = upperMethod === 'HEAD' ? 'GET' : upperMethod;
    const allowed = new Set();
    for (const route of this.routes) {
      if (!route.regex.test(path)) continue;
      if (route.method !== '*' && route.method !== effectiveMethod) {
        allowed.add(route.method);
        if (route.method === 'GET') allowed.add('HEAD');
        continue;
      }
      const params = route.match(path);
      if (params === null) continue;
      return { route, params };
    }
    if (allowed.size > 0) {
      // A route methodMatched path but not method: also surface HEAD for GET routes
      return { methodMismatch: true, allowed: [...allowed].sort() };
    }
    return null;
  }

  /**
   * Look up a route by name.
   * @param {string} name
   * @returns {Route|undefined}
   */
  route(name) {
    return this.named.get(name);
  }

  /** @returns {boolean} Whether a named route exists. */
  has(name) {
    return this.named.has(name);
  }

  /**
   * Build a URL from a named route.
   *
   * @param {string} name Route name.
   * @param {object} [params] Values for `:param` and `*wildcard` segments.
   * @param {object|string} [query] Query object or raw query string.
   * @returns {string} The assembled URL path.
   * @throws {Error} When the route or a required parameter is missing.
   *
   * @example
   * router.get('/posts/:id', show, { name: 'posts.show' });
   * router.url('posts.show', { id: 7 });            // '/posts/7'
   * router.url('posts.show', { id: 7 }, { lang: 'en' }); // '/posts/7?lang=en'
   */
  url(name, params = {}, query) {
    const route = this.named.get(name);
    if (!route) throw new Error(`No route named "${name}"`);
    let out = route.pattern;
    for (const key of route.keys) {
      const value = params[key.name];
      if (value === undefined) {
        throw new Error(`Missing "${key.name}" parameter for route "${name}"`);
      }
      const token = key.wildcard ? `*${key.name}` : `:${key.name}`;
      const replacement = key.wildcard ? String(value) : encodeURIComponent(String(value));
      out = out.replace(token, replacement);
    }
    for (const key of route.keys) {
      const token = key.wildcard ? `*${key.name}` : `:${key.name}`;
      if (out.includes(token)) {
        throw new Error(`Parameter "${key.name}" appears twice in route "${name}"`);
      }
    }
    if (query) {
      if (typeof query === 'string') out += query.startsWith('?') ? query : `?${query}`;
      else {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
          else search.append(key, String(value));
        }
        const qs = search.toString();
        if (qs) out += `?${qs}`;
      }
    }
    return out;
  }

  /**
   * Snapshot of all routes for introspection (used by the CLI).
   * @returns {Array<{method: string, pattern: string, name: (string|undefined)}>}
   */
  describe() {
    return this.routes.map((route) => ({ method: route.method, pattern: route.pattern, name: route.name }));
  }

  /** Number of registered routes. */
  get size() {
    return this.routes.length;
  }

  /**
   * Iterate over registered routes.
   * @param {function(Route): void} fn
   */
  each(fn) {
    this.routes.forEach(fn);
  }
}
