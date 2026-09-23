# Genhub — Production Deployment Checklist

Everything to verify before Genhub goes live as a real website. Work top to\-bottom; each section is self-contained.

---

## 0. First deploy + launch scripts

```bash
cp .env.example .env.local        # fill in real values (template documents every key)
npm ci                            # clean install
npm run typecheck && npm test     # gates: 158 tests incl. HarakaPay E2E + live-mode
npm run preflight:prod            # THE LAUNCH GATE — exits 1 while blockers remain
npm run build                     # prebuild re-runs the env check, in strict mode
npm run preflight:prod -- --url https://your-domain.com   # after deploy: + live health
```

### 0.1 The two guards that stop a bad deploy

`npm run build` runs `prebuild` → `verify:gateway` (no decommissioned payment
provider may return) → `verify:env`. `verify:env` decides how strict to be from
the environment, not from your laptop:

| Where | Mode | Behaviour |
|---|---|---|
| Laptop / CI without `NODE_ENV=production` | advisory | prints every problem, exits **0** — a local build never fails for a missing Bunny key |
| Vercel / any pipeline with `NODE_ENV=production`, or `--strict` | strict | missing or placeholder settings **fail the build** |

`preflight:prod` is the same list plus the checks that need the network
(live `/api/health`, and the HarakaPay balance). Treat it as the gate: **do not
deploy while it exits 1.**

Integration smoke tests (move from “code exists” to “credentials proven”):

| Script | What it proves |
|---|---|
| `npm run smoke:harakapay` | Read-only `GET /api/v1/balance` — API key works, no money moves |
| `npm run smoke:harakapay -- --collect 1000 0712345678` | **Real** USSD push — confirm on your handset, then check the webhook completed the transaction |
| `npm run smoke:bunny` | Stream API key + library lookup |
| `npm run smoke:bunny -- --storage` | + storage-zone write access (thumbnails) |
| `npm run admin:create you@domain.com` | Promote your signup to ADMIN (production has **no** demo-login) |
| `npm run admin:create you@domain.com --create` | Create the admin account with a printed temp password |

Deploy to Vercel:

```bash
npm i -g vercel
vercel link                              # attach the project
# add every .env.local key via the dashboard (Settings → Env Vars)
#   or: vercel env add KEY production    (repeat per key)
vercel --prod
```

`vercel.json` already schedules `/api/cron/release-earnings` hourly; Vercel
calls it with `Authorization: Bearer $CRON_SECRET` automatically.

After deploy: set `NEXT_PUBLIC_APP_URL` to the final `https://` domain
**before** sharing links — it feeds sitemap, OG tags, webhooks and referral
links.

Ordered runbook (copy-paste):

```bash
# 1) gates — all must pass
npm ci
npm run typecheck && npm test && npm run audit:endpoints && npm run build

# 2) production database
export DATABASE_URL="postgresql://…prod…"
npx prisma db push

# 3) deploy
npm i -g vercel && vercel link
#    add every .env.local key in the dashboard (Settings → Env Vars)
vercel --prod

# 4) post-deploy verification
npm run preflight -- --url https://your-domain.com   # blockers + live health
npm run smoke:harakapay                             # read-only key check
npm run smoke:bunny -- --storage                    # stream + storage check
npm run admin:create you@domain.com                 # bootstrap the first admin

# 5) manual console steps
#    - register the webhook URL in the HarakaPay dashboard
#    - submit https://your-domain.com/sitemap.xml to Google Search Console
#    - buy your cheapest video with a real phone once (smoke:harakapay --collect)
```

---

## 1. Secrets & repository hygiene

- [ ] `.env.local` and `.env` are ignored by git (already in `.gitignore`) —
      **never** commit them. If this repo is new, run `git init` and confirm
      `git status` does not list `.env*` before the first commit.
- [ ] Rotate every development secret before production (they were shared in
      dev and are considered public):
      - `JWT_SECRET` → `openssl rand -hex 32`
      - `CRON_SECRET` → `openssl rand -hex 24`
      - `HARAKAPAY_WEBHOOK_TOKEN` → `openssl rand -hex 24`
- [ ] No API keys appear in source files, commits, or client bundles
      (`NEXT_PUBLIC_*` values are visible to every visitor by design — keep
      only truly public values there).

## 2. Environment variables

Set these in your hosting provider (Vercel → Project → Settings → Env vars):

