/**
 * @module server
 *
 * HTTP server plumbing: listener creation, timeout configuration, malformed
 * request handling and graceful shutdown with connection draining.
 *
 * @example
 * import { createApp } from './webcraft.js';
 * import { createServer, closeGracefully, handleSignals } from './server.js';
 *
 * const app = createApp();
 * const server = createServer(app);
 * await listen(server, 3000);
 * handleSignals({ SIGINT: () => closeGracefully(server) });
 */

import http from 'node:http';
import { once } from 'node:events';

/** Sensible server timeout defaults (all values in milliseconds). */
export const SERVER_DEFAULTS = Object.freeze({
  requestTimeout: 30_000,
  headersTimeout: 35_000,
  keepAliveTimeout: 5_000,
  maxRequestsPerSocket: 0,
  connectionsCheckingInterval: 30_000,
  shutdownTimeout: 10_000,
});

/**
 * Create the HTTP server bound to a webcraft application.
 *
 * @param {object} app Application with an async `handle(req, res)` method.
 * @param {object} [options] Timeout overrides ({@link SERVER_DEFAULTS}).
 * @returns {import('node:http').Server}
 */
export function createServer(app, options = {}) {
  const opts = { ...SERVER_DEFAULTS, ...options };

  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((err) => {
      // Last-resort safety net: the error handler itself exploded.
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        if (!res.writableEnded) res.end('Internal Server Error');
      } catch {
        res.destroy();
      }
      if (app.logger && typeof app.logger.error === 'function') {
        app.logger.error('Unhandled request failure:', err);
      }
    });
  });

  if (opts.requestTimeout) server.requestTimeout = opts.requestTimeout;
  if (opts.headersTimeout) server.headersTimeout = opts.headersTimeout;
  if (opts.keepAliveTimeout !== undefined) server.keepAliveTimeout = opts.keepAliveTimeout;
  if (opts.maxRequestsPerSocket > 0) server.maxRequestsPerSocket = opts.maxRequestsPerSocket;
  if (opts.connectionsCheckingInterval) server.connectionsCheckingInterval = opts.connectionsCheckingInterval;

  // Malformed HTTP from clients must never crash the process.
  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    if (app.logger && typeof app.logger.error === 'function') {
      app.logger.error('Server error:', err.message);
    }
  });

  return server;
}

/**
 * Start listening and resolve once the port is bound.
 *
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} [host] Defaults to all interfaces.
 * @returns {Promise<{address: string, family: string, port: number}>}
 */
export async function listen(server, port, host) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(`Invalid port: ${port}`);
  }
  server.listen(port, host);
  await once(server, 'listening');
  return server.address();
}

/**
 * Close the server gracefully: stop accepting new connections, give in-flight
 * requests time to finish, then force-close whatever is left.
 *
 * @param {import('node:http').Server} server
 * @param {object} [options]
 * @param {number} [options.timeout=10000] Max wait in ms before destroying.
 * @returns {Promise<void>}
 */
export async function closeGracefully(server, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : SERVER_DEFAULTS.shutdownTimeout;
  if (!server.listening) return;
  try {
    server.closeIdleConnections?.();
  } catch {
    /* older Node versions */
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* noop */
      }
      finish();
    }, timeout);
    timer.unref?.();
    server.close(finish);
  });
}

/**
 * Register signal handlers for graceful shutdown. Returns a detach function.
 *
 * @param {object} handlers Map of signal name → async cleanup function.
 * @param {object} [options]
 * @param {string[]} [options.signals=['SIGINT','SIGTERM']]
 * @returns {function(): void} Detach all registered handlers.
 *
 * @example
 * const detach = handleSignals({
 *   SIGINT: async () => { await closeGracefully(server); process.exit(0); },
 * });
 */
export function handleSignals(handlers = {}, options = {}) {
  const signals = options.signals || ['SIGINT', 'SIGTERM'];
  const registered = [];
  for (const signal of signals) {
    const fn = typeof handlers[signal] === 'function' ? handlers[signal] : null;
    if (!fn) continue;
    const listener = () => {
      Promise.resolve(fn()).catch((err) => {
        process.stderr.write(`Error during ${signal} shutdown: ${err && err.stack ? err.stack : err}\n`);
        process.exitCode = 1;
      });
    };
    process.on(signal, listener);
    registered.push([signal, listener]);
  }
  return function detach() {
    for (const [signal, listener] of registered) process.removeListener(signal, listener);
  };
}
