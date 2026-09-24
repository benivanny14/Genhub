// =============================================================================
// GENHUB - Live probes, shared by preflight.mjs and verify-connections.mjs
//
// Two different questions live in these scripts:
//
//   "did you set this?"      -> the environment checks in each caller
//   "does it actually work?" -> these probes, which open real connections
//
// A connection string with a typo, a sandbox API key, a Bunny account with Token
// Authentication still off, an SMTP host that no longer resolves — all of them
// LOOK configured, and the worst moment to find out is after a customer paid.
//
// They live here, once, because the alternative already burned this project: the
// setup checklist was written twice and the two copies disagreed on the very
// first real value either of them saw (.env.local held a placeholder Bunny token;
// the app called it configured and the script called it a placeholder). Callers
// are free to format differently — verify-connections prints each record,
// preflight counts a `fail` as a launch blocker — but what is called, with what
// timeout, and in whose words it answers has ONE definition.
//
// Every probe is READ-ONLY or self-cleaning:
//   Redis   PING, then SET + DEL of one throwaway key. The app writes (INCR,
//           SETEX), so a server that answers reads while rejecting writes —
//           Redis MISCONF — has to fail here rather than silently downgrade
//           rate limiting to per-instance buckets.
//   Bunny   library lookup (GET) + a CDN HEAD. Any HTTP answer from the CDN
//           proves DNS and TLS; the signature itself is proven by playback.
//   SMTP    transport.verify() — opens a session and sends nothing.
// =============================================================================

const env = (k) => (process.env[k] || "").trim();
const timeout = (ms) => AbortSignal.timeout(ms);
const isLocal = (v) => /localhost|127\.0\.0\.1/i.test(v || "");

// Shared glyphs, so the two callers cannot drift into different symbols for the
// same state.
export const GREEN = "\u2713";
export const RED = "\u2717";
export const AMBER = "!";
export const DIM = "\u00b7";

/**
 * @typedef {{ name: string, state: "ok" | "warn" | "fail" | "skip", detail: string }} ProbeRecord
 */

// =============================================================================
// Redis
// =============================================================================

/**
 * The Upstash REST probe.
 *
 * Same discipline as the TCP path below: PING alone is not enough, because the
 * app writes — a server can answer reads while refusing writes.
 */
async function probeRedisRest(url, token) {
  const command = async (args) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  };

  try {
    const pong = await command(["PING"]);
    if (pong !== "PONG") throw new Error(`PING -> ${pong}`);

    const probeKey = `genhub:verify:${Date.now()}`;
    await command(["SET", probeKey, "1", "PX", 5000]);
    await command(["DEL", probeKey]);

    return [
      {
        name: "Redis",
        state: "ok",
        detail: "PING + write OK · Upstash REST (HTTPS)",
      },
    ];
  } catch (error) {
    return [
      {
        name: "Redis",
        state: "fail",
        detail: `Upstash REST: ${String(error.message || error).slice(0, 150)}`,
      },
    ];
  }
}

/**
 * @returns {Promise<ProbeRecord[]>} always one record
 */
export async function probeRedis() {
  const restUrl = env("UPSTASH_REDIS_REST_URL");
  const restToken = env("UPSTASH_REDIS_REST_TOKEN");

  // Upstash REST wins when present, matching src/lib/redis.ts — so the probe
  // reports on the backend the app will actually use.
  if (restUrl && restToken) return probeRedisRest(restUrl, restToken);
  if (restUrl || restToken) {
    return [
      {
        name: "Redis",
        state: "fail",
        detail:
          "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — only one is set, both are required",
      },
    ];
  }

  const url = env("REDIS_URL");
  if (!url) {
    return [
      {
        name: "Redis",
        state: "skip",
        detail: "no managed Redis configured (UPSTASH_REDIS_REST_* or REDIS_URL)",
      },
    ];
  }

  const isLocalRedis = isLocal(url);
  let client;
  try {
    const { default: Redis } = await import("ioredis");
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 10_000,
      retryStrategy: () => null,
    });

    const pong = await client.ping();
    if (pong !== "PONG") throw new Error(`PING -> ${pong}`);

    // PING proves the server is up, but the app never runs PING — it runs INCR
    // and SETEX, so test a real write.
    const probeKey = `genhub:verify:${Date.now()}`;
    await client.set(probeKey, "1", "PX", 5000);
    await client.del(probeKey);

    return [
      {
        name: "Redis",
        state: "ok",
        detail:
          "PING + write OK" +
          (/^rediss:\/\//.test(url)
            ? " · TLS on"
            : ` · ${AMBER} plaintext redis:// — use rediss:// in production`),
      },
    ];
  } catch (error) {
    const message = String(error.message || error);
    if (/MISCONF|not able to persist|read-only|READONLY/i.test(message)) {
      // Reachable, but refusing writes. Locally that is a disk-permission quirk.
      // On managed Redis it is a real incident.
      return [
        {
          name: "Redis",
          state: isLocalRedis ? "warn" : "fail",
          detail:
            "reachable but REJECTING WRITES (MISCONF)" +
            (isLocalRedis
              ? " — local dev server cannot persist to disk. Rate limits fall back to in-memory (the app fails open, so nothing breaks)."
              : " — rate limiting will silently fall back to per-instance buckets, so the limit no longer holds across instances."),
        },
      ];
    }
    return [{ name: "Redis", state: "fail", detail: message.slice(0, 150) }];
  } finally {
    try {
      await client?.quit();
    } catch {
      /* already gone */
    }
  }
}

