/**
 * @module errors
 *
 * HTTP error hierarchy used across the framework. Every error carries an HTTP
 * status code, a machine readable code, and an `expose` flag that decides
 * whether the message may be shown to clients (5xx messages are hidden in
 * production mode by default).
 *
 * @example
 * import { NotFoundError, BadRequestError } from 'webcraft';
 *
 * app.get('/users/:id', async (ctx) => {
 *   const user = await db.find(ctx.params.id);
 *   if (!user) throw new NotFoundError(`User ${ctx.params.id} does not exist`);
 *   if (!isValid(user)) throw new BadRequestError('Malformed user record');
 *   ctx.res.json(user);
 * });
 */

/**
 * Base class for every error that maps onto an HTTP response.
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} [message] Human readable message.
   * @param {object} [options]
   * @param {string} [options.code] Machine readable error code.
   * @param {boolean} [options.expose] Whether the message may reach the client.
   * @param {*} [options.details] Structured extra data (e.g. validation errors).
   * @param {object} [options.headers] Extra response headers.
   * @param {*} [options.cause] Original error wrapped by this one.
   */
  constructor(status, message, options = {}) {
    super(message || `HTTP ${status}`, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.statusCode = status;
    this.code = options.code || `HTTP_${status}`;
    this.expose = options.expose !== undefined ? options.expose : status < 500;
    this.details = options.details;
    this.headers = options.headers && typeof options.headers === 'object' ? { ...options.headers } : {};
    this.timestamp = new Date().toISOString();
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  /** @returns {boolean} Always true — used for duck-typing. */
  get isHttpError() {
    return true;
  }

  /**
   * Serialise the error into a plain JSON-safe object.
   * @param {boolean} [includeStack=false] Include a stack trace (dev only).
   * @returns {object}
   */
  toJSON(includeStack = false) {
    const payload = {
      error: {
        status: this.status,
        code: this.code,
        message: this.expose ? this.message : 'Internal Server Error',
        timestamp: this.timestamp,
      },
    };
    if (this.details !== undefined) payload.error.details = this.details;
    if (includeStack) payload.error.stack = this.stack;
    return payload;
  }

  /**
   * Wrap an unknown thrown value into an HttpError.
   * @param {*} err Any thrown value.
   * @param {number} [fallbackStatus=500] Status used for non-HttpError inputs.
   * @returns {HttpError}
   */
  static from(err, fallbackStatus = 500) {
    if (err instanceof HttpError) return err;
    if (err instanceof Error) {
      return new HttpError(fallbackStatus, err.message, { cause: err, expose: false });
    }
    return new HttpError(fallbackStatus, String(err), { expose: false });
  }
}

/**
 * Duck-typed check that works across module instances.
 * @param {*} err
 * @returns {boolean}
 */
export function isHttpError(err) {
  return Boolean(err) && (err instanceof HttpError || err.isHttpError === true);
}

/** 400 Bad Request — malformed client input. */
export class BadRequestError extends HttpError {
  constructor(message = 'Bad Request', options = {}) {
    super(400, message, { code: 'BAD_REQUEST', ...options });
  }
}

/** 401 Unauthorized — authentication missing or invalid. */
export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized', options = {}) {
    super(401, message, { code: 'UNAUTHORIZED', ...options });
    this.headers['WWW-Authenticate'] = this.headers['WWW-Authenticate'] || options.scheme || 'Bearer realm="api"';
  }
}

/** 403 Forbidden — authenticated but not allowed. */
export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden', options = {}) {
    super(403, message, { code: 'FORBIDDEN', ...options });
  }
}

/** 404 Not Found — no route or resource matched. */
export class NotFoundError extends HttpError {
  constructor(message = 'Not Found', options = {}) {
    super(404, message, { code: 'NOT_FOUND', ...options });
  }
}