| Variable | Production value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Real domain, no trailing slash (`https://genhub.co.tz`) |
| `NEXT_PUBLIC_APP_NAME` | `Genhub` |
| `DATABASE_URL` | Managed Postgres (SSL, daily backups) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Managed Redis over HTTPS (preferred) |
| `REDIS_URL` | Managed Redis over TCP — the alternative if you only have this |
| `JWT_SECRET` | Fresh random 64-hex |
| `JWT_EXPIRES_IN` | `7d` |
| `COOKIE_NAME` | `genhub_token` |
| `PAYMENT_SANDBOX` | **`false`** — while `true` the app never calls the gateway, so **no USSD push is sent at all** |
| `HARAKAPAY_API_KEY` | Live `hpk_…` key |
| `HARAKAPAY_BASE_URL` | `https://harakapay.net` |
| `HARAKAPAY_WEBHOOK_TOKEN` | Fresh random 48-hex |
| `CRON_SECRET` | Fresh random 48-hex |
| `SMTP_HOST` / `SMTP_PORT` | e.g. `smtp.resend.com` / `587` |
| `SMTP_USER` / `SMTP_PASS` | SMTP credentials (app password for Gmail) |
| `EMAIL_FROM` | e.g. `Genhub <no-reply@your-domain>` (must match the SMTP domain) |
| `AT_API_KEY` / `AT_USERNAME` | Africa's Talking API key + username (SMS for phone-only accounts) |
| `AT_SENDER_ID` | Optional SMS sender ID |
| `BUNNY_STREAM_API_KEY` | Stream library API key (Stream → your library → API tab) |
| `BUNNY_STREAM_LIBRARY_ID` | Stream library id |
| `BUNNY_CDN_HOSTNAME` | Pull-zone hostname, e.g. `genhub.b-cdn.net` |
| `BUNNY_TOKEN_SECRET` | Token Authentication key of that pull zone — **required**, see 2.1 |
| `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_ACCESS_KEY` | Optional: only for thumbnail uploads |
| `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Registered entity — shown on `/2257` |
| `NEXT_PUBLIC_COMPANY_ADDRESS` | Custodian's real place of business (28 C.F.R. § 75.2 requires it) |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Compliance/reporting inbox |

After setting variables, hit `GET /api/health` — its `warnings[]` array runs
the same audit (`productionConfigWarnings()` in `src/lib/config.ts`) and must
be **empty** in production. The admin panel shows the same list under
**Admin → Overview → System readiness**, together with the app URL, the video
host, email/SMS transport and the gateway float, so nobody needs shell access
to answer "is this deployment actually live?".

### 2.1 `NEXT_PUBLIC_APP_URL` — the one variable that silently breaks webhooks

HarakaPay's `webhook_url`, the SEO tags, referral links and password-reset links
are all built from the app URL. If it is wrong, the gateway cannot call us back.

The app now resolves it in this order and reports which source it used:

1. `NEXT_PUBLIC_APP_URL`, when set and not localhost ← **set this explicitly**
2. `VERCEL_PROJECT_PRODUCTION_URL` (Vercel's stable production domain)
3. `VERCEL_URL` (per-deployment URL — preview deployments)
4. `http://localhost:3000` (development)

The fallbacks stop a forgotten variable from breaking callbacks entirely, but
they are a safety net, not the design: `/api/health` warns whenever the URL was
inferred, and `preflight:prod` blocks a localhost URL outright. Check it with
`Admin → Overview → System readiness` ("App URL … (from NEXT_PUBLIC_APP_URL)").

### 2.2 Bunny.net — Token Authentication must be ON

The player, the teaser and the members-only download all use signed Bunny URLs.
The signature is `HMAC-SHA256(BUNNY_TOKEN_SECRET, expires + path)`, so:

- [ ] **Token Authentication enabled on the pull zone**, and the same key in
      `BUNNY_TOKEN_SECRET`. Without it the CDN ignores our tokens and anyone can
      hot-link paid video.
- [ ] `npm run smoke:bunny` returns the library name (proves the key + id).
- [ ] `npm run smoke:bunny -- --storage` if you want thumbnails stored in Bunny.
- [ ] Play one **paid** video end to end: the `<video>` source must contain
      `?token=…&expires=…`. If it does not, playback is unsigned.

The signing code throws rather than emitting an URL signed with an empty secret
— an unsigned-but-labelled-signed URL is worse than none, because it looks safe.

## 3. Payments go-live (HarakaPay)

- [ ] `PAYMENT_SANDBOX=false` — while it is `true` the app never contacts
      HarakaPay, so **no USSD prompt reaches the customer's phone**. Flip it and
      restart before testing.
- [ ] Register the webhook in the HarakaPay dashboard:
      `https://<domain>/api/webhooks/harakapay?t=<HARAKAPAY_WEBHOOK_TOKEN>`
- [ ] Check `GET /api/payments/health` (as admin). It reports sandbox state, key,
      webhook token, whether `NEXT_PUBLIC_APP_URL` is publicly reachable, and the
      live HarakaPay wallet/float balance. `readyForLive` must be `true`.
- [ ] The webhook is only an optimisation: if it never arrives, the client polls
      `/api/payments/status/<orderId>`, which reconciles against HarakaPay and
      settles the transaction anyway. A localhost `NEXT_PUBLIC_APP_URL` therefore
      still works, it is just slower to confirm.
