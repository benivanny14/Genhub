#!/usr/bin/env node
// =============================================================================
// GENHUB - A local stand-in for Upstash REST (dev/test only)
//
//   node scripts/redis-stub.mjs                       # listens on 127.0.0.1:8899
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8899 \
//   UPSTASH_REDIS_REST_TOKEN=stub                     # what the app connects to
//
// WHY THIS EXISTS
//
// The database-backed suites drive the real routes, and the security-critical
// ones (payments, auth, uploads) rate limit through `checkRateLimitStrict`,
// which FAILS CLOSED: if the shared Redis cannot be reached, those routes answer
// 503 rather than degrade to per-instance counters. That is the right behaviour
// in production and a wall in front of the tests — with no Redis on the machine,
// or an Upstash endpoint that has gone away, almost every money-moving suite
// reports "expected 503 to be 200" and nothing else can be read from the run.
//
// So: run this, point the two UPSTASH_* variables at it, and the rate limiter is
// backed by a real (in-process, disposable) store without touching a network
// service. It implements only the commands src/lib/redis.ts uses.
//
// WHAT IT IS NOT
//
// Not a Redis, not a cache with eviction, not shared across processes, and not
// for any deployed environment. It never leaves this machine.
//
// TYPICAL FULL COMMAND (local Postgres + stub + a localhost app URL, because the
// /api/dev/* helpers refuse to run when the app URL is a public hostname):
//
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8899 UPSTASH_REDIS_REST_TOKEN=stub \
//   NEXT_PUBLIC_APP_URL=http://localhost:3000 \
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/genhub_test \
//   npx vitest run
// =============================================================================

import http from "node:http";

const PORT = Number(process.env.REDIS_STUB_PORT || 8899);

/** key -> { value, expiresAt } — expiresAt 0 means "no expiry". */
const store = new Map();

const now = () => Date.now();

/** The entry for a key, dropping it if its TTL has passed. */
function live(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

/** Translate a Redis glob into a RegExp, so KEYS behaves like KEYS. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function run(args) {
  const command = String(args[0] ?? "").toUpperCase();
  const key = String(args[1] ?? "");

  switch (command) {
    case "PING":
      return "PONG";

    case "INCR": {
      const next = Number((live(key)?.value ?? "0")) + 1;
      const entry = store.get(key);
      if (entry) entry.value = String(next);
      else store.set(key, { value: String(next), expiresAt: 0 });
      return next;
    }

    case "PEXPIRE": {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = now() + Number(args[2] || 0);
      return 1;
    }

    case "SETEX": {
      store.set(key, {
        value: String(args[3] ?? ""),
        expiresAt: now() + Number(args[2] || 0) * 1000,
      });
      return "OK";
    }

    case "GET":
      return live(key)?.value ?? null;

    case "DEL": {
      let removed = 0;
      for (const k of args.slice(1)) {
        if (store.delete(String(k))) removed += 1;
      }
      return removed;
    }

    case "KEYS": {
      const rx = globToRegExp(String(args[1] ?? "*"));
      return [...store.keys()].filter((k) => live(k) && rx.test(k));
    }

    default:
      return null;
  }
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let args;
    try {
      args = JSON.parse(body || "[]");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body must be a JSON array of command arguments" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: run(Array.isArray(args) ? args : []) }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`redis stub listening on http://127.0.0.1:${PORT} (dev/test only)`);
});
