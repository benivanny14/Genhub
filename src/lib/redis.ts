// =============================================================================
// GENHUB - Redis (rate limiting + cache)
//
// Two backends, one behaviour:
//
//   upstash-rest  UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN over HTTPS.
//                 Preferred when present, and the better fit for serverless: no
//                 TCP pool to exhaust, no connection left dangling between
//                 invocations, works on runtimes that cannot open raw sockets.
//   ioredis       REDIS_URL (redis:// / rediss://). Used for self-hosted Redis
//                 and for Railway/Render style deployments.
//
// Upstash's console hands out BOTH pairs of credentials, and pasting only the
// REST pair used to be silently useless: nothing read those variables, so the
// app kept dialling localhost, rate limiting quietly fell back to per-instance
// memory, and the admin Setup tab still reported Redis as missing. Config that
// nothing reads is worse than no config, so the REST pair is now a first-class
// backend and the checks recognise it.
//
// Fallback: an in-memory bucket per process when neither backend answers. Still
// enforces limits for this instance instead of failing open.
// =============================================================================

import Redis from "ioredis";
import config from "./config";

export type RedisBackendName = "upstash-rest" | "ioredis";

interface RedisBackend {
  name: RedisBackendName;
  /** Backend-specific description, shown in the admin setup report. */
  describe: string;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<void>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  del(keys: string[]): Promise<void>;
  /** PING plus a real write, because a Redis answering reads while rejecting
   *  writes (MISCONF) would downgrade rate limiting without anyone noticing. */
  verifyWritable(): Promise<void>;
}

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
  redisBackend: RedisBackend | undefined;
};

// -----------------------------------------------------------------------------
// Backend: Upstash REST
// -----------------------------------------------------------------------------

function createUpstashBackend(url: string, token: string): RedisBackend {
  async function command<T>(args: (string | number)[]): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      // Never let Next.js cache a command result: an INCR served from a cache
      // would defeat the rate limiter entirely.
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      throw new Error(`Upstash REST HTTP ${res.status}`);
    }

    const body = (await res.json()) as { result?: T; error?: string };
    if (body.error) throw new Error(`Upstash REST: ${body.error}`);
    return body.result as T;
  }

  return {
    name: "upstash-rest",
    describe: "PING + write OK · Upstash REST (HTTPS)",

    async incr(key) {
      return Number(await command<number>(["INCR", key]));
    },

    async pexpire(key, ms) {
      await command(["PEXPIRE", key, ms]);
    },

    async get(key) {
      return (await command<string | null>(["GET", key])) ?? null;
    },

    async setex(key, seconds, value) {
      await command(["SETEX", key, seconds, value]);
    },

    async keys(pattern) {
      return (await command<string[]>(["KEYS", pattern])) ?? [];
    },

    async del(keys) {
      if (keys.length === 0) return;
      await command(["DEL", ...keys]);
    },

    async verifyWritable() {
      const pong = await command<string>(["PING"]);
      if (pong !== "PONG") throw new Error(`PING -> ${pong}`);

      const key = `genhub:setup:${Date.now()}`;
      await command(["SET", key, "1", "PX", 5_000]);
      await command(["DEL", key]);
    },
  };
}

// -----------------------------------------------------------------------------
// Backend: ioredis (TCP)
// -----------------------------------------------------------------------------

function createIoRedisBackend(client: Redis): RedisBackend {
  return {
    name: "ioredis",
    describe: /^rediss:\/\//.test(config.redisUrl)
      ? "PING + write OK · TLS on"
      : "PING + write OK",

    async incr(key) {
      return client.incr(key);
    },

    async pexpire(key, ms) {
      await client.pexpire(key, ms);
    },

    async get(key) {
      return client.get(key);
    },

    async setex(key, seconds, value) {
      await client.setex(key, seconds, value);
    },

    async keys(pattern) {
      return client.keys(pattern);
    },

    async del(keys) {
      if (keys.length === 0) return;
      await client.del(...keys);
    },

    async verifyWritable() {
      const pong = await client.ping();
      if (pong !== "PONG") throw new Error(`PING -> ${pong}`);

      const key = `genhub:setup:${Date.now()}`;
      await client.set(key, "1", "PX", 5_000);
      await client.del(key);
    },
  };
}

// -----------------------------------------------------------------------------
// Which backend this process uses
// -----------------------------------------------------------------------------

function createBackend(): RedisBackend {
  if (config.redis.restUrl && config.redis.restToken) {
    return createUpstashBackend(config.redis.restUrl, config.redis.restToken);
  }

  const client =
    globalForRedis.redis ??
    new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      },
      enableReadyCheck: true,
      lazyConnect: true,
    });

  globalForRedis.redis = client;
  return createIoRedisBackend(client);
}

export const redisBackend: RedisBackend =
  globalForRedis.redisBackend ?? createBackend();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisBackend = redisBackend;
}

/** Which backend is live, for the admin setup report. */
export function redisBackendName(): RedisBackendName {
  return redisBackend.name;
}

/** PING + write probe. Throws with the backend's own words on failure. */
export async function verifyRedisWritable(): Promise<string> {
  await redisBackend.verifyWritable();
  return redisBackend.describe;
}

// -----------------------------------------------------------------------------
// In-memory fallback
// -----------------------------------------------------------------------------

const memoryBuckets = new Map<string, { count: number; expiresAt: number }>();
let warnedRedisDown = false;

function memoryRateLimit(
  windowKey: string,
  maxRequests: number,
  windowMs: number,
  now: number
): { allowed: boolean; remaining: number } {
  // Bound the map: drop expired buckets first, hard-cap as a safety valve
  if (memoryBuckets.size > 10_000) {
    memoryBuckets.forEach((v, k) => {
      if (v.expiresAt <= now) memoryBuckets.delete(k);
    });
    if (memoryBuckets.size > 10_000) memoryBuckets.clear();
  }

  let bucket = memoryBuckets.get(windowKey);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { count: 0, expiresAt: now + windowMs };
    memoryBuckets.set(windowKey, bucket);
  }
  bucket.count += 1;

  return {
    allowed: bucket.count <= maxRequests,
    remaining: Math.max(0, maxRequests - bucket.count),
  };
}

// -----------------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------------

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const windowKey = `rl:${key}:${Math.floor(now / windowMs)}`;
  const resetAt = Math.ceil((now + windowMs) / 1000);

  try {
    const current = await redisBackend.incr(windowKey);
    if (current === 1) {
      // A missing TTL only leaks an unused key — never fail the request for it
      await redisBackend.pexpire(windowKey, windowMs).catch(() => {});
    }
    return {
      allowed: current <= maxRequests,
      remaining: Math.max(0, maxRequests - current),
      resetAt,
    };
  } catch {
    if (!warnedRedisDown) {
      warnedRedisDown = true;
      console.warn(
        "[Redis] unreachable — using in-memory rate limiting (per-instance only)"
      );
    }
    const fallback = memoryRateLimit(windowKey, maxRequests, windowMs, now);
    return { ...fallback, resetAt };
  }
}

// -----------------------------------------------------------------------------
// Cache helpers
// -----------------------------------------------------------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const data = await redisBackend.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = 300
): Promise<void> {
  try {
    await redisBackend.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Cache write failure is non-critical
  }
}

export async function cacheDel(pattern: string): Promise<void> {
  try {
    const keys = await redisBackend.keys(pattern);
    if (keys.length > 0) {
      await redisBackend.del(keys);
    }
  } catch {
    // Non-critical
  }
}