- [ ] `POST /api/dev/sandbox/complete` is automatically **disabled** once
      `PAYMENT_SANDBOX=false` + an API key are set, so nobody can fake a purchase.
      It only works in test mode (`src/tests/setup-env.ts` forces it on).
- [ ] Smoke-test with a real, small amount:
      1. Buy the cheapest video → USSD prompt arrives → confirm.
      2. `GET /api/payments/status/<orderId>` flips `PENDING → SUCCESS`.
      3. DB: `platformFee` = 30 %, `creatorCut` = 70 %, `VideoAccess` row exists.
- [ ] Test one wallet top-up the same way.
- [ ] Confirm a failed/cancelled payment marks the transaction `FAILED`
      without granting access.
- [ ] Confirm the customer is **notified** (in-app bell + email when they have an
      address) when a charge settles or fails. This is fired once per charge from
      `processPaymentWebhook` / the expiry paths via
      `src/lib/services/payment-notify.service.ts`; a mail failure is logged and
      never blocks settlement.
- [ ] Confirm a failed video purchase can be re-paid from the wallet balance
      (`POST /api/payments/purchase` with `"method": "WALLET"`, offered on
      `/payments` when the balance covers it). Charge, 70/30 split and access are
      one atomic transaction — a customer can never be debited without being
      unlocked, and an insufficient balance returns `402 INSUFFICIENT_WALLET`
      having moved nothing.
- [ ] Only **HarakaPay** may process payments. `npm run build` runs
      `verify:gateway` first and fails if another gateway reappears in the Prisma
      enum, in `src/lib/payments`, or anywhere in shipped source. The runtime lock
      lives in `src/lib/payments/gateway.ts`.

### 3.1 When the customer's phone never rings

`POST /api/v1/collect` can return `success: true` and the order can sit on
`processing` forever without any USSD prompt reaching the handset. Our side is
working in that case — the fault is on the merchant account. **Start here:**

```bash
node scripts/preflight.mjs --production --gateway
#   ✓ API key is valid — wallet 0, float 0
#   ✗ Merchant float is 0 — HarakaPay accepts our request and reports "USSD
#     push sent", but the prompt does not reach the customer and the order
#     stays `processing` forever.
```

A zero `float_balance` is the single most common cause and the one thing no code
change can fix: it is funded in the HarakaPay dashboard. Everything below is the
longer diagnostic for when the float is funded and prompts *still* do not arrive.
Use `GET /api/payments/health` (admin) as the dashboard:

1. **Is it really leaving the building?**
   `curl -H "x-api-key: $HARAKAPAY_API_KEY" -H 'Content-Type: application/json' \
     -d '{"phone":"0712345678","amount":1000}' https://harakapay.net/api/v1/collect`
   A `{"success":false,"error":"Invalid mobile number."}` reply for a bogus
   number proves connectivity and key auth. Compare the `order_id` format with a
   known-good live order (`HP…`).
2. **Phone format is NOT the usual culprit.** `0682642219`, `255682642219` and
   `+255682642219` are all accepted identically, so a silent push points at the
   account, not the number.
3. **Ask HarakaPay to confirm, in writing:**
   - is the merchant account **activated for live collections**?
   - is `HARAKAPAY_API_KEY` a **production** key (not a test key)?
   - is the **merchant float funded**? `GET /api/v1/balance` returning
     `wallet_balance: 0` / `float_balance: 0` is the strongest signal that
     collections cannot settle.
   Send the order ids (`HP…`) and timestamps from `/api/payments/health`
   (`delivery.stuckPending`) as evidence.
4. **Until it is fixed**, no money moves and no access is granted — customers
   are never charged by a prompt they never saw. `delivery.deliveryWarning` on
   `/api/payments/health` surfaces the symptom instead of hiding it.
5. **Release a single stuck checkout without database access:** Admin → Payments
   lists charges (Pending / Completed / Failed) with age, provider reference and
   customer, and force-expires one charge so the customer's checkout lock is
   released. The same soft-expire semantics as the sweeper apply: the row becomes
   `FAILED` with `metadata.expired`, a late settlement is still honoured, and the
   customer is notified. API: `GET /api/admin/payments?status=PENDING` and
   `POST /api/admin/payments { transactionId }`. The sweeper already does this
   automatically an hour after checkout.

## 4. Background jobs

Four schedulers ship in `vercel.json`:

| Cron | Schedule | Purpose |
|---|---|---|
| `/api/cron/release-earnings` | hourly | 14-day holding release |
| `/api/cron/reconcile-payments` | every 10 min | settle PENDING gateway orders, flag never-settled ones as under investigation |
| `/api/cron/renew-subscriptions` | hourly (minute 15) | charge memberships that expire within 24h |
| `/api/cron/poll-encoding` | every 3 min | publish uploaded videos once Bunny Stream can serve them, and tell the creator |