/** 405 Method Not Allowed — path exists but method does not. */
export class MethodNotAllowedError extends HttpError {
  /**
   * @param {string[]} allowed List of allowed HTTP methods.
   * @param {string} [message]
   */
  constructor(allowed = [], message, options = {}) {
    super(405, message || 'Method Not Allowed', { code: 'METHOD_NOT_ALLOWED', ...options });
    this.allowedMethods = allowed;
    if (allowed.length > 0) this.headers.Allow = allowed.join(', ');
  }
}

/** 408 Request Timeout — client took too long to send the request. */
export class RequestTimeoutError extends HttpError {
  constructor(message = 'Request Timeout', options = {}) {
    super(408, message, { code: 'REQUEST_TIMEOUT', ...options });
  }
}

/** 409 Conflict — request conflicts with current resource state. */
export class ConflictError extends HttpError {
  constructor(message = 'Conflict', options = {}) {
    super(409, message, { code: 'CONFLICT', ...options });
  }
}

/** 413 Payload Too Large — body exceeded the configured limit. */
export class PayloadTooLargeError extends HttpError {
  constructor(message = 'Payload Too Large', options = {}) {
    super(413, message, { code: 'PAYLOAD_TOO_LARGE', ...options });
  }
}

/** 415 Unsupported Media Type — unknown Content-Type. */
export class UnsupportedMediaTypeError extends HttpError {
  constructor(message = 'Unsupported Media Type', options = {}) {
    super(415, message, { code: 'UNSUPPORTED_MEDIA_TYPE', ...options });
  }
}

/** 422 Unprocessable Entity — semantic validation failure. */
export class UnprocessableEntityError extends HttpError {
  constructor(message = 'Unprocessable Entity', options = {}) {
    super(422, message, { code: 'UNPROCESSABLE_ENTITY', ...options });
  }
}

/** 429 Too Many Requests — rate limit exceeded. */
export class TooManyRequestsError extends HttpError {
  /**
   * @param {number} [retryAfterSeconds] Suggested wait before retrying.
   * @param {string} [message]
   */
  constructor(retryAfterSeconds, message = 'Too Many Requests', options = {}) {
    super(429, message, { code: 'TOO_MANY_REQUESTS', ...options });
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      this.headers['Retry-After'] = String(Math.ceil(retryAfterSeconds));
    }
  }
}

/** 500 Internal Server Error — unexpected failure. */
export class InternalServerError extends HttpError {
  constructor(message = 'Internal Server Error', options = {}) {
    super(500, message, { code: 'INTERNAL_SERVER_ERROR', expose: options.expose !== undefined ? options.expose : false, ...options });
  }
}

/** 501 Not Implemented — feature deliberately missing. */
export class NotImplementedError extends HttpError {
  constructor(message = 'Not Implemented', options = {}) {
    super(501, message, { code: 'NOT_IMPLEMENTED', ...options });
  }
}

/** 503 Service Unavailable — shutting down or overloaded. */
export class ServiceUnavailableError extends HttpError {
  constructor(message = 'Service Unavailable', options = {}) {
    super(503, message, { code: 'SERVICE_UNAVAILABLE', ...options });
  }
}

/**
 * Factory mapping a numeric status to the matching error class.
 * @param {number} status
 * @param {string} [message]
 * @param {object} [options]
 * @returns {HttpError}
 */
export function createHttpError(status, message, options = {}) {
  const map = {
    400: BadRequestError,
    401: UnauthorizedError,
    403: ForbiddenError,
    404: NotFoundError,
    405: MethodNotAllowedError,
    408: RequestTimeoutError,
    409: ConflictError,
    413: PayloadTooLargeError,
    415: UnsupportedMediaTypeError,
    422: UnprocessableEntityError,
    429: TooManyRequestsError,
    500: InternalServerError,
    501: NotImplementedError,
    503: ServiceUnavailableError,
  };
  const Ctor = map[status];
  if (Ctor) return new Ctor(message, options);
  return new HttpError(status, message, options);
}
