/**
 * @module ratelimit
 *
 * In-memory token-bucket rate limiter. Each client key owns a bucket that
 * refills continuously; requests consume tokens and are rejected (429) when
 * the bucket is empty.
 *
 * @example
 * import { rateLimit } from 'webcraft/lib/ratelimit.js';
 *
 * // 100 requests per minute per IP across the whole app
 * app.use(rateLimit({ windowMs: 60_000, max: 100 }));
 *
 * // Stricter limit for a single route
 * app.post('/login', rateLimit({ windowMs: 60_000, max: 5, key: (ctx) => ctx.req.ip }), loginHandler);
 */

import { TooManyRequestsError } from './errors.js';

/**
 * One leaky-bucket style token bucket.
 */
export class TokenBucket {
  /**
   * @param {number} capacity Maximum burst size (tokens).
   * @param {number} refillPerSecond Tokens added per second.
   * @param {number} [now=Date.now()]
   */
  constructor(capacity, refillPerSecond, now = Date.now()) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new TypeError('capacity must be > 0');
    if (!Number.isFinite(refillPerSecond) || refillPerSecond < 0) throw new TypeError('refillPerSecond must be >= 0');
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefill = now;
  }

  /**
   * Add tokens accrued since the last refill.
   * @param {number} [now=Date.now()]
   * @returns {TokenBucket} this
   */
  refill(now = Date.now()) {
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0 && this.refillPerSecond > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    }
    this.lastRefill = now;
    return this;
  }

  /**
   * Try to consume one token.
   * @param {number} [now=Date.now()]
   * @returns {boolean} true when a token was available.
   */
  tryTake(now = Date.now()) {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Milliseconds until at least one token is available again.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  retryAfterMs(now = Date.now()) {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    if (this.refillPerSecond <= 0) return Infinity;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  /** Seconds until the bucket is fully replenished. */
  resetSeconds(now = Date.now()) {
    this.refill(now);
    if (this.refillPerSecond <= 0) return Infinity;
    return Math.ceil(((this.capacity - this.tokens) / this.refillPerSecond) * 1000) / 1000;
  }
}

/**
 * Registry of buckets keyed by arbitrary strings (usually IP or API key).
 */
export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} [options.windowMs=60000] Refill window in milliseconds.
   * @param {number} [options.max=100] Requests allowed per window.
   * @param {number} [options.burst=max] Bucket capacity (defaults to max).
   * @param {number} [options.sweepIntervalMs=300000] Idle bucket cleanup period.
   */
  constructor({ windowMs = 60_000, max = 100, burst, sweepIntervalMs = 300_000 } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError('windowMs must be > 0');
    if (!Number.isFinite(max) || max <= 0) throw new TypeError('max must be > 0');
    this.windowMs = windowMs;
    this.max = max;
    this.refillPerSecond = max / (windowMs / 1000);
    this.buckets = new Map();
    this.sweepIntervalMs = sweepIntervalMs;
    this._sweepTimer = null;
  }

  /**
   * Get (or lazily create) the bucket for a key.
   * @param {string} key
   * @returns {TokenBucket}
   */
  bucketFor(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.burst ?? this.max, this.refillPerSecond);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Attempt to consume a request slot.
   * @param {string} key
   * @param {number} [cost=1] Tokens consumed by this request.
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number, resetSeconds: number}}
   */
  take(key, cost = 1) {
    const now = Date.now();
    const bucket = this.bucketFor(key);
    let allowed = true;
    for (let i = 0; i < cost; i += 1) {
      if (!bucket.tryTake(now)) {
        allowed = false;
        break;
      }
    }
    return {
      allowed,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      retryAfterMs: allowed ? 0 : bucket.retryAfterMs(now),
      resetSeconds: bucket.resetSeconds(now),
    };
  }

  /** Drop buckets idle for longer than two windows. */
  sweep() {
    const now = Date.now();
    const cutoff = now - Math.max(this.windowMs * 4, 60_000);
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
    }
  }

  /** Start the background sweep timer (auto-started by {@link rateLimit}). */
  startSweeping() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this._sweepTimer.unref?.();
  }

  /** Stop the background sweep timer. */
  stopSweeping() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  /** Number of tracked buckets. */
  get size() {
    return this.buckets.size;
  }
}

/**
 * Rate limiting middleware.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] Sliding window in ms.
 * @param {number} [options.max=100] Requests per window per key.
 * @param {function(import('./webcraft.js').Context): string} [options.key]
 *   Key generator (defaults to the client IP).
 * @param {number} [options.cost=1] Tokens consumed per request.
 * @param {function(import('./webcraft.js').Context): boolean} [options.skip]
 *   Predicate to bypass the limiter.
 * @param {string} [options.message='Too Many Requests'] Rejection body.
 * @returns {(ctx: import('./webcraft.js').Context, next: function(): Promise<void>) => Promise<void>}
 *
 * @example
 * app.get('/api/search', rateLimit({ windowMs: 10_000, max: 20 }), searchHandler);
 */
export function rateLimit(options = {}) {
  const limiter = options.limiter instanceof RateLimiter ? options.limiter : new RateLimiter(options);
  const keyFn = typeof options.key === 'function' ? options.key : (ctx) => ctx.req.ip;
  const skip = typeof options.skip === 'function' ? options.skip : null;
  const cost = Number.isFinite(options.cost) && options.cost > 0 ? options.cost : 1;
  const message = options.message || 'Too Many Requests';
  limiter.startSweeping();

  return async function rateLimitMiddleware(ctx, next) {
    if (skip && skip(ctx)) return next();
    const key = String(keyFn(ctx) || 'unknown');
    const verdict = limiter.take(key, cost);
    ctx.res.set('X-RateLimit-Limit', String(limiter.max));
    ctx.res.set('X-RateLimit-Remaining', String(verdict.remaining));
    if (!verdict.allowed) {
      const retryAfter = Number.isFinite(verdict.retryAfterMs) ? Math.ceil(verdict.retryAfterMs / 1000) : limiter.windowMs / 1000;
      ctx.res.set('X-RateLimit-Retry-After', String(retryAfter));
      throw new TooManyRequestsError(retryAfter, message);
    }
    return next();
  };
}