On the **Hobby (free) plan these will not deploy** — Vercel limits Hobby cron to
once per day. Remove the `crons` block and use the four GitHub Actions
workflows in `.github/workflows/` instead. See §4.0.1.

### 3.2 Video processing (why a new upload is not live immediately)

Bunny Stream accepts an upload seconds after the browser starts sending, then
spends minutes transcoding. A video Bunny has to transcode is therefore created
**unpublished** and released by `/api/cron/poll-encoding` the moment Bunny
reports it playable; the creator gets one notification at that point.

`encodingStatus` on the video row is what tracks this:

| Bunny status | Meaning |
|---|---|
| `0` / `1` | queued / uploaded — held |
| `2` / `3` | processing — held, with a live percentage in the creator dashboard |
| `4` | finished — published and notified |
| `5` | error — creator told the reason, never published |
| `NULL` | not tracked (side-loaded/demo rows) — publication is never touched |

Two escape hatches exist on purpose, because an automatic gate with no exit is
worse than no gate:

- **The creator's dashboard polls for them.** Opening it advances their own
  pending uploads, so the lifecycle still completes on a host with no scheduler.
- **Publish now** — the creator can override the gate from the dashboard. It
  warns that the video may not play yet, then publishes it. Use this when Bunny
  never reports a video as finished.

- [ ] Confirm the cron is listed: **Vercel → your project → Cron Jobs**,
      and `curl -H "x-cron-secret: $CRON_SECRET" https://<domain>/api/cron/poll-encoding`
      returns `{"status":"ok",...}`.
- [ ] Upload one real video and watch it move `Processing → Ready` in
      **Creator Dashboard → Video Performance → Status**.

The release job moves matured earnings `pendingBalance → availableBalance`:

- [ ] **Vercel**: `vercel.json` already schedules
      `/api/cron/release-earnings` hourly (Vercel sends
      `Authorization: Bearer $CRON_SECRET` automatically).
- [ ] **Other hosts / GitHub Actions**: `.github/workflows/release-earnings.yml`
      runs hourly — set repository variable `APP_URL` and secret `CRON_SECRET`.
- [ ] Verify: `curl -H "x-cron-secret: $CRON_SECRET" https://<domain>/api/cron/release-earnings`
      → `{"success":true,...}` (wrong/missing secret must return 401).
- [ ] Admins can also trigger releases manually from **Admin → Earnings**.

### 4.0 How cron routes are authorized

`CRON_SECRET` must arrive in a **header** — `Authorization: Bearer …` (what
Vercel Cron sends) or `x-cron-secret: …` (what the GitHub Actions workflow
sends). Both are accepted; nothing else is.

The `?secret=…` query form was **removed**, and that is deliberate. Query
strings are written to access logs, proxy logs and CDN logs, so a secret sent
that way ends up retained somewhere other than the server's environment. This
one releases creator earnings into a withdrawable balance and charges subscriber
cards, so a leaked copy is directly replayable by anyone who can read a log.
Neither scheduler needs the query form, and a request that tries it now gets a
401 that names the reason:

```
Cron secret must be sent in the Authorization header or x-cron-secret —
query strings are logged and are not accepted
```

Two other properties, both enforced in `src/lib/cron-auth.ts` (one
implementation for all four cron routes, so they cannot drift apart again):

