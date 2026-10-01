# Genhub — Production Security & Abuse Hardening

This document records the defensive changes made in this pass, the full API
route security matrix, the infrastructure rules that must be applied **manually**
in Vercel / Cloudflare, the environment variables the hardening depends on, and
the residual risks that application code cannot close on its own.

> **WAF/CDN protection is NOT active until the rules in §5 are applied.** No code
> in this repository can claim that an edge WAF is enforcing limits. Everything
> that is enforced *in application code* is marked as such below and is covered
> by tests.

---

## 1. What was implemented in code

| Area | Change | Where |
|---|---|---|
| Central rate limiting | `checkRateLimit` now reports whether it answered from the shared store or degraded to per-instance memory (`degraded`). New `checkRateLimitStrict` **fails closed** when the shared store is unreachable. | `src/lib/redis.ts` |
| Fail-closed routes | `checkRateLimitStrict` wired into login, register, forgot-password, reset-password, demo-login, purchase, topup, payment status. They answer `503 TEMPORARILY_UNAVAILABLE` (not `429`) on a cache outage. | `src/app/api/auth/*`, `src/app/api/payments/*` |
| Public GET flood protection | IP-keyed limits on home-feed, video list, creator directory, creator profile, search suggest, comments, media proxy, stream, intro, intro-clip, video detail, video status. | see matrix §4 |
| Authenticated write limits | Per-account limits on progress, favourites, notifications, playlists, profile, comments, interactions, messages, tips, subscriptions, support, coupons, reports, uploads, upload-abort/complete. | see matrix §4 |
| Watch-progress throttle | Server-side debounce: a write is skipped unless the position moved ≥5s or the row is older than 30s; position/duration capped at 24h. | `src/app/api/videos/[id]/progress/route.ts` |
| Unpublished-video leak | `POST /api/videos/status` no longer returns status for **unpublished** rows to anonymous callers (was: any non-deleted id). Owners/admins still see their own. Ids shape-validated and capped. | `src/app/api/videos/status/route.ts` |
| Bounded raw webhook body | Bunny HMAC webhook now reads through `readRawBodyCapped` (64 KB ceiling, declared-length check first) instead of an unbounded `request.text()`, while still preserving the exact bytes for signature verification. | `src/lib/request-body.ts`, `src/app/api/webhooks/bunny/route.ts` |
| Query/cache-key bounds | Video list `q`/`category` and creator `q` capped and lower-cased before querying and before forming cache keys; unknown-shape `creatorId` dropped. | `src/app/api/videos/route.ts`, `src/app/api/creators/route.ts` |
| Spoofed IP hardening | `clientIp` tolerates a missing header bag (fail to one shared, documented key) and continues to take the *last* forwarded hop. | `src/lib/utils.ts` |
| Email diagnostics | In production, a missing `SMTP_HOST` now raises an operator credential alert instead of silently logging mail; `productionConfigWarnings()` flags an undeliverable `EMAIL_FROM`. | `src/lib/email.ts`, `src/lib/config.ts` |
| Player controls | Tap-to-toggle controls plus double-tap ±10s seek. | `src/components/VideoPlayer.tsx` |

Tests: `src/tests/request-hardening.test.ts` pins fail-closed behaviour, trusted
IP parsing, the raw-body cap, and that every security-critical route uses the
strict limiter. `src/app/api/videos/status/route.test.ts` pins the privacy rule.

---

## 2. Rate-limit model

* **Backend:** Upstash REST (preferred) or ioredis (`REDIS_URL`). Both are
  distributed, so limits are shared across every serverless instance.
* **Fallback:** per-instance memory. Public cached reads may use it (flagged
  `degraded`); **security-critical routes refuse instead** (flagged
  `unavailable` → `503`).
* **Keys:** trusted request IP (`clientIp`) for anonymous traffic and
  authenticated `userId` for write paths. Read limits are more generous than
  write limits. No route trusts a client-supplied leading `x-forwarded-for` hop.
* **Never IP-only for privileged actions:** admin and payment actions are keyed
  on the account, and authorization is re-read from the database (see §6).

> **Requirement:** the hosting platform must set/sanitize `x-real-ip` or
> `x-forwarded-for`. Vercel does. If you self-host behind your own proxy, you
> **must** strip inbound client values of these headers at the proxy and set your
> own, or the IP key becomes client-controlled.