// =============================================================================
// Bunny Stream + CDN
// =============================================================================

/** The Stream library itself: proves the key, and reads Token Auth back. */
async function probeBunnyStream() {
  const key = env("BUNNY_STREAM_API_KEY");
  const library = env("BUNNY_STREAM_LIBRARY_ID");
  if (!key || !library) {
    return [
      {
        name: "Bunny Stream",
        state: "skip",
        detail: "BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID not set",
      },
    ];
  }

  try {
    const res = await fetch(`https://video.bunnycdn.com/library/${library}`, {
      headers: { AccessKey: key },
      signal: timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return [
        {
          name: "Bunny Stream",
          state: "fail",
          detail:
            `HTTP ${res.status} ${JSON.stringify(body).slice(0, 110)}` +
            (res.status === 401 || res.status === 403
              ? " · wrong key, or it lacks access to this library"
              : ""),
        },
      ];
    }

    // The setting that silently breaks paid playback: without Token
    // Authentication the signature in the URL is ignored, so anyone who copies a
    // link can watch a video they never bought.
    const tokenAuth =
      body?.TokenAuthenticationEnabled ?? body?.tokenAuthenticationEnabled ?? null;
    const signed = !!env("BUNNY_TOKEN_SECRET");
    const records = [
      {
        name: "Bunny Stream",
        state: tokenAuth === false ? "fail" : "ok",
        detail:
          `library "${body.name || library}" · plan ${body.plan ?? "?"} · videos ${body.totalVideos ?? "?"}` +
          (tokenAuth === false
            ? ` · ${RED} Token Authentication is OFF — paid videos are unprotected. Turn it ON in Stream → Security.`
            : tokenAuth === true
              ? " · Token Auth ON"
              : ""),
      },
    ];

    if (tokenAuth === true && !signed) {
      records.push({
        name: "Bunny token",
        state: "fail",
        detail:
          "Token Auth is ON but BUNNY_TOKEN_SECRET is empty — playback URLs will not be accepted",
      });
    }

    return records;
  } catch (error) {
    return [
      {
        name: "Bunny Stream",
        state: "fail",
        detail: String(error.message || error).slice(0, 150),
      },
    ];
  }
}

/** The pull zone: DNS + TLS only, so even a 403 is an answer. */
async function probeBunnyCdn() {
  const host = env("BUNNY_CDN_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host) {
    return [{ name: "Bunny CDN", state: "skip", detail: "BUNNY_CDN_HOSTNAME not set" }];
  }

  try {
    const res = await fetch(`https://${host}/`, { method: "HEAD", signal: timeout(15_000) });
    return [
      {
        name: "Bunny CDN",
        // Any HTTP answer (even 403) proves DNS + TLS work, which is what we are
        // testing here; the token itself is validated by playback.
        state: "ok",
        detail: `${host} answered HTTP ${res.status}`,
      },
    ];
  } catch (error) {
    return [
      {
        name: "Bunny CDN",
        state: "fail",
        detail: `${host} did not resolve/answer — check the pull-zone hostname (${String(
          error.message || error
        ).slice(0, 80)})`,
      },
    ];
  }
}

/**
 * @returns {Promise<ProbeRecord[]>} Stream, optionally a token warning, then CDN
 */
export async function probeBunny() {
  return [...(await probeBunnyStream()), ...(await probeBunnyCdn())];
}

// =============================================================================
// SMTP (sends nothing — verify() just opens the session)
// =============================================================================

/**
 * @returns {Promise<ProbeRecord[]>} always one record
 */
export async function probeSmtp() {
  const host = env("SMTP_HOST");
  if (!host) {
    return [
      {
        name: "SMTP",
        state: "skip",
        detail: "SMTP_HOST not set — password reset emails only reach the server log",
      },
    ];
  }

  try {
    const { default: nodemailer } = await import("nodemailer");
    const port = Number(env("SMTP_PORT") || 587);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: env("SMTP_USER") ? { user: env("SMTP_USER"), pass: env("SMTP_PASS") } : undefined,
      // Bounded, the same way the app bounds it: a mail host that accepts the
      // connection and then stalls must not hold the launch gate open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    await transport.verify();
    transport.close();

    const from = env("EMAIL_FROM");
    return [
      {
        name: "SMTP",
        state: from ? "ok" : "warn",
        detail:
          `${host}:${port} authenticated` +
          (from
            ? ` · from ${from}`
            : ` · ${AMBER} EMAIL_FROM not set (falls back to no-reply@genhub.local, which providers reject)`),
      },
    ];
  } catch (error) {
    return [{ name: "SMTP", state: "fail", detail: String(error.message || error).slice(0, 150) }];
  }
}
