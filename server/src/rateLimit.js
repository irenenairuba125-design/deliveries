// Fixed-window rate limiter. Counters live in Redis when REDIS_URL is set
// (shared across instances), otherwise in memory.
import { HttpError } from './errors.js';
import { REDIS_URL, redisClient } from './redis.js';

let redis = null;
const memory = new Map(); // key -> { count, resetAt }

async function hit(key, windowMs) {
  if (REDIS_URL) {
    redis ??= redisClient('ratelimit');
    const [[, count], [, ttl]] = await redis.multi().incr(key).pttl(key).exec();
    if (ttl < 0) await redis.pexpire(key, windowMs);
    return { count, resetMs: ttl < 0 ? windowMs : ttl };
  }
  const now = Date.now();
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memory.set(key, entry);
    if (memory.size > 50_000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
  }
  entry.count += 1;
  return { count: entry.count, resetMs: entry.resetAt - now };
}

// keyFn(req) picks what to count (e.g. IP + email for logins).
export function rateLimit({ name, max, windowMs, keyFn = (req) => req.ip }) {
  return async (req, res, next) => {
    if (process.env.RATE_LIMIT === 'off') return next();
    const { count, resetMs } = await hit(`rl:${name}:${keyFn(req)}`, windowMs);
    if (count > max) {
      res.set('Retry-After', String(Math.ceil(resetMs / 1000)));
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(resetMs / 60000)} min.`);
    }
    next();
  };
}