---

## 3. Body and entitlement protections

* Every JSON route reads through `readJsonBody` (`Content-Length` check first,
  then a streaming byte counter, default 256 KB).
* The Bunny webhook reads through `readRawBodyCapped` (64 KB) before HMAC.
* The ClickPesa webhook keeps the 1 MB ceiling and verifies its checksum (HMAC)
  or shared token before any database access; repeat deliveries are idempotent
  via transaction status.
* Stream/intro/intro-clip take no client-supplied upstream path (except the
  stream route, which polices `?path=` with `safeManifestPath`); segments go to
  the CDN directly and never through the app server.

---

## 4. API route security matrix

Legend — **Auth**: public / soft (optional session) / user / creator / admin /
webhook / cron. **RL**: application rate limit (⛨ = fail-closed strict).

### Auth
| Route | Method | Auth | RL | Body | DB | Notes |
|---|---|---|---|---|---|---|
| `/api/auth/login` | POST | public | ⛨ 10/min/IP | 256 KB | yes | Fails closed on cache outage |
| `/api/auth/register` | POST | public | ⛨ 10/min/IP | 256 KB | yes | Username race handled |
| `/api/auth/forgot-password` | POST | public | ⛨ 5/min/IP | 256 KB | yes | Never reveals account existence |
| `/api/auth/reset-password` | POST | public | ⛨ 5/min/IP | 256 KB | yes | Token stored hashed |
| `/api/auth/demo-login` | POST | public (dev-only) | ⛨ 10/min/IP | 256 KB | yes | Disabled unless dev signals |
| `/api/auth/me` | GET | soft | – | – | yes | Read-only |
| `/api/auth/logout` | POST | public | – | – | – | Clears cookie |

### Public reads
| Route | Method | Auth | RL | DB/Cache | Notes |
|---|---|---|---|---|---|
| `/api/home-feed` | GET | public | 120/min/IP | yes, cache 60s | 11 queries behind cache |
| `/api/videos` | GET | public | 120/min/IP | yes, cache 60s | `q`/`category` capped |
| `/api/creators` | GET | public | 120/min/IP | yes, cache 120s | `q` capped |
| `/api/creators/[id]` | GET | public | 120/min/IP | yes | |
| `/api/search/suggest` | GET | public | 100/min/IP | yes, cache 120s | |
| `/api/videos/[id]` | GET | soft | 120/min/IP | yes | Unpublished hidden unless owner/admin |
| `/api/videos/status` | POST | soft | 240/min/IP | yes | **Unpublished hidden from anon** |
| `/api/videos/[id]/comments` | GET | public | 120/min/IP | yes | |
| `/api/videos/[id]/interactions` | GET | soft | – | yes | Cheap reads |

### Media / video proxy
| Route | Method | Auth | RL | Upstream | Notes |
|---|---|---|---|---|---|
| `/api/media/[...path]` | GET | soft (private keys gated) | 600/min/IP | Bunny Storage, 15s timeout | Path validated, content-type pinned |
| `/api/videos/[id]/stream` | GET | soft + entitlement | 300/min/IP | Bunny CDN manifest only | `safeManifestPath`, signed, `no-store` |
| `/api/videos/[id]/intro` | GET | soft | 120/min/IP | single fixed asset | |
| `/api/videos/[id]/intro-clip` | GET | soft | 120/min/IP | several manifests | teaser only; segments signed per file |

### Authenticated writes
| Route | Method | Auth | RL | Body |
|---|---|---|---|---|
| `/api/videos/[id]/progress` | POST | user | 120/min/account + debounce | capped |
| `/api/videos/[id]/comments` | POST | user | 100/min/account | 1 KB text |
| `/api/videos/[id]/interactions` | POST | user | 100/min/account | |
| `/api/favorites` | GET/POST | user | 120/min/account | |
| `/api/notifications` | PATCH | user | 120/min/account | |
| `/api/playlists` (+`/[id]`, `/[id]/items`) | POST/PATCH/DELETE | user | 60/min/account | |
| `/api/profile` | PATCH | user | 30/min/account | |
| `/api/messages` (+settings) | POST/PATCH | user | existing | |
| `/api/support` | POST | soft | 5/hour/IP | 4 KB |
| `/api/coupons/validate` | POST | soft | existing | |
| `/api/videos/report`, `/api/comments/[id]/report` | POST | user | existing | |
| `/api/tips`, `/api/subscriptions` | POST/PATCH/DELETE | user | existing | |
| `/api/videos/upload-signature` | POST | creator | existing | |
| `/api/videos/upload-complete` | POST | creator | 60/min/account | |
| `/api/videos/upload-abort` | POST | creator | 60/min/account | |
| `/api/upload` | POST | creator | existing (5/5min) | size-capped |

