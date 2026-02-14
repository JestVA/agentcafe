export class FixedWindowRateLimiter {
  constructor({
    limit = Number(process.env.API_RATE_LIMIT_PER_MIN || 120),
    windowMs = 60 * 1000
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map();
  }

  check(key) {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      const resetAt = now + this.windowMs;
      const next = { count: 1, resetAt };
      this.windows.set(key, next);
      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, this.limit - next.count),
        resetEpochSeconds: Math.floor(resetAt / 1000)
      };
    }

    current.count += 1;
    const remaining = Math.max(0, this.limit - current.count);
    return {
      allowed: current.count <= this.limit,
      limit: this.limit,
      remaining,
      resetEpochSeconds: Math.floor(current.resetAt / 1000)
    };
  }
}
