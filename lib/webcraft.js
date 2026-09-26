/**
 * @module webcraft
 *
 * The application factory: composes the router, middleware pipeline, request/
 * response wrappers, templates, sessions and the HTTP server into one object.
 *
 * @example
 * import { createApp } from 'webcraft';
 *
 * const app = createApp();
 * app.get('/hello/:name', (ctx) => ctx.res.text(`Hello ${ctx.params.name}!`));
 * await app.listen(3000);
 */

import { Router } from './router.js';
import { Pipeline, compose, mount } from './middleware.js';
import { Request } from './request.js';
import { Response } from './response.js';
import { createLogger } from './logger.js';
import { createStatic } from './static.js';
import { session } from './session.js';
import { TemplateEngine } from './template.js';
import { createServer, listen as listenServer, closeGracefully } from './server.js';
import {
  HttpError,
  NotFoundError,
  MethodNotAllowedError,
  ServiceUnavailableError,
  isHttpError,
} from './errors.js';

/** Framework version, mirrored from package.json. */
export const VERSION = '1.0.0';

/**
 * Escape a string for embedding into the built-in HTML error pages.
 * @param {*} value
 * @returns {string}
 */
function escapeForHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Build the default HTML error/404 page.
 * @param {number} status
 * @param {string} title
 * @param {string} message
 * @param {boolean} [showStack=false]
 * @param {string} [stack]
 * @returns {string}
 */