### Payments
| Route | Method | Auth | RL | Notes |
|---|---|---|---|---|
| `/api/payments/purchase` | POST | user | ⛨ 20/min/account | idempotent by reference |
| `/api/payments/topup` | POST | user | ⛨ 20/min/account | |
| `/api/payments/status/[orderId]` | GET | user | ⛨ 60/min/account | can reconcile upstream |
| `/api/payments/health` | GET | user | – | read-only |

### Admin (all `requireRole("ADMIN")`, role re-read from DB)
`/api/admin/{audit,blue-tick,bunny-self-test,bunny-webhook-test,comments,coupons,earnings,jobs,jobs/run,kyc,launch-readiness,overview,payments,payouts,reports,setup,upload-failures,users,videos}`
— authorization is DB-backed; **application-level per-admin rate limits are not
yet applied** (see §7) and should be enforced at the edge (§5).

### Webhooks / cron
| Route | Method | Auth | Body | Notes |
|---|---|---|---|---|
| `/api/webhooks/bunny` | POST | HMAC signature | 64 KB cap | Fails closed with no secret; ignores other libraries; idempotent |
| `/api/webhooks/clickpesa` | POST | checksum (HMAC) or shared token | 1 MB cap | Verified before DB; amount taken from our row |
| `/api/cron/*` | GET/POST | `CRON_SECRET` | – | Secret-gated worker triggers |
| `/api/health/services`, `/api/health/attention` | GET/POST | `CRON_SECRET` | – | Live probes |
| `/api/health` | GET | public | – | Verdict only, no internals |

Routes that change **nothing** in this matrix and needed no limit are the pure
cookie/read helpers (`/api/auth/me`, `/api/auth/logout`).

---

## 5. Required Vercel / Cloudflare rules (MANUAL — not yet applied)

These cannot be set from the repository. Apply them in the dashboard and only
then consider the route protected at the edge.

**Cloudflare (WAF → Rate limiting rules), per IP, sliding/1-minute window:**

| Path | Limit | Action |
|---|---|---|
| `/api/*` | 300/min | Managed Challenge → Block |
| `/api/auth/*` | 20/min | Block |
| `/api/payments/*` | 30/min | Block |
| `/api/videos/*` (non-media) | 120/min | Managed Challenge |
| `/api/media/*` | 600/min | Managed Challenge |
| `/api/webhooks/*` | 60/min | Block, allowlisted source IPs only |
| `/api/search/*`, `/api/home-feed` | 120/min | Managed Challenge |

* Enable **Bot Fight Mode** / managed challenge on `/api/auth/*` and `/api/payments/*`.
* Set an edge **request body size limit** (e.g. 1 MB for `/api/*`; larger only for
  the upload path) so oversized bodies are rejected before the function runs.
* **Cache** safe public GETs (`/api/home-feed`, `/api/videos`, `/api/creators`,
  `/api/media/*`) at the edge; ensure `Set-Cookie`/`Authorization` bypass cache
  and **never** cache `/api/*` responses carrying `Cache-Control: private, no-store`.
* Do not apply geographic/ASN blocking without a justified abuse pattern.

**Vercel:** enable Deployment Protection on preview deployments; keep
`NODE_ENV=production` and `VERCEL_ENV=production` on the production project so
demo/dev routes stay disabled.

---

## 6. Authentication & privilege

* `requireAuth` re-reads **ban state and current role from the database** (cached
  ~60s, invalidated on role changes). A demoted admin loses power within the
  cache window; a banned/deleted account is refused immediately.