- **Timing-safe comparison.** Both sides are SHA-256 hashed and compared with
  `crypto.timingSafeEqual`, so the response time does not reveal how many
  leading characters were correct, and the hash keeps the buffers the same
  length (an unequal-length compare would throw and leak the secret's length).
- **Fails closed.** With no `CRON_SECRET` set, a production request is refused
  rather than allowed through unauthenticated. Outside production it proceeds,
  so local work needs no scheduler configured.

Verify all four combinations:

```bash
B=https://<domain>; S=$CRON_SECRET
curl -s -o /dev/null -w "header:  %{http_code}\n" -X POST $B/api/cron/release-earnings -H "x-cron-secret: $S"   # 200
curl -s -o /dev/null -w "bearer:  %{http_code}\n" -X POST $B/api/cron/release-earnings -H "Authorization: Bearer $S" # 200
curl -s -o /dev/null -w "query:   %{http_code}\n" -X POST "$B/api/cron/release-earnings?secret=$S"                  # 401
curl -s -o /dev/null -w "wrong:   %{http_code}\n" -X POST $B/api/cron/release-earnings -H "x-cron-secret: wrong"     # 401
```

### 4.0.1 Choosing a scheduler: Vercel Cron or GitHub Actions

The table above is `vercel.json`, and it is correct for **Pro/Enterprise**. On
the **Hobby (free) plan it will not deploy at all**. Vercel restricts Hobby cron
to **once per day**, and a more frequent expression fails the build:

```
Hobby accounts are limited to daily cron jobs.
This cron expression would run more than once per day.
```

Every worker here runs sub-daily — hourly, every 10 minutes, every 3 minutes —
so on Hobby **remove the `crons` block from `vercel.json`** and let GitHub
Actions drive them instead. One workflow per worker, all four already in the
repo:

| Workflow | Schedule | Endpoint |
|---|---|---|
| `.github/workflows/release-earnings.yml` | hourly | `/api/cron/release-earnings` |
| `.github/workflows/reconcile-payments.yml` | every 10 min | `/api/cron/reconcile-payments` |
| `.github/workflows/renew-subscriptions.yml` | hourly (minute 15) | `/api/cron/renew-subscriptions` |
| `.github/workflows/poll-encoding.yml` | every 5 min | `/api/cron/poll-encoding` |

They all authenticate the same way Vercel Cron does — header only, never a
query string (see §4.0) — so no code changes are needed to switch. Configure
this **once** per repository; every workflow reads the same two values:

```
GitHub → your repo → Settings → Secrets and variables → Actions
  Variables  → New variable → APP_URL = https://your-domain      (no trailing slash)
  Secrets    → New secret   → CRON_SECRET = <same value as the server's CRON_SECRET>
```

Until both are set, each job **skips and exits green** rather than failing, so
the Actions tab stays quiet instead of red while you are still setting up.

Three caveats worth knowing before you rely on this:

- **GitHub's minimum interval is 5 minutes**, so `poll-encoding` runs every 5
  minutes rather than the 3 minutes `vercel.json` asks for. Nothing breaks: the
  worker is idempotent and a creator can still advance their own uploads by
  opening the dashboard. A finished encode just surfaces within 5 minutes.
- **Scheduled workflows are disabled after 60 days of repository inactivity.**
  GitHub emails the owner first, and any commit re-enables them — but on a quiet
  repo, payments and renewals would stop. Budget one commit (or a
  `workflow_dispatch` run) every couple of months, or move to Pro and use Vercel
  Cron, which has no such rule.
- **These run off GitHub's clock, not yours.** Schedules are delayed during
  periods of high load, so treat the interval as "roughly", not "exactly".
  Every worker is written to be safe under a late or duplicated run —
  `release-earnings` only ever moves matured balances, `renew-subscriptions`
  charges at most once per `RETRY_GAP`, and `poll-encoding` only ever flips
  unpublished → published.

Verify after switching:

```bash
B=https://<domain>; S=$CRON_SECRET
for r in release-earnings reconcile-payments renew-subscriptions poll-encoding; do
  printf "%-22s " "$r"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/api/cron/$r" -H "x-cron-secret: $S"
done   # expect four 200s; a wrong secret must give 401
```

Each workflow is also runnable by hand from **Actions → <workflow> → Run
workflow**, which is the fastest way to confirm `APP_URL` and `CRON_SECRET` are
wired correctly without waiting for the schedule.

### 4.1 Charges nobody can classify yet (`UNDER_INVESTIGATION`)

A USSD push ends in one of four ways, and only one of them produces a webhook:

| Ended how | What we see | What happens |
|---|---|---|
| Customer approved it | webhook, or the sweeper finds `completed` | settles normally |
| Customer declined / ignored it | gateway says `failed` / `cancelled` | `FAILED`, customer may retry |
| Prompt never reached the handset | stays `processing` forever | *identical to the next row* |
| **Approved, but the gateway never settled** | stays `processing` forever | **money left the handset** |

The last two are indistinguishable from our side, and treating them as a
failure is how one purchase gets charged twice: the customer approved the
prompt, we say *"payment failed — try again"*, and they pay again.

So a charge the gateway still calls `processing` **past the 1-hour hard TTL**
becomes `UNDER_INVESTIGATION`, and the customer is told the opposite of "failed":

> We are checking this with your network — **do not pay again**. If the money did
> leave your phone we will unlock your purchase, and if it did not we will release
> the charge so you can retry.

The video paywall stops offering the video for sale while that is open, so the
customer cannot accidentally buy it twice from the video page either.

**Resolving one (Admin → Payments → Being checked, badge on the tab):**

| Action | Use when | Effect |
|---|---|---|
| **Re-check gateway** | always, first | asks HarakaPay again; settles it if there is a verdict, changes nothing if it still says `processing` |
| **Customer paid** | the operator confirms the debit | settles through the normal webhook path: 70/30 split, creator credited to *pending*, purchase unlocked |
| **Never paid** | the operator confirms no debit | releases the charge and tells the customer it is safe to retry |

Both decisions are reversible in the only direction that matters: **a settlement
arriving later is always honoured**, including after "Never paid". Releasing can
therefore never lose money that the network actually took. `GRANT` and
`MARK_UNPAID` record `resolvedBy` and an optional note on the transaction for the
audit trail.

How to see the size of the queue:

- [ ] Admin → Payments → *Being checked with networks* counter.
- [ ] `GET /api/payments/health` → `delivery.underInvestigation` and
      `delivery.investigationWarning`.

A queue that keeps growing on a **new merchant account** almost always means the
same thing as §3: the HarakaPay float is unfunded, so collects are accepted but
never settled. Check `GET /api/v1/balance` before working the queue by hand.

### 4.2 Refunding a charge that turned out to have been collected

When an investigation concludes **the customer did pay but cannot get what they
bought**, an admin reverses the charge: **Admin → Payments → Refund** (available
on any `UNDER_INVESTIGATION` or `SUCCESS` charge — a customer can ask weeks
later). The transaction becomes `REFUNDED` and drops out of platform revenue
automatically, because every revenue figure sums `status = 'SUCCESS'`.

#### HarakaPay has no reversal API

Its entire surface is `POST /api/v1/collect`, `GET /api/v1/status/{id}` and
`GET /api/v1/balance`. Every plausible reversal path (`/reverse`, `/reversal`,
`/refund`, `/refunds`, `/refund/{id}`, `/reverse/{id}`, `/payout`, `/disburse`,
`/withdraw`, `/cancel`) answers with the same Express HTML 404 as a deliberately
fake route, while `POST /api/v1/collect` returns a real business error. **The
network leg cannot be automated.** That is why the refund has two destinations:

| Destination | Who moves the money | Customer gets |
|---|---|---|
| **Wallet credit** | us, atomically, instantly | spendable balance now |
| **Back to their phone** | **you, in the HarakaPay dashboard** | money on their handset in up to 48h; the wallet is not touched |

For a network reversal the integration **requires the HarakaPay reference**
(`gatewayReversalRef`). We cannot verify it, so it is recorded as the evidence
that the money went back — never inferred. A reversal to the customer's phone
must never be recorded from memory.

#### The two double-payment traps, and how they are closed

1. **Wallet + network.** A `WALLET` refund never asks the gateway for anything,
   so it cannot be paid twice; a `GATEWAY` refund never credits the wallet, so the
   customer is told to look at their phone, not their balance.
2. **Reversing a top-up "to the wallet".** A top-up *is* wallet credit already,
   so crediting it again is a straight loss. That combination is rejected
   (`WALLET_REFUND_OF_TOPUP`); returning a top-up means debiting the wallet
   (`WALLET_TOPUP` + `GATEWAY`), and it is refused outright if the customer has
   already spent the credit (`INSUFFICIENT_WALLET`).

#### The creator's 70%

It is clawed back from `pendingBalance` first, then `availableBalance`, and never
driven negative — the release job's optimistic lock requires
`pendingBalance >= amount`, so a negative balance would corrupt it silently.
Anything that had already been paid out is recorded as `refundShortfall` on the
transaction rather than hidden.

**Only a charge that settled has anything to claw back.** A charge reversed while
still under investigation never went through settlement, so the creator was never
credited (`creatorCut` is `null`, there is no `videoEarning` row) — clawing back
there would take money they never received. Those reversals are skipped entirely
and are a cost the platform chooses to absorb.

#### Recovery is automatic

The 14-day release job computes matured earnings as
`SUM(creatorCut) WHERE status = 'SUCCESS'`, so a `REFUNDED` row simply leaves that
sum. If the creator had already been paid out, `releasedTotal` now exceeds what is
genuinely matured and the job **stops releasing** until new sales cover the
difference. No debt ledger, no manual adjustment: their future earnings repay the
reversal.

- [ ] After any refund, check **Admin → Earnings** shows the reduced holding for
      that creator.
- [ ] `refundShortfall` on a transaction means money left the business. Review
      those before month end.

### 4.3 Subscription auto-renewal

`/api/cron/renew-subscriptions` is what makes a membership renew itself. A
membership enters the renewal window **24 hours before `expiresAt`**, then:

1. **Wallet first** — if the fan's balance covers the price it is charged
   instantly. Debit, 70/30 split, and the extended `expiresAt` commit in one
   transaction (`grantSubscription` in `lib/services/subscription.service.ts`).
2. **USSD push** — otherwise a normal `SUBSCRIPTION` checkout is created and
   HarakaPay pushes to `renewPhone` (the number the fan last paid with). It
   settles through the usual webhook / status poll / sweeper.
3. **Failure** — the reason is stored on the subscription and the fan is
   notified. Retries are spaced 6 hours apart, at most 4 per period; after that
   the membership lapses (`isActive=false`) and the fan re-subscribes manually.

Things worth knowing:

- The period is extended from the **old** `expiresAt`, never from "now", so a
  fan who renews early never loses paid-for days.
- Only one live charge per membership at a time. While ANY renewal checkout is
  still `PENDING` — however old — no new one is started: a late settlement of
  the first would otherwise extend the membership twice for one payment. The
  sweeper clears abandoned checkouts after an hour, which releases the block.
- At most 4 attempts per period, spaced 6 hours apart.
- A membership that lapsed **more than 7 days** ago is never charged. If this
  cron was down for a while, fans must re-subscribe deliberately rather than
  being billed for months of downtime the moment it comes back.
- Fans control this themselves: **Billing → Auto-renew on/off**
  (`PATCH /api/subscriptions`). Cancelling a membership turns it off too.
- **Hosts other than Vercel** must schedule this route themselves, alongside
  `release-earnings`. `curl -H "x-cron-secret: $CRON_SECRET"
  https://<domain>/api/cron/renew-subscriptions` must return 200, and 401
  without the secret.
- To watch it work: create a membership, set `expiresAt` to an hour from now in
  UTC, run the route, and check `creatorSubscription.expiresAt` moved forward a
  month while `creatorBalance.pendingBalance` grew by 70%.

## 5. Database

Migrations are real and versioned in `prisma/migrations/`. The initial
`20260922120000_init` migration is the schema baseline.

- [ ] **Production uses `migrate deploy`, never `db push`.**
      `db push` cannot produce a rollback trail and silently drops columns.

```bash
# local development — change schema.prisma, then:
npx prisma migrate dev --name add_something

# production (idempotent; safe to re-run on every deploy)
npm run db:deploy        # prisma migrate deploy
npm run db:status        # prisma migrate status — must say "up to date"
```

- [ ] Add `npm run db:deploy` to the deploy pipeline **before** the app starts.
      On Vercel that means a `postinstall`/build step or a release command, so a
      schema change never lands while old code is still serving traffic.
- [ ] `DATABASE_URL` points at **managed Postgres** (Neon / Supabase / RDS /
      Railway), not localhost. `npm run preflight:prod` blocks on this.
- [ ] Redis is managed, via **either** the Upstash REST pair
      (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, preferred: HTTPS,
      no TCP pool held open between serverless invocations) **or** a
      `rediss://` `REDIS_URL`. The REST pair wins when both are set. Without
      one of them rate limiting degrades to per-instance counters and every
      deploy starts with a cold cache — payment and auth throttling then depend
      on how many instances happen to be running.
- [ ] Seed demo content **only** in dev — production starts clean
      (register the first admin through a controlled signup + role grant).
- [ ] Automated backups enabled (PITR or daily snapshots) and a restore has
      been tested once.
- [ ] **Manual SQL: use UTC.** Prisma stores `DateTime` columns as
      `timestamp without time zone` in **UTC**, but a `psql` session inherits the
      server timezone (e.g. `Africa/Nairobi`, UTC+3). Running
      `insert ... values (now())` by hand therefore writes a timestamp hours in
      the future, which makes age-based logic (`/api/admin/payments` “stuck”
      detection, the sweeper cutoff) misread it. Use
      `now() at time zone 'UTC'` for hand-written rows; application code is
      unaffected.

## 6. SEO & discoverability

- [ ] `NEXT_PUBLIC_APP_URL` = canonical domain (it feeds `sitemap.xml`,
      `robots.txt`, canonical/OG tags and referral links).
- [ ] Submit `https://<domain>/sitemap.xml` to Google Search Console.
- [ ] Spot-check rich results: `/browse/music`, a creator page and a video
      page should show correct titles/previews (rich results test tool).
- [ ] Age-gode + 18+ labeling stays as-is (legal requirement).

## 7. Final verification (post-deploy smoke test)

```bash
DOMAIN=https://genhub.co.tz

npm run preflight -- --url $DOMAIN      # one-shot audit: blockers + health + warnings

curl -fsS $DOMAIN/api/health           # status=ok, warnings=[], checks.email=smtp
curl -fsS $DOMAIN/robots.txt           # allows / , sitemap line present
curl -fsS $DOMAIN/sitemap.xml          # browse + creator + video URLs
curl -o /dev/null -w "%{http_code}\n" $DOMAIN/browse/all        # 200
curl -o /dev/null -w "%{http_code}\n" $DOMAIN/creator/<id>      # 200 (+ JSON-LD)
curl -o /dev/null -w "%{http_code}\n" $DOMAIN/creator/nope      # 404
curl -H "x-cron-secret: $CRON_SECRET" -X POST $DOMAIN/api/cron/release-earnings   # 200
curl -o /dev/null -w "%{http_code}\n" -H "x-cron-secret: wrong" \
     $DOMAIN/api/cron/release-earnings                          # 401
```

Manual checks:

- Request a password reset → the **email actually arrives** (with SMTP unset
  it is only logged server-side — `checks.email` in `/api/health` shows which).
- Request a password reset for a **phone-only account** → the **SMS arrives**
  (`checks.sms` in `/api/health`; Africa's Talking sandbox works with
  `AT_USERNAME=sandbox` for a dry run).
- Sign up a fresh account → welcome email arrives.
- Run `npm run smoke:harakapay` from your machine against the live key.


Automated gates: `npm run typecheck` · `npm test` (158 tests incl. HarakaPay live-mode
E2E against a DB) · `npm run preflight:prod` · `npm run build`.

## 8. Operations

- [ ] Uptime monitor on `GET /api/health` (503 = degraded, check `checks.database`).
- [ ] Log aggregation for `[HarakaPay …]`, `[Webhook]`, `[Cron …]` prefixes.
- [ ] Rate limits verified (Redis-backed; without Redis they fail **open**, so
      Redis must be up in production).

### 8.0 What a non-paying viewer can watch

**A teaser is a separate asset, by design.** This is not a stylistic choice —
Bunny's token authorises a *path*, and there is no way to ask it for "the first
30 seconds". So signing a paid scene's own `playlist.m3u8` for a non-buyer hands
over the **entire scene** for the life of the token, however short. That is what
the code used to do, and it meant the paywall gated the URL rather than the
content.

`teaserDuration` (15–30s on every video) is a **UI value only**: the badge on a
card and how long the hover-preview plays. It never limited anything server-side.

#### How it works now

`resolveTeaserUrl()` in `lib/bunny.ts` decides what someone without entitlement
receives, in this order:

| # | Condition | URL handed out |
|---|---|---|
| 1 | `teaserBunnyVideoId` is set | Signed URL for the **separate teaser clip** (5 min) |
| 2 | `price === 0` (free video) | The video itself — nothing to protect |
| 3 | otherwise | **nothing** (`teaserUrl: null`) |

Rule 3 is the important one: a paid scene with no teaser clip shows a poster, not
a preview. A fallback there would undo the whole point of the column. The video
page says so plainly ("No preview clip for this scene. Buy it to watch in full.")
instead of looking broken, and the homepage cards simply stay static.

#### Giving a scene a teaser

Creators upload one in **Creator → Upload → "Teaser clip"**, which uses the same
two-step signed-flow as the main video (a second Bunny asset, stored as
`teaserBunnyVideoId`). The form refuses a teaser that points at the main video,
because that is the leak this exists to prevent.

Measurable effect on the current demo data: all 24 seeded videos are paid and
carry no teaser asset, so **none of them hover-preview** — that is the new
behaviour working, not a rendering fault. Mark a video free (price 0) to see
hover previews, or attach a teaser clip to see the intended production path.

#### Migrating existing content

The column is nullable and was added by migration
`20260923030000_video_teaser_asset`. Nothing is backfilled: every existing paid
video now has no preview until a teaser is attached. If that is too strict for
launch, the alternatives are to mark more content free, or to upload short
trailers for the top-performing scenes first. Do **not** "fix" it by pointing
`teaserBunnyVideoId` at the scene — the schema rejects that, deliberately.

The signed `uid` viewer fingerprint is still carried on every signed URL, so a
leaked stream remains traceable to the account that requested it.

### 8.1 Which routes are rate limited, and why

Redis-backed, in one of four buckets from `config.rateLimit`:

| Bucket | Limit | Applied to |
|---|---|---|
| `auth` | 10/min | login, register, forgot/reset password, demo login, **coupon validation** |
| `payment` | 20/min | purchase, top-up, subscriptions, tips |
| `upload` | 5 / 5min | video upload, image upload, **download link minting** |
| `general` | 100/min | comments, reports (video + comment), messages, search suggestions |

Keying is deliberate and differs by route:

- **Authenticated limits key on the user id**, not the IP. That is the key an
  abuser cannot rotate: changing networks does not reset it. Messages are the
  clearest case — unsolicited DMs are the top abuse vector on a creator
  platform, so the limit follows the *account*.
- **Unauthenticated limits key on the client IP** via `clientIp()` in
  `lib/utils.ts`, which reads `x-real-ip` and then the **last** hop of
  `x-forwarded-for` / `x-vercel-forwarded-for`. Reading the chain's *first* hop
  (as an earlier version did) lets a client append a value and pick their own
  rate-limit key, which is a free bypass.

**Known caveat, worth understanding:** if a deployment's proxy neither sets nor
sanitises these headers, an unauthenticated client can choose its own key and
evade an IP-keyed limit. The mitigation already in place is that every
money-moving and account-touching route keys on the user id instead. If you put
a CDN or additional proxy in front, make sure it overwrites `x-forwarded-for`
rather than passing the client's value through.
- [ ] Admin accounts: MFA/strong passwords, minimal admin roster, KYC for
      creator payouts before any real money moves.
- [ ] Content moderation flow (reports → strikes) staffed before launch.