function errorPage(status, title, message, showStack = false, stack = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} · ${escapeForHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f7f9; color: #1f2937;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.08);
          padding: 48px; max-width: 560px; text-align: center; }
  .code { font-size: 72px; font-weight: 700; color: #6366f1; margin: 0; }
  h1 { font-size: 22px; margin: 8px 0 16px; }
  p { color: #6b7280; line-height: 1.6; margin: 0; }
  pre { text-align: left; background: #111827; color: #e5e7eb; padding: 16px; border-radius: 8px;
        overflow: auto; font-size: 12px; margin-top: 24px; }
  footer { margin-top: 24px; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <p class="code">${status}</p>
    <h1>${escapeForHtml(title)}</h1>
    <p>${escapeForHtml(message)}</p>
    ${showStack && stack ? `<pre>${escapeForHtml(stack)}</pre>` : ''}
    <footer>webcraft · Node.js</footer>
  </div>
</body>
</html>`;
}

/**
 * The application object returned by {@link createApp}.
 *
 * @typedef {object} WebcraftApp
 * @property {object} config Runtime configuration.
 * @property {Router} router Route registry.
 * @property {Pipeline} pipeline App-level middleware.
 * @property {object} logger Framework logger.
 * @property {object} locals Data merged into every rendered template.
 * @property {function(Function): WebcraftApp} use Register app middleware.
 * @property {function(string, ...Function): object} get
 * @property {function(string, ...Function): object} post
 * @property {function(string, ...Function): object} put
 * @property {function(string, ...Function): object} patch
 * @property {function(string, ...Function): object} delete
 * @property {function(string, ...Function): object} head
 * @property {function(string, ...Function): object} options
 * @property {function(string, ...Function): object} all
 * @property {function(string, function(Router): void): Router} group
 * @property {function(string, object=): object} static Serve a directory.
 * @property {function(object=): object} session Enable cookie sessions.
 * @property {function(object=): TemplateEngine} engine Configure templates.
 * @property {function(Function): WebcraftApp} onError Global error hook.
 * @property {function(Function): WebcraftApp} notFound Custom 404 renderer.
 * @property {function(number, string=, object=): Promise<void>} handleRequest
 * @property {function(number, string=): Promise<{server, port, url, close}>} listen
 * @property {function(object=): Promise<void>} close
 */

/**
 * Create a webcraft application.
 *
 * @param {object} [options]
 * @param {string} [options.env] Environment ('development' | 'production' | 'test').
 * @param {Router} [options.router] Inject a pre-built router.
 * @param {object} [options.logger] Logger instance ({@link module:logger}).
 * @param {number} [options.maxBodySize=1048576] Default body size limit (bytes).
 * @param {object} [options.server] Timeout overrides passed to the HTTP server.
 * @returns {WebcraftApp}
 *
 * @example
 * const app = createApp({ env: 'production' });
 * app.use(requestLogger(app.logger));
 * app.get('/', (ctx) => ctx.res.json({ ok: true }));
 * app.listen(3000);
 */
export function createApp(options = {}) {
  const env = options.env || process.env.NODE_ENV || 'development';
  const isDev = env === 'development' || env === 'test';
  const config = {
    env,
    maxBodySize: Number.isFinite(options.maxBodySize) ? options.maxBodySize : 1024 * 1024,
    server: options.server || {},
  };

  const router = options.router instanceof Router ? options.router : new Router();
  const pipeline = new Pipeline();
  const logger = options.logger || createLogger({ level: env === 'production' ? 'info' : 'debug' });
  const locals = {};

  let templateEngine = null;
  let errorHandler = null;
  let notFoundRenderer = null;
  let serverRef = null;
  let stopping = false;

  /** @type {WebcraftApp} */
  const app = {
    config,
    router,
    pipeline,
    logger,
    locals,
    VERSION,

    use(fn) {
      pipeline.use(fn);
      return app;
    },

    get(pattern, ...handlers) { return router.add('GET', pattern, ...handlers); },
    post(pattern, ...handlers) { return router.add('POST', pattern, ...handlers); },
    put(pattern, ...handlers) { return router.add('PUT', pattern, ...handlers); },
    patch(pattern, ...handlers) { return router.add('PATCH', pattern, ...handlers); },
    delete(pattern, ...handlers) { return router.add('DELETE', pattern, ...handlers); },
    head(pattern, ...handlers) { return router.add('HEAD', pattern, ...handlers); },
    options(pattern, ...handlers) { return router.add('OPTIONS', pattern, ...handlers); },
    all(pattern, ...handlers) { return router.add('*', pattern, ...handlers); },

    group(prefix, fn) {
      return router.group(prefix, fn);
    },

    static(root, opts = {}) {
      return app.use(createStatic(root, opts));
    },

    session(opts = {}) {
      return app.use(session(opts));
    },

    engine(opts = {}) {
      if (!templateEngine) {
        templateEngine = new TemplateEngine(opts);
      } else if (opts.root && !templateEngine.root) {
        templateEngine.root = opts.root;
      }
      return templateEngine;
    },

    onError(fn) {
      if (typeof fn !== 'function') throw new TypeError('onError() expects a function');
      errorHandler = fn;
      return app;
    },

    notFound(fn) {
      if (typeof fn !== 'function') throw new TypeError('notFound() expects a function');
      notFoundRenderer = fn;
      return app;
    },

    url(name, params, query) {
      return router.url(name, params, query);
    },

    route(name) {
      return router.route(name);
    },

    describeRoutes() {
      return router.describe();
    },

    /**
     * Build a request context (exposed for testing and custom servers).
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {object}
     */
    createContext(req, res) {
      const request = new Request(req);
      request.overridePath = req.__webcraftPath || null;
      request.defaultBodyLimit = config.maxBodySize;
      const response = new Response(res, req);
      /** @type {object} */
      const ctx = {
        app,
        req: request,
        res: response,
        state: {},
        params: {},
        route: null,
        session: null,
        data: null,
      };
      // Convenience shortcuts onto the context itself
      ctx.set = (...args) => response.set(...args);
      ctx.status = (code) => response.setStatus(code);
      ctx.json = (data, status) => response.json(data, status);
      ctx.html = (markup, status) => response.html(markup, status);
      ctx.text = (text, status) => response.text(text, status);
      ctx.send = (body) => response.send(body);
      ctx.redirect = (url, status) => response.redirect(url, status);
      ctx.render = async (name, data = {}) => {
        if (!templateEngine) {
          throw new HttpError(500, 'No template engine configured — call app.engine() first');
        }
        const markup = await templateEngine.render(name, { ...locals, ...data });
        return response.html(markup);
      };
      return ctx;
    },

    /**
     * Handle a raw HTTP request without listening (tests, mounting).
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {object} [opts]
     * @param {string} [opts.path] Override the request path (mounting).
     * @returns {Promise<void>}
     */
    async handle(req, res, opts = {}) {
      if (opts.path) req.__webcraftPath = opts.path;
      return app.handleRequest(req, res);
    },

    async handleRequest(req, res) {
      if (stopping && !res.headersSent) {
        const err = new ServiceUnavailableError('Server is shutting down');
        return renderError(app.createContext(req, res), err);
      }
      const ctx = app.createContext(req, res);
      try {
        await pipeline.run(ctx, dispatch);
      } catch (err) {
        await renderError(ctx, err);
      }
    },

    /**
     * Start the HTTP server.
     * @param {number} port
     * @param {string} [host='0.0.0.0']
     * @returns {Promise<{server: import('node:http').Server, port: number, host: string, url: string, close: function(object=): Promise<void>}>}
     */
    async listen(port, host = '0.0.0.0') {
      const server = createServer(app, config.server);
      const address = await listenServer(server, port, host);
      serverRef = server;
      logger.info(`webcraft ${VERSION} listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${address.port} (${env})`);
      return {
        server,
        port: address.port,
        host,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${address.port}`,
        async close(opts = {}) {
          await closeGracefully(server, opts);
        },
      };
    },

    /**
     * Close the most recently started server.
     * @param {object} [opts]
     * @returns {Promise<void>}
     */
    async close(opts = {}) {
      stopping = true;
      if (serverRef) {
        await closeGracefully(serverRef, opts);
        stopping = false;
        serverRef = null;
      }
    },
  };

  /**
   * Terminal handler: translate a router match into a response.
   * @param {object} ctx
   */
  async function dispatch(ctx) {
    const match = router.find(ctx.req.method, ctx.req.path);
    if (match === null) {
      if (notFoundRenderer) {
        ctx.params = {};
        await notFoundRenderer(ctx);
        if (!ctx.res.writableEnded) ctx.res.status(404).end();
        return;
      }
      throw new NotFoundError(`Cannot ${ctx.req.method} ${ctx.req.path}`);
    }
    if (match.methodMismatch) {
      const err = new MethodNotAllowedError(match.allowed);
      throw err;
    }
    ctx.params = match.params;
    ctx.route = match.route;
    const stack = match.route.middleware.length > 0 ? [...match.route.middleware, match.route.handler] : [match.route.handler];
    await compose(stack)(ctx);
  }

  /**
   * Turn any thrown value into an HTTP response.
   * @param {object} ctx
   * @param {*} thrown
   */
  async function renderError(ctx, thrown) {
    const error = isHttpError(thrown) ? thrown : HttpError.from(thrown);

    if (ctx.res.headersSent) {
      ctx.res.raw.destroy();
      return;
    }
    if (errorHandler) {
      try {
        await errorHandler(error, ctx);
        if (ctx.res.writableEnded) return;
      } catch (hookErr) {
        logger.error('onError handler threw:', hookErr);
      }
    }
    if (error.status >= 500) logger.error(`${error.status} ${ctx.req.method} ${ctx.req.path}:`, thrown instanceof Error ? (thrown.stack || thrown.message) : thrown);
    else logger.warn(`${error.status} ${ctx.req.method} ${ctx.req.path}: ${error.message}`);

    for (const [name, value] of Object.entries(error.headers)) {
      if (!ctx.res.has(name)) ctx.res.set(name, value);
    }

    const wantsJson = ctx.req.accepts('json', 'html') === 'json' || !ctx.req.headers.accept;
    if (wantsJson) {
      const payload = error.toJSON(isDev);
      ctx.res.status(error.status).json(payload);
      return;
    }
    const message = error.expose || isDev ? error.message : 'An unexpected error occurred.';
    const stack = isDev && thrown instanceof Error ? thrown.stack : '';
    const titles = { 404: 'Page not found', 405: 'Method not allowed', 410: 'Gone' };
    const html = errorPage(error.status, titles[error.status] || errorStatusTitle(error.status), message, Boolean(stack), stack);
    ctx.res.status(error.status).html(html);
  }

  return app;
}

/**
 * Human title for a status code (used on the default error page).
 * @param {number} status
 * @returns {string}
 */
export function errorStatusTitle(status) {
  const titles = {
    400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found',
    405: 'Method not allowed', 408: 'Request timeout', 409: 'Conflict',
    413: 'Payload too large', 415: 'Unsupported media type', 422: 'Validation failed',
    429: 'Too many requests', 500: 'Something went wrong', 501: 'Not implemented',
    503: 'Service unavailable',
  };
  return titles[status] || 'Error';
}

export { Router, Pipeline, compose, mount, Request, Response, TemplateEngine, HttpError, isHttpError };
export default createApp;