* Sessions are invalidated on account deletion (the row is gone → token refused).
* Demo/dev login is gated by `developmentOnlyEnabled()` (two signals, not just
  `NODE_ENV`).
* Login and reset responses never disclose whether an email/account exists.

---

## 7. Residual risks requiring infrastructure or follow-up

1. **Edge WAF not applied.** Until §5 is configured, only application limits
   apply. There is no edge bot protection, no global connection cap, and no
   L3/L4 DDoS mitigation in this repo.
2. **Admin routes have no per-admin application rate limit** (authorization is
   DB-backed, but a compromised admin session is unbounded in code). Enforce at
   the edge, then consider a shared admin limiter.
3. **Role fails open on a database blip.** `accountStatusFor` returns `null` when
   the DB does not answer, and `requireAuth` keeps the token's role. This avoids a
   site-wide demotion during an outage; a stricter mode (fail closed for ADMIN
   routes) is a policy decision left open.
4. **CSP allows `'unsafe-inline'`** for scripts/styles (Next.js hydration +
   inline styles). A nonce-based policy needs build plumbing.
5. **`next/image` remote hosts** include `storage.freebuff.co.tz` /
   `storage.genhub.co.tz`; keep these to the exact CDN hosts you operate. Any
   host here is a URL a client-supplied image src can point at.
6. **No request coalescing / lock on expensive cache misses yet.** Cache-miss
   stampedes on `/api/home-feed` are bounded by the rate limit but not
   deduplicated; a Redis-backed lock would remove the remaining thundering herd.
7. **Database indexes** for `isPublished`/`isDeleted`/`creatorId`/`encodingStatus`
   /`createdAt`/payment status should be confirmed against `prisma/schema.prisma`
   and added where missing (the listing routes filter on them).
8. **Email is not configured** — see §8. Password reset cannot work until SMTP is
   set in the deployed environment.

---

## 8. Password-reset email is not being delivered — root cause and fix

**Root cause (found, not guessed):** no `SMTP_*` / `EMAIL_FROM` variables are set
in any environment file in this repository, including the Vercel env export
(`.env.vercel.upload`). With `SMTP_HOST` unset, `sendMail` uses the **console
transport** — it reports `{ sent: true, transport: "console" }` and the message
is only written to the server log. No email leaves the server, for password reset
or welcome mail.

**Fix (operator action, in the deployed environment):**

```
SMTP_HOST=smtp.resend.com          # or smtp.gmail.com / smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=...                      # provider username / "resend"
SMTP_PASS=...                      # provider API key / app password
EMAIL_FROM=Genhub <no-reply@your-verified-domain>
```

* `EMAIL_FROM` **must** be on a domain you have verified with the provider, or
  every message is refused/dropped even with correct credentials. A `.local`
  default will never deliver — `productionConfigWarnings()` now flags it.
* Verify with `npm run verify:live` (opens real SMTP), then request a reset and
  watch for the `[Password Reset] ... transport=smtp sent=true` log line.
* Code changes in this pass make the failure **visible**: a production deploy
  with no `SMTP_HOST` now raises a credential alert (log + `ALERT_WEBHOOK_URL`).

---

## 9. Required environment variables

Already required and unchanged: `DATABASE_URL`, `JWT_SECRET`,
`NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, ClickPesa keys, Bunny keys.

**Now effectively required for the hardening to be distributed:**
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or a managed `REDIS_URL`).
Without them, security-critical routes will answer `503` during the per-instance
fallback window — this is intentional (fail closed), but it means **Redis is now
on the critical path for auth and payments**. Configure it before launch.

**Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.

---

## 10. Verification

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest (includes request-hardening + status privacy)
npm run audit:endpoints    # every UI fetch maps to a real route+method
npm run build              # prisma generate && next build
npm audit --omit=dev       # dependency advisories
```

Load testing is **not** performed against production. Any load test must run
against a staging deployment with small, bounded traffic.

---

## 11. Confirmations

* **No secrets exposed.** No secret values were read, printed, added to code, or
  sent anywhere. Env files were inspected by variable **name only**.
* **No user changes deleted.** Only files listed in the change summary were
  edited; the only pre-existing untracked content (`tmp-emu/`) was left untouched.
* **Nothing was committed, pushed, or deployed.**
