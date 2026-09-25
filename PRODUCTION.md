# Genhub — Production Deployment Checklist

Everything to verify before Genhub goes live as a real website. Work top to\-bottom; each section is self-contained.

---

## 0. First deploy + launch scripts

```bash
cp .env.example .env.local        # fill in real values (template documents every key)
npm ci                            # clean install
npm run typecheck && npm test     # gates: typecheck + the suite (HarakaPay E2E, live-mode)
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

`preflight:prod` is the same list plus the checks that need the network: a real
`SELECT 1` against Postgres, live probes of **Redis, Bunny Stream + CDN and
SMTP**, the HarakaPay balance, and `/api/health`. Both halves of that exist
because "the value is set" and "the value works" are different facts — a
suspended managed database (Neon sleeps when idle and refuses the first
connection while it wakes), a connection string with the wrong host or password,
a Bunny key that no longer authenticates and an SMTP host that stopped resolving
all pass every environment check above and then fail in front of an operator or a
customer. The connection probes are bounded at 15s, so the gate cannot hang on a
database that is still waking, and they are the *same* probes `npm run
verify:live` runs (one definition in `scripts/_probes.mjs`), so the two commands
cannot disagree about whether a service is up.
Treat it as the gate: **do not deploy while it exits 1.**

#### If the domain answers 404 with `DEPLOYMENT_NOT_FOUND`

That is Vercel's edge saying **no deployment is aliased to this hostname** — it
is not our app returning a 404, and no amount of checking `NEXT_PUBLIC_APP_URL`
will change it. Because `verify:env` is strict under `NODE_ENV=production`, a
single missing critical setting fails `prebuild`, so `next build` never runs,
Vercel records the deployment as **Error**, and the production hostname keeps
pointing at nothing. The symptom of a missing environment variable is therefore
**a site that is entirely absent**, not a site that is subtly degraded — which is
deliberate for a site taking money, but it means the first place to look is the
build log, not the app.

Check, in this order:

1. **Vercel → Deployments.** Is the newest Production entry green (*Ready*) or
   red (*Error*)?
2. **Red → open its build log** and search for `BLOCKING:`. The gate names the
   exact variables in the ✗ lines above it.
3. **Green, or no deployments at all → `Settings → Domains`** and use the domain
   Vercel lists there. A renamed project releases its old
   `<project>.vercel.app` hostname, so a bookmarked URL can die while the site is
   perfectly fine under a new name.
4. **Variables are correct?** Then check their **scope**. Vercel stores them per
   environment (Production / Preview / Development); a value added under
   *Development* is absent from Production, and the next build fails exactly as
   above.

Reproduce the strict gate locally — same command, same exit code Vercel sees:

```bash
NODE_ENV=production npm run verify:env    # exit 1 = the build would fail there too
```

And when the settings look right but the build still fails, check the list Vercel
is actually holding rather than the one you think you typed:

```bash
npx vercel env pull .env.vercel --environment=production
NODE_ENV=production npm run verify:env -- --env-from .env.vercel
#   ✗ <exactly the variable the build log named>
```

`--env-from` loads **that file alone**, never merged with `.env.local`, so a value
missing from the deployment cannot be supplied by your laptop and reported as
present. It is a snapshot, not the deployment — a pulled value can be deleted
afterwards — which is why the gate says which file it read. (`vercel env pull`
writes `.env.local` by default; pass `.env.vercel` so your development file is
not overwritten, and keep it out of git — it holds the same secrets.
`.env.vercel` is in `.gitignore` for exactly this reason.)

Once a deployment exists, `APP_URL=https://<domain> npm run launch:check:remote`
is the command that asks *it* (rather than this checkout) what it is configured
with. See §2.

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

**Nothing is scheduled yet at this point.** `vercel.json` ships an empty `crons`
array — sub-daily cron expressions fail a Hobby deployment — so the workers run
from GitHub Actions. Set the two repository values below (`APP_URL`,
`CRON_SECRET`) or no background job runs at all: earnings stay in holding,
renewals lapse and uploaded videos never publish. See §4.0.1.

```
GitHub → repo → Settings → Secrets and variables → Actions
  Variables  → New variable → APP_URL     = https://your-domain   (no trailing slash)
  Secrets    → New secret   → CRON_SECRET = <the server's CRON_SECRET>
```

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
APP_URL=https://your-domain.com npm run launch:check  # opens with
#      the line below plus verify:live, and prints one verdict
npm run preflight -- --url https://your-domain.com   # blockers + live health
npm run smoke:harakapay                             # read-only key check
npm run smoke:bunny -- --storage                    # stream + storage check
npm run admin:create you@domain.com                 # bootstrap the first admin

# 5) manual console steps
#    - register the webhook URL in the HarakaPay dashboard
#    - submit https://your-domain.com/sitemap.xml to Google Search Console
#    - buy your cheapest video with a real phone once (smoke:harakapay --collect)
```

#### One command to re-run that verification

```bash
APP_URL=https://your-domain.com npm run launch:check
```

Runs `preflight:prod` against the deployed URL (configuration, the live service
probes, `/api/health`), then `verify:live` (every credential, opened for real),
then prints one verdict:

```
=== LAUNCH CHECK: NOT READY ===
  ✗ preflight:prod (https://your-domain.com)        5 blocker(s), 0 warning(s)
  ✗ verify:live                                     2 configured value(s) broken · 1 warning(s)
  ! HarakaPay collect                               SKIPPED — pass --collect <amountTZS> <07XXXXXXXX> …
```

It is a convenience, not a new source of truth: each step is the same script you
would have run by hand, and the summary only reads its exit code and one line.
A skipped collect is not a failure — it is the one step that needs a handset.

**The real USSD push is opt-in and always will be.** `--collect <amountTZS>
<07XXXXXXXX>` sends one genuine charge: money moves and somebody's phone rings. A
post-deploy check that quietly charged a customer would be a worse bug than the
one it hunts for, so the last step in the sequence never runs unless it is named —
and the summary says out loud that it was skipped, because that is the only thing
a green run did not prove.

#### The same verdict, asked of the deployment: `--remote`

```bash
APP_URL=https://your-domain.com npm run launch:check:remote
```

The run above reads **this machine's** environment, which is right on a laptop
and wrong on a CI runner: it would mean copying the live gateway key, the
database URL and the mail password into GitHub, and then trusting that copy has
not drifted from the one Vercel actually runs. When the two disagree, the answer
is about the runner.

`--remote` asks the deployment instead, at the two endpoints built for it —
`/api/health` (database up, schedules firing) and `/api/health/services` (the
credentials, opened for real). It needs `APP_URL` and `CRON_SECRET` and nothing
else, and produces the same verdict from the same summary line.

`.github/workflows/post-deploy.yml` is that command, run for you: every
successful **Production** deployment (Vercel posts the event) triggers it and the
verdict lands on the run's own page via `GITHUB_STEP_SUMMARY`. A deploy that
broke the gateway key or the mail password is then a red run and an email,
instead of a site that loads every page and cannot take money. It installs
nothing — the check is two HTTP requests — so the gate cannot itself be the thing
that fails to build.

Add `--json` and stdout carries one JSON object and nothing else, for anything
that wants to branch on the verdict rather than read it.

### 0.2 The deploy installs the lockfile, not a fresh resolve

`vercel.json` pins the install step:

```json
{ "installCommand": "npm ci" }
```

Vercel's default is `npm install`, which is allowed to **re-resolve** the
dependency tree. That is how a build passes on your laptop and dies in the
cloud: npm keeps the tree it was already handed locally, but re-resolves from
scratch on a clean machine — and a range that cannot be satisfied then fails
there and only there. That is exactly what happened with `@types/node`
(`^20.14.0` against vitest 5's `^22.0.0 || >=24.0.0`), and the lockfile being
in sync did nothing to prevent it, because the failure was in the *range*, not
the lock.

`npm ci` installs the lock and nothing else, so the deployed tree is the tree
the gates above were run against. It is also the same command the runbook tells
you to run locally, so both sides of the wire use one install.

The trade is deliberate: `npm ci` **refuses to run** when `package.json` and
`package-lock.json` disagree. Adding or changing a dependency therefore means
running `npm install` locally and committing the lockfile with the change. Skip
that and the deploy stops with "npm ci can only install packages when your
package.json and package-lock.json are in sync" — a loud, immediate stop rather
than a quiet install of a tree nobody tested.

That stop is worth catching earlier, because it is the one failure the other
gates cannot see: `tsc`, `npm test` and `next build` all run against the
`node_modules` the previous install left behind, so an edit to `package.json`
that was never installed is green everywhere and fatal only in the cloud.
`npm run verify:lockfile` checks the three things `npm ci` compares — the ranges
in the lockfile's root entry, anything left behind that is no longer declared,
and that each locked version actually satisfies its range — and `npm run
preflight` runs it first, in **every** mode, because a drifted lock is a broken
checkout rather than a missing key.

The lock carries every platform, not just the one it was generated on (`/next
swc-linux-x64-gnu` and friends are all present), so a Linux build resolves the
same versions this laptop does.

### 0.3 The same gates run on every push

`.github/workflows/deploy-gates.yml` runs this list on every branch:

```
npm ci  ->  prisma migrate deploy  ->  npm run typecheck  ->  npm run audit:endpoints
        ->  npm test               ->  npm run audit:balances  ->  npm run build
```

Vercel builds on push too. The difference is where the answer arrives: this one
is attached to the commit, in minutes, and costs no deployment. Every step is
something this section already tells you to run by hand, in the same order.

**It needs no secrets, deliberately.** `verify:env` decides how strict to be
from the platform (`VERCEL_ENV` / `NODE_ENV` / `RAILWAY_ENVIRONMENT` / `RENDER`),
and a GitHub runner sets none of them — so the build here proves the **code**
builds and the deployment's **configuration** is checked by `preflight:prod` and
by Vercel's own production build, where that check is strict. A workflow that
demanded production secrets would fail on every fork and stay red, and a gate
that is always red is not read.

**The database is created and thrown away with the runner.** `TEST_DATABASE_URL`
points at a Postgres service container on localhost, which is also what makes the
database-backed suites *run*: `src/tests/setup-env.ts` skips them rather than risk
writing to a remote database, so without that variable the workflow would pass
while testing almost nothing. `prisma migrate deploy` builds the schema from zero
every run — the same thing the first deploy of a fresh database does, and the only
way a bad migration fails here instead of on the deploy that runs it.

The **balance audit runs after the suite** on purpose: it inspects the rows the
tests have just created, spent and deleted, which is the only moment a database
holds the sort of half-finished state a money bug would appear in.

The workflow is **the same on every branch**. A break is cheapest to fix while it
is still attached to the commit that caused it, and `npm ci` here makes the
lockfile check (§0.2) a required step of every push rather than something you
remember to run.

`.github/workflows/post-deploy.yml` is the other half, and runs *after* the
deploy rather than before it. These gates prove the code builds from a clean
checkout; that one asks the deployment that is now serving whether it is
launch-ready (§0.1, `--remote`). It needs `APP_URL` and `CRON_SECRET`, no
install, and no other secret — see §0.1 for why the check asks the site instead
of reading a copy of its environment.

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

#### Where a check reads from: this checkout or the deployment

Vercel's environment and this checkout's `.env.local` are two different places,
and no script on a laptop can see the first one. Every local gate reads
`.env.local` (plus the shell), so a variable you set in the hosting provider's
dashboard stays invisible here — and `preflight:prod` now says which file it read
before it says anything else.

| Question | Ask it where the answer lives |
| --- | --- |
| Is *this checkout* configured? | `npm run preflight:prod` (reads `.env.local`) |
| Is *the deployment* configured? | Admin → Overview → System readiness, or `GET /api/health` + `/api/health/services` |
| Is *the deployment* configured, from a laptop? | `APP_URL=https://your-domain npm run launch:check:remote` |
| What does the provider actually hold? | `npx vercel env pull .env.vercel --environment=production` then `npm run preflight:prod -- --env-from .env.vercel` |

Two traps that produce a red check on a site that is actually fine, and a green
one on a site that is not:

- **Scope.** Vercel stores variables per environment (Production / Preview /
  Development). A value added under *Development* is absent from Production.
- **Build time.** `NEXT_PUBLIC_*` are inlined when the bundle is built, so adding
  or changing one needs a **redeploy** — a restart, or a dashboard save, changes
  nothing on the running site.

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

### 2.2 Bunny.net video — Token Authentication, and the key you must COPY

The player, the teaser and the members-only download all use signed Bunny URLs.
The signature is `base64url(SHA256(BUNNY_TOKEN_SECRET + path + expires))`, sent in
the **query string**:

```
https://<cdn>/<videoId>/playlist.m3u8?token=<token>&expires=<ts>
https://<cdn>/<videoId>/play_360p.mp4?token=<token>&expires=<ts>   (downloads)
```

Three things about that shape are not cosmetic, and all three were wrong in
production:

**The hash is a plain SHA-256 over `secret + path + expires`.** Not HMAC, not the
other argument order. Measured against the live pull zone: 1200 shape
combinations were swept (both orders, HMAC / SHA-256 / SHA-256-with-key-prefix,
hex / base64 / base64url, truncated and full, seconds and milliseconds, query
form and path form) and exactly one family answered 206. A wrong guess is a bare
**403** with no explanation attached — which is what production looked like.

**The token goes in the query string, and the pull zone refuses every other
form.** The `/bcdn_token=…&token_path=…/file` path prefix returns 403 even with a
correct signature (all combinations tried).

**A signature covers the whole folder it names, so HLS needs one extra hop.** A
player does not fetch one file: it fetches the manifest and then every segment
and rendition named inside it, as separate requests. And an HLS player resolves
those relative URLs against the manifest URL, which **drops its query string** —
so a signed CDN manifest loads and then every segment 403s: a poster, a spinner,
and never any video. Playback therefore points at our own
`/api/videos/<rowId>/stream` instead, which fetches the manifest with an
authorised request and rewrites every URI in it to carry its own
folder-signed authorisation (`src/lib/hls.ts`). Nested playlists come back
through that route; segments are fetched straight from the CDN, so no video
bandwidth passes through the app.

Checklist:

- [ ] **Token Authentication enabled on the pull zone.** Without it the CDN
      ignores our tokens and anyone can hot-link paid video. Confirm it with
      `GET /library/<id>/videos/<guid>/play`, which reports
      `tokenAuthEnabled: true`.
- [ ] `BUNNY_TOKEN_SECRET` is the pull zone's own **Token Authentication Key**
      (Stream library → Security). It is NOT a value you generate, and it must be
      pasted **character for character** — this value is hashed byte for byte, so
      one trailing space or a newline is signed into every URL and Bunny answers
      **403** to all of them.
      > Which value a deployment is actually holding is reported by the readiness
      > probe: `BUNNY_TOKEN_SECRET … key <8 hex>` is a fingerprint of the loaded
      > key. If playback fails and the fingerprint is not the key you pasted in
      > the dashboard, the deployment has an older value; if it IS the fingerprint
      > you pasted, the key is wrong (or the pull zone's key was rotated).
      > This is the trap that broke playback. `.env.example` used to say
      > `openssl rand -hex 24`, so a generated string was configured. Bunny then
      > answered **403 to every signed URL**, in a real browser as well as from
      > the server, and there is no error anywhere: the player just spins. The
      > only symptom is customers saying the video never loads.
- [ ] `BUNNY_CDN_HOSTNAME` is the library's real CDN host — copy it from
      `GET video.bunnycdn.com/library/<libraryId>/videos/<guid>/play`
      (`thumbnailUrl` starts with it). A Stream host serves the video library
      and nothing else.
- [ ] `npm run smoke:bunny` returns the library name (proves the key + id).
- [ ] Play one **paid** video end to end with the browser's network tab open:
      `playlist.m3u8` **and** a `…/240p/video0.ts` segment must both be `200`. A
      200 manifest with 403 segments means the token is in the query string.
- [ ] `/api/health/services` shows `Bunny Stream … signed manifest accepted`.
      It signs a real manifest and fetches it, because "the secret is set" and
      "the secret works" are different questions — and only the second one is
      worth reporting.

The signing code throws rather than emitting an URL signed with an empty secret
— an unsigned-but-labelled-signed URL is worse than none, because it looks safe.

### 2.3 Bunny.net images — served by `/api/media`, not by a CDN hostname

Thumbnails, avatars, gallery photos and **KYC documents** are objects in a Bunny
**storage zone** — a different product from Stream. The zone has no working CDN
hostname (`genhub-thumbs.b-cdn.net` answers "Domain suspended or not
configured"), and the old code built every image URL from `BUNNY_CDN_HOSTNAME`,
which is the *Stream* pull zone: it serves the video library and answers 403 for
storage objects. Nothing else. That is why no thumbnail, avatar or KYC photo
ever appeared anywhere in the UI.

Images are now served by the app itself:

```
GET /api/media/<key>        -> reads the object with BUNNY_STORAGE_ACCESS_KEY
```

and the key's first segment decides who may read it:

| Key | Who can read it |
| --- | --- |
| `public/…` | anyone — thumbnails, avatars, gallery |
| `private/<userId>/…` | that user, or an admin — KYC documents |
| `uploads/…` | the pre-fix layout: public, unless a KYC row still points at the key |

Checklist:

- [ ] `BUNNY_STORAGE_ZONE` + `BUNNY_STORAGE_ACCESS_KEY` are set (no CDN hostname
      is needed for images any more).
- [ ] Run the one-off healing **once per environment**, after deploying this
      version:
      ```bash
      node scripts/normalize-media-urls.mjs            # report
      node scripts/normalize-media-urls.mjs --apply    # write
      ```
      It rewrites stored `https://<cdn>/…` image URLs to `/api/media/…`, and moves
      every KYC document from the public `uploads/` prefix into
      `private/<userId>/kyc/` (copy → verify → update the row → delete the
      original), because identity documents were being uploaded into the same
      path as public thumbnails. Idempotent; run it again any time.
- [ ] Confirm the result: a thumbnail or avatar renders, and an ID document
      renders **only** for its owner or an admin.

### 2.4 Erasing an account

`DELETE /api/account` is the only irreversible action in the product, so it asks
for the password and a typed `DELETE`, and it refuses when the caller is the last
admin (a site with no admin cannot approve creators or release payouts).

What it removes, in order: the videos from Bunny, the private document folder,
the avatar and the thumbnails — then, in one transaction, the videos, the reports
on them, the user's transactions, the payouts, the messages, and finally the
account row. Purchases *by other people* that credited this creator are kept (the
buyer's receipt is theirs) with the creator link cut.

Nothing about it depends on Prisma's cascade list alone: most relations to `User`
are not declared `onDelete: Cascade`, so a bare `user.delete()` fails on a
foreign key — after the user has already been told their account is gone. See
`src/lib/services/account-erasure.service.ts`.

## 3. Payments go-live (HarakaPay)

- [ ] `PAYMENT_SANDBOX=false` — while it is `true` the app never contacts
      HarakaPay, so **no USSD prompt reaches the customer's phone**. Flip it and
      restart before testing.
- [ ] Register the webhook in the HarakaPay dashboard:
      `https://<domain>/api/webhooks/harakapay?t=<HARAKAPAY_WEBHOOK_TOKEN>`

      That token is the only proof a callback came from HarakaPay. Their spec
      has no HMAC signature, so unlike the cron secret it has to travel in the
      URL — the one place a secret is otherwise refused (see §4.0). It is
      compared in constant time, and **a callback that cannot be verified is
      refused** (`src/lib/webhook-auth.ts`): in production, an unconfigured
      token means 401 rather than "no token, so nothing to check". Accepting
      there would let anyone POST a completed callback for a checkout they had
      started themselves and be handed the paid content for free, with the
      creator credited for money nobody paid.

      Refusing costs nothing, because the webhook is an optimisation: the poll
      and the reconcile sweep both ask HarakaPay directly and settle the charge
      anyway (next bullet). What it does cost is a line in the logs —
      `[HarakaPay Webhook] Refused: HARAKAPAY_WEBHOOK_TOKEN is not configured` —
      which is not an attack and should be read as a configuration fault.
- [ ] Check `GET /api/payments/health` (as admin). It reports sandbox state, key,
      webhook token, whether `NEXT_PUBLIC_APP_URL` is publicly reachable, and the
      live HarakaPay wallet/float balance. `readyForLive` must be `true`.
- [ ] `gatewayBreaker.open` must be `false`. It is `true` only while this server
      is deliberately skipping gateway calls because HarakaPay stopped answering
      — **not** a bad key. See §3.3.
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
change can fix: it is funded in the HarakaPay dashboard. You should not have to
read this section to find out — the app tells you on the way down (§4.0.6: a
notification and an email when the float crosses `HARAKAPAY_FLOAT_FLOOR_TZS`,
before it reaches 0). Everything below is the
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

Four workers need a scheduler, and they run from GitHub Actions — one workflow
per worker, all four in `.github/workflows/`:

| Cron | Schedule | Purpose |
|---|---|---|
| `/api/cron/release-earnings` | hourly | 14-day holding release |
| `/api/cron/reconcile-payments` | every 10 min | settle PENDING gateway orders, flag never-settled ones as under investigation |
| `/api/cron/renew-subscriptions` | hourly (minute 15) | charge memberships that expire within 24h |
| `/api/cron/poll-encoding` | every 5 min | publish uploaded videos once Bunny Stream can serve them, and tell the creator |

`vercel.json` deliberately ships an empty `crons` array: the same schedules
there fail a **Hobby** deployment outright. On **Pro**, move them back into
`vercel.json` for tighter timing — the exact JSON is in §4.0.1.

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

- [ ] **Scheduled**: set repository variable `APP_URL` and secret `CRON_SECRET`,
      and `.github/workflows/release-earnings.yml` runs it hourly. Nothing runs
      until both are set — see §4.0.1.
- [ ] **On Pro**: move the four schedules into `vercel.json` instead (§4.0.1),
      which removes the 60-day-inactivity rule below and gives per-minute timing.
- [ ] **Either way**: point the scheduler at `/api/cron/supervisor` (§4.0.4). One
      poke runs everything that is overdue, because GitHub Actions delivers the
      per-worker files hours apart rather than on the interval they ask for.
- [ ] Verify: `curl -H "x-cron-secret: $CRON_SECRET" https://<domain>/api/cron/release-earnings`
      → `{"success":true,...}` (wrong/missing secret must return 401).
- [ ] Admins can also trigger releases manually from **Admin → Earnings**.

### 3.3 When the gateway stops answering: the local breaker

A HarakaPay that *accepts the connection and then never answers* is worse than
one that is down, because every call pays the full wait and nothing looks broken.
`harakaStatus` is the worst of them: the reconcile sweep calls it once per
pending charge, so one hung gateway turned a sweep that should take a second into
minutes of sequential waits, and the checkout poll into a spinner that never
moved.

So every gateway call is bounded at **20s** and guarded by a circuit breaker
(`src/lib/payments/harakapay.ts`). After **two unanswered calls in a row** — a
timeout, a network failure, or a 5xx — the breaker opens for **30s**, and calls
during that window are refused at once:

```
HarakaPay has not answered its last calls, so this one was not sent.
```

One success closes it, so a recovered gateway resumes immediately.

**Do not read an open breaker as a bad key.** A rejected key answers immediately
— a 4xx — and a 4xx is deliberately *not* counted as a fault. If 4xx responses
counted, one customer typing a bad phone number twice would pause payments for
everybody. Only "we could not reach the gateway" opens the breaker, so the
correct response is to wait a moment and retry, or check HarakaPay's status
page — not to rotate `HARAKAPAY_API_KEY`.

Where to see it:

- [ ] `GET /api/payments/health` → `gatewayBreaker` (`open`, `openUntil`,
      `failures`, `skipped`, `warning`). While it is open the `summary` leads with
      the breaker, because every other line on that response is about a gateway
      nobody can reach right now.
- [ ] Admin → Overview → System readiness → the **`gatewayBreaker`** row, and the
      same sentence at the top of the warnings list.
- [ ] The HarakaPay probe (`npm run verify:live`) reports `warn` — "key valid …
      HarakaPay has not answered its last calls" — when the gateway answers the
      probe but this process has been skipping it. A zero float stays a hard
      failure; the breaker only ever softens an otherwise-healthy probe.

The breaker is **per process**. A serverless cold start begins with it closed,
which is why it is a fast-fail for a single bad spell rather than a global
state.

#### The reconcile sweep stops early instead of grinding

When the breaker is open, `reconcileStalePayments` stops iterating. It has not
asked about the rows it has not reached, and the gateway has not answered about
them either, so walking the rest would only inflate the `errors` count and report
a `checked` figure that looks like work. The result carries two extra fields —
`gatewayUnavailable` and `unchecked` — and the worker's heartbeat summary says so
out loud:

```
0 checked, 0 settled, 0 newly flagged, 0 awaiting resolution, 0 still processing
  — STOPPED EARLY, 42 not checked (the gateway is not answering)
```

**A `STOPPED EARLY` sweep is not a failed one.** Nothing was lost: the charges are
still `PENDING`, and the next scheduled run (every 10 minutes) picks up where this
one stopped. The only thing that needs a human is the gateway itself — read the
breaker section above. If the rest of the sweep was skipped on every run, check
`gatewayBreaker.skipped` on `/api/payments/health`; a number that keeps climbing
means the gateway is failing more often than the 30s window can recover from.

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

### 4.0.1 Choosing a scheduler: GitHub Actions (default) or Vercel Cron

**`vercel.json` ships an empty `crons` array on purpose.** Four sub-daily
schedules used to live there. On a Hobby account that does not merely delay the
jobs — it **fails the deployment**, so nothing ships at all:

```
Hobby accounts are limited to daily cron jobs.
This cron expression would run more than once per day.
```

Vercel allows plenty of cron jobs on Hobby (100), but only **once per day**, and
every worker here is sub-daily. GitHub Actions drives all four instead — one
workflow per worker, all four already in the repo:

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

- **GitHub's minimum interval is 5 minutes**, so `poll-encoding` cannot run
  more often than that. Nothing breaks: the worker is idempotent and a creator
  can still advance their own uploads by opening the dashboard. A finished
  encode just surfaces within 5 minutes.
- **Scheduled workflows are disabled after 60 days of repository inactivity.**
  GitHub emails the owner first, and any commit re-enables them — but on a quiet
  repo, payments and renewals would stop. Budget one commit (or a
  `workflow_dispatch` run) every couple of months, or move to Pro and use Vercel
  Cron, which has no such rule.
- **These run off GitHub's clock, not yours — and on this repository they run
  far less often than asked.** Measured over 24 h (§4.0.4): the `*/5` schedule
  was delivered every 138–341 min, the `*/10` every 137–336, and the two hourly
  ones every 3h19–5h36. Treat the interval as "roughly", and rely on the
  supervisor (§4.0.4) rather than on each file arriving when it says it will.
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

#### Going back to Vercel Cron (Pro and above)

Vercel Cron has no inactivity rule and per-minute precision, so on Pro it is the
better scheduler. Paste this into `vercel.json` and the four workflows become
redundant — though leaving them in place is harmless, since the workers hold a
run lock and a duplicate trigger is refused rather than repeated.

```json
{
  "installCommand": "npm ci",
  "crons": [
    { "path": "/api/cron/release-earnings", "schedule": "0 * * * *" },
    { "path": "/api/cron/reconcile-payments", "schedule": "*/10 * * * *" },
    { "path": "/api/cron/renew-subscriptions", "schedule": "15 * * * *" },
    { "path": "/api/cron/poll-encoding", "schedule": "*/3 * * * *" }
  ]
}
```

Vercel calls each one with `Authorization: Bearer $CRON_SECRET` automatically.
Do not paste this on a Hobby account: it does not warn, it fails the build.

### 4.0.2 Knowing whether they are actually running

A schedule that stops firing is the one failure with no symptom inside the app:
no request arrives, so there is no log line, no error and no metric to alert on.
Both the HarakaPay webhook and the Bunny upload stayed broken while every
endpoint answered "success" — this is the check for that class of bug.

Every worker stamps a heartbeat as it runs. **Admin → Overview → Background
jobs** shows each one with its verdict, when it last finished, what it returned
and how long it took:

| State | Means | What to do |
|---|---|---|
| **Running on schedule** | Finished inside its cadence | nothing |
| **Running now** | A run is in flight and still inside its grace | nothing |
| **Overdue** | Nothing has finished for over 6 h — see the thresholds below | the schedule stopped — check §4.0.1 |
| **Killed mid-run** | A run began and never came back | the job times out or crashes when it runs |
| **Failing** | It ran recently and returned an error | read the error on the card |
| **Never run** | No heartbeat has ever been written | no scheduler is configured yet |

`Overdue` and `Killed mid-run` are deliberately separate. They look identical
from outside — nothing is running either way — but one means the *scheduler* is
dead and the other means the *job* dies when it runs. The fix is different, so
the dashboard says which.

The thresholds live with the registry in
`src/lib/services/cron-heartbeat.service.ts`, and there are two of them because
they answer two different questions.

**Overdue: 6 hours without a finished run, for all four workers.** This is the
*scheduler's* clock, not the worker's: it says "the pokes have stopped", which is
the only thing an alarm can honestly measure here. It used to be "roughly four
missed runs" per worker (20 / 40 / 180 min), which assumes a schedule that fires
often enough for four misses to be a lot — and GitHub Actions delivered a `*/5`
file every 138–341 minutes on this repository (§4.0.4), so every worker read
`Overdue` for most of the day and `/api/health` answered 503 nearly always (an
alarm nobody can afford to read). What a worker *needs* is still recorded per
worker as `everyMinutes`, and the card prints both:

```
Nothing has finished for 7 h (expected every 5 min, flagged after 6 h).
The schedule has stopped firing — check .github/workflows/poll-encoding.yml.
```

So a tight budget is a statement about your scheduler, and it should be tightened
back to ~4 missed runs the moment your pokes are denser than hourly — see the
"Going back to Vercel Cron" note in §4.0.1, or one external 5-minute poke at
`/api/cron/supervisor` (§4.0.4).

**Killed mid-run: a few minutes.** Measured, not guessed: these jobs finish in
0.4–2.5 s, so a run still open after 5–15 min (per worker) was killed — a
function timeout or a crash before its own handler could catch it. It is reported
separately from `Overdue` because the fix is different: the schedule is fine, the
job dies when it runs.

**For an uptime monitor**, `GET /api/health` reports the same verdict as
`checks.backgroundJobs` — `ok`, `never`, `late`, `stalled` or `failing` — so an
external check can alert while nobody has the dashboard open:

```bash
curl -s https://<domain>/api/health | grep -o '"backgroundJobs":"[a-z]*"'
```

One deliberate asymmetry: `late`, `stalled` and `failing` make `/api/health`
answer **503**, but `never` does not. A worker that has never run means no
scheduler is configured yet — setup work, not an outage — and folding that in
would leave every fresh deployment permanently red, which is how an alarm stops
being read. `never` is surfaced loudly on the admin card instead.

- [ ] Open **Admin → Overview → Background jobs** and confirm no worker says
      `Never run`. Four of them saying so means nothing is calling them yet.
- [ ] Press **Re-check** after switching schedulers (Vercel Cron ↔ GitHub
      Actions) and confirm the "last run" times move.
- [ ] Point your uptime monitor at `/api/health` and confirm it treats a
      `backgroundJobs` of `late`/`stalled`/`failing` as an alert.

#### The watchdog, every hour

`.github/workflows/uptime.yml` asks `/api/health` once an hour and **fails** when
the answer is bad. A failed scheduled run is an email to the repository owner and
a red mark in the Actions tab, so the alarm needs no account, no dashboard and no
service to sign up for. `npm run watchdog` runs the same check by hand, which
makes it the quickest post-deploy question there is — *is this deployment
actually working, right now?*

It needs no new configuration: it reads `APP_URL`, the repository variable §4.0.1
already asks for, and it reads the public health endpoint rather than a
secret-guarded one, so rotating `CRON_SECRET` cannot quietly disable the thing
that is supposed to notice problems.

| Answer | Verdict |
|---|---|
| `database: down` | **alarm** — every page that reads data is failing |
| `backgroundJobs: late` / `stalled` / `failing` | **alarm** — names the state; the detail is on the admin card |
| Degraded for a reason this check cannot read | **alarm** — a 503 nothing explains is the worst thing to shrug at |
| Not JSON (a proxy, a parking page, a 502) | **alarm** |
| `backgroundJobs: never` | **notice only** — no scheduler configured yet, which is setup, not an outage |
| `payments: sandbox` on production | **notice only** — legitimate on a staging URL, a quiet emergency on a live one |

The decision table lives in `scripts/watchdog.mjs` rather than in the workflow,
because the rules are not obvious and the two ways of getting them wrong are both
expensive: an alarm that misses an outage, and an alarm that cries wolf until
somebody mutes it. It is pure, so `src/tests/watchdog.test.ts` covers every
branch without a server.

To have the alarm pushed somewhere you will actually see it, set the optional
`ALERT_WEBHOOK_URL` **secret** to a Slack or Discord webhook
(`Settings → Secrets and variables → Actions → New secret`); the message is sent
in the shape both understand. Without it the alarm is GitHub's own failure email.

#### The credentials behind the site, probed hourly

`npm run preflight:prod` asks whether every service actually works, but only when
somebody runs it. A revoked Bunny key, a rotated SMTP password, a replaced Redis
token or a suspended database leaves a site that answers every request perfectly
while it cannot stream a video, send a password reset or take a payment — nothing
inside the app fails loudly, so an outside check is the only thing that can
notice.

With `CRON_SECRET` set, each watchdog run also asks `GET /api/health/services`,
which runs the same live probes the admin Setup tab runs: Postgres, Redis, Bunny
Stream, Bunny CDN, SMTP, HarakaPay and the app URL. The route is guarded by
`CRON_SECRET` and **reads only** — it opens connections and moves nothing.

| Probe state | Watchdog verdict |
|---|---|
| `fail` — configured but broken | **alarm** — names the service and the reason |
| `warn` — works, but degraded (e.g. unsigned playback URLs, or a public URL that answers 503 because the deployment itself is degraded) | nothing; it shows on the admin card |
| `skip` — not configured yet | **nothing** — the launch checklist's business, not an outage. Flagging it would keep every pre-launch deployment permanently red |
| Route unreachable, or no `CRON_SECRET` | **nothing** — enrichment, never a reason to fail a run |

The last row is the same rule the worker detail follows: the probe is attempted
only after the verdict is decided, so a rotated `CRON_SECRET` costs a line of
context and never the alarm. `src/tests/watchdog.test.ts` pins both the wording
and the ordering — the fetch has to happen *before* the alert is composed, or a
broken credential is noticed by nobody.

**The Public URL probe reads the answer, not the status code.** `/api/health`
answers 503 while the deployment is degraded, and the probe fetches exactly that
URL — so judging it on `res.ok` made a deployment report its own job lag back to
itself as `Public URL → HTTP 503`, pointing whoever read it at DNS or
`NEXT_PUBLIC_APP_URL` when neither was wrong. It now asks the only question it
can answer: does this address answer like *our* app (a JSON body with `status`
and `checks`)? A degraded answer is a `warn` — visible on the card, kept out of
`failing`, so it never reaches the alarm or `launch:check --remote`. A 200 whose
body is something else stays a hard failure, which is the case that matters:
`NEXT_PUBLIC_APP_URL` feeds the sitemap, OG tags and the gateway's
`webhook_url`. `src/tests/app-url-probe.test.ts` pins the rule.

Prove it by hand:

```bash
APP_URL=https://<domain> CRON_SECRET=$CRON_SECRET npm run watchdog
#   ✗ Bunny Stream is configured but failing: HTTP 401 — wrong key, or it lacks access to this library
```

#### The same news, seconds after it happens

An hourly probe is the right net and the wrong latency. A key revoked at 10:02
means every collect until 11:00 is accepted by a gateway that will never deliver
it, and a password reset in that window reaches nobody.

So the app reports the fault itself, the moment it discovers one — see
`src/lib/credential-alert.ts`. Four places raise it, each at the point where the
failure is unambiguous:

| Where | What has to be true |
|---|---|
| Redis | the data-path breaker tripped (two calls in a row unanswered) |
| HarakaPay | the breaker tripped, **or** the gateway answered `401`/`403` |
| Bunny Stream | the management API timed out, could not be reached, or answered `401`/`403` |
| SMTP | nodemailer failed with an auth or connection code (`EAUTH`, `ECONNECTION`, …) |

Three properties are deliberate, and each is a decision:

* **It never depends on Redis.** A dead cache is one of the faults it reports, so
a dedupe kept there would go quiet exactly when it is needed most. The window
lives in the process, so on serverless a fault can alert from a few instances at
once — the right way for an alarm to be wrong.
* **It is said once per 30 minutes, per service.** A payload that retries, or a
sweep that fails per row, must not produce an alert per attempt; an alarm that
repeats is an alarm somebody mutes.
* **A rejected recipient is not a rotated password.** SMTP only reports auth and
connection codes, so one customer's typo in a signup form does not look like a
broken mail credential.

Set `ALERT_WEBHOOK_URL` in the **deployment's** environment (not only on the
repository) to receive it; without one the line is written to the server log, and
the hourly watchdog remains the record. The message is sent in the shape both
Slack and Discord understand, and it names the service, what was observed and
the app URL.

#### What is still blocking a launch, on the admin card

`npm run preflight:prod` is the launch gate, and it needs a shell. **Admin →
Overview → System readiness** now leads with the same verdict, read from the
deployment's own environment: either *Launch-ready — nothing blocking* or the
count, each blocker with where to get the value. `GET
/api/admin/launch-readiness` serves it (ADMIN only, no network, read-only).

It is deliberately a **strict subset** of what preflight checks — no entropy
maths, no lockfile, no repository state — so it can miss a blocker but can never
invent one. Two lists that disagree about the same deployment are worse than one.

#### Naming the worker that stopped

Out of the box the alarm says *which kind* of problem it is — `background jobs:
late` — and not *which worker*, because `/api/health` is public and publishes the
verdict alone: an endpoint that hands out worker names and where each one is
scheduled is a map of the system for anybody who asks.

Set `CRON_SECRET` (the same secret the four workers already use — new **secret**,
not a variable) and the alarm names it, with how long it has been quiet:

```
Genhub https://your-domain — background jobs: late — a scheduled worker has
stopped running. … — Release matured earnings: nothing finished for 4 h
```

The detail comes from `GET /api/health/attention`, which is guarded by the same
`CRON_SECRET`, and answers `401` without it. It reads: no lock, no heartbeat,
nothing moved. Two properties are deliberate and tested:

* **The alarm is exactly as loud without it.** The detail is fetched only *after*
the verdict is already bad, so a missing, wrong or rotated secret cannot silence
anything — it costs a line of context, never the alarm. That is the failure this
split could otherwise introduce.
* **The public endpoint still says nothing.** `/api/health` returns
`backgroundJobs: late` and no more; a test fails if worker names are ever folded
back into it.

#### It also restarts the worker, within narrow limits

Alarming is only half a watchdog: a stopped schedule stays stopped until somebody
reads the alarm, which at 03:00 is hours of creators not being paid. With
`CRON_SECRET` set, the watchdog starts the stopped worker itself, through the
worker's own cron route — the same code, the same run lock and the same heartbeat
as a scheduled run, and the heartbeat records *who* started it
(`(restarted by the uptime watchdog)`), so a rescued run is never filed as though
the schedule had worked.

**`renew-subscriptions` is never restarted, by anything, ever.** It is the one
worker whose run can charge a fan who did not ask: when a wallet cannot cover a
renewal it sends a USSD prompt to that person's phone. A missed renewal is
recoverable by a human at a keyboard; a duplicate charge is money taken from a
customer. The refusal is enforced twice over — the watchdog keeps an explicit
list of the three workers it may start, *and* refuses anything the payload does
not positively mark as unable to reach a phone (`sendsCustomerRequests: false`).
Unknown reads as unsafe. A test fails if the list and the worker registry ever
disagree.

What it will not do, and why each is deliberate:

| State | Restarted? | Why |
|---|---|---|
| `late` | **yes**, if on the list | nothing has finished for ~4 of its own intervals: the schedule stopped |
| `stalled` | no | the job *is* being triggered and dies when it runs — a restart repeats the same death |
| `failing` | no | same: it runs, it fails, and retrying adds nothing to an alarm you already have |
| `never` | no | no scheduler was ever wired up. Running it by hand would hide the one thing that needs doing |

Because a restart only fires once the worker is genuinely `late`, it can never run
a job more often than its own schedule would have. Restarting also **does not
silence the alarm** — running the job again does not fix the schedule that
stopped, and an alarm that goes quiet when a repair succeeds is how a broken
schedule stays broken for a month.

To stop the restarts without giving up the alarm (mid-incident, or on a
deployment you are deliberately holding still), set the repository **variable**
`WATCHDOG_RECOVER=off`. Anything unrecognised is treated as off, so a typo cannot
quietly arm it again; leaving it unset keeps restarts on.

#### Knowing when it comes back

An alarm is only half a conversation: it says something stopped, and nothing ever
takes it back. So a schedule somebody fixed at 09:00 keeps getting chased for a
week, and a restart that worked is never confirmed to the person who pressed the
button — the heartbeat can only describe *now*, and a worker that came back an
hour ago looks exactly like one that never broke.

The watchdog therefore keeps its own memory, and reports what came back. Every
run hands `POST /api/health/attention` what it saw (the same `CRON_SECRET`, still
no worker run and still no lock), which records one row per worker it has reported
and closes it when the worker is healthy again. It records **before** it acts: a
restart writes a fresh heartbeat, so a sighting taken afterwards would say *this
worker is fine* and erase the outage it is supposed to report — which is how a
rescue ends up looking like a repair. A worker comes back **once, in one
message**:

```
Genhub https://your-domain — recovered: Release matured earnings is running again
after 4 h — the schedule is firing again
```

Two readings, and the whole feature is the difference between them:

| The sentence says | What it means |
|---|---|
| `…is running again after 4 h — the schedule is firing again` | the schedule is back. Close it |
| `…is running again after 4 h, but the run that brought it back was started by the watchdog or the supervisor, not by the schedule — the schedule is still not firing (§4.0.1)` | only a restart arrived, from the watchdog (§4.0.2) or the supervisor (§4.0.4). It will be quiet again in an hour |

That second line exists because of the restart above: once the watchdog starts
workers itself, "it is running again" becomes ambiguous, and reading a rescue as a
repair is how a dead schedule gets marked fixed the moment the watchdog papers
over it. The distinction is read from the heartbeat's `lastOrigin` column, not
from the wording of a summary — testing a human sentence is how the two answers
drift apart.

Three more rules are deliberate, and each is covered by a test:

* **A recovery cannot hide a problem.** Bad news and good news arrive in the same
  channel, so the notice is sent only when the run is otherwise clean. If
  anything is still wrong, the recovery line is appended to the alarm instead,
  and the run exits non-zero either way.
* **`never` is never a recovery.** A worker whose rows were cleared (a scheduler
  removed, a deploy) reads as `never`; calling that a recovery would be the worst
  of both worlds — the operator stops looking and the worker is still down. Its
  record stays open.
* **The record outlives the notification.** A closed row keeps when it was first
  reported and when it came back, so a webhook that was never delivered costs a
  nudge, not the history: the app holds the record, the webhook is the doorbell.

Nothing here needs configuring, and with no `CRON_SECRET` the notice is simply
not reported — the alarm is unaffected either way.

- [ ] After the first restart you perform, watch for the `✓ recovered:` line (or
      the notice landing in `ALERT_WEBHOOK_URL`) and confirm it says the schedule
      is firing again. If it says the restart — from the watchdog or the
      supervisor (§4.0.4) — was the *only* run, the schedule is still not fixed.
- [ ] Confirm a recovery does not close a live problem: with a worker still down,
      run `npm run watchdog` and check the exit code is 1 and the recovery line
      is inside the alarm rather than sent on its own.

**One failure this cannot report, and it is worth knowing.** GitHub disables
*every* scheduled workflow in a repository after 60 days without activity (§4.0.1,
caveat 2) — this watchdog included, at the same moment as the four workers it
watches. So it cannot warn you about the one outage that also silences it. For
that, point a free external monitor (UptimeRobot, Better Stack, healthchecks.io)
at `/api/health`: the endpoint answers **503** when the jobs have gone quiet, and
a monitor outside the repository does not go quiet with it. Two cheap habits cover
the rest: keep an eye on the Actions tab, and commit anything once every couple
of months, which re-enables every schedule at once.

- [ ] Run the watchdog by hand once after deploying: `APP_URL=https://<domain>
      npm run watchdog` — expect `status=ok` and exit 0.
- [ ] Confirm it *can* fail: `npm run watchdog -- --url https://example.com`
      should exit 1 with "did not answer with JSON", so the alarm path is proven
      before it is ever needed.
- [ ] Set `ALERT_WEBHOOK_URL` if GitHub's failure email is not somewhere you
      look.
- [ ] Set `CRON_SECRET` as a repository secret too, so the alarm names the worker
      instead of only the verdict (§ above) — and restarts it.
- [ ] Confirm the restart path works, not just the alarm: stop a worker on the
      test deployment (or seed a stale heartbeat), run `npm run watchdog`, and
      check the Actions log says `Restarted …` and that the worker's heartbeat
      carries `(restarted by the uptime watchdog)`.
- [ ] Confirm the other half of that run: the same log should end with
      `✓ … recovered:` once the worker is healthy, saying whether it came back on
      its own or only because the watchdog restarted it (§ above).
- [ ] Confirm the alarm can still fire without it: run
      `APP_URL=https://<domain> npm run watchdog` (no `CRON_SECRET`) and check it
      exits 1 with the verdict alone.
- [ ] Point an external monitor at `/api/health` for the case the watchdog
      cannot report (§ above).

### 4.0.3 Running a worker by hand (`Run now`)

Each row on **Admin → Overview → Background jobs** has a **Run now** button. It
exists for the question the card cannot answer by itself: *is this pipeline
working, or does it just have nothing to do?* A worker showing `Never run` — or
one that has been silent since a deploy — can be started and read immediately,
instead of waiting an hour for a schedule that may not be configured at all.

It is a real run, not a simulation. It goes through the same job, the same
lock and the same heartbeat as the schedule, so a green result here means the
schedule will work too. That also means it makes the same changes a scheduled
run would.

**The lock.** Every worker takes a run lock for the duration of its run, claimed
with a single conditional `UPDATE`. Two schedulers can be configured at once
(the docs describe Vercel Cron *and* GitHub Actions), and a person can press
**Run now** while either is running — for `renew-subscriptions` a second
concurrent run is not a duplicated log line, it is a **second USSD charge on a
real fan's phone**. Whichever caller wins the claim runs; the others are
refused. A run that dies without releasing the lock expires on its own after the
worker's own in-flight grace (5–15 min, listed next to each worker in
`cron-heartbeat.service.ts`), so one timed-out run cannot disable a worker
permanently.

**What a refusal looks like.** They are deliberately unequal, because they have
different readers:

| Trigger | Answer on a locked worker | Why |
|---|---|---|
| `Run now` (admin) | `409 ALREADY_RUNNING` with how long ago the run started | a person is watching and needs the reason |
| `/api/cron/*` (scheduler) | **200** with `"status": "skipped"` | a scheduler that got a 500 would page someone about a job that is working correctly |

A refused trigger writes nothing to the heartbeat: a run that never happened
must not look like one that did.

**One worker asks for confirmation.** `renew-subscriptions` is the only worker
that can reach a customer's phone, so starting it by hand requires an explicit
confirmation. That is enforced in the endpoint (`CONFIRMATION_REQUIRED`), not
just in the button — a guard that lives in the UI is a guard a stray request
walks past.

**Every manual run says so.** The heartbeat records the trigger, so the card
shows `Last result: … (manual run from the admin panel)` and "running on
schedule" is never claimed about something a person started.

- [ ] Press **Run now** on `poll-encoding`, `reconcile-payments` and
      `release-earnings` once. Each should return a summary and the row should
      flip to `Running on schedule · 1 run(s) recorded` with
      `(manual run from the admin panel)` in the result.
- [ ] Press **Run now** on `renew-subscriptions` and confirm you get the
      confirmation warning before anything is charged.
- [ ] While one worker is running, press **Run now** on it again and confirm
      you get the "already running" refusal rather than a second run.

### 4.0.4 The cron supervisor: one poke runs everything that is overdue

GitHub Actions does **not** keep the intervals §4.0.1 asks it for. Measured on
this repository over 24 h, from the workflow-runs API and matching the heartbeats
the app recorded:

| Workflow asks for | Actually delivered |
|---|---|
| `poll-encoding` — every 5 min | 138, 160, 203, 297, 304, 341 min apart |
| `reconcile-payments` — every 10 min | 137, 197, 222, 308, 314, 336 min apart |
| `release-earnings` — hourly | 3h25, 4h42, 4h59, 5h36 apart |
| `renew-subscriptions` — hourly | 3h19, 4h03, 5h06, 5h08, 5h12 apart |

Nothing in the app is lying when that happens: each heartbeat goes past its own
budget minutes after every delivery, so `checks.backgroundJobs` reads `late` for
most of the day, `/api/health` answers 503, and the watchdog alarms — correctly,
because renewals, releases and encoding publication really are hours behind. What
is wrong is the assumption underneath §4.0.1: that each worker's own file arrives
when it says it will. An alarm that is red nearly all the time is its own failure,
because nobody reads it (§4.0.2).

`.github/workflows/supervisor.yml` is the answer, and it is deliberately small:
it calls `POST /api/cron/supervisor`, which runs **every worker whose heartbeat is
past its own budget**, through the same lock and heartbeat a scheduled run would
have used. One delivered poke therefore restores all four cadences, whichever
file GitHub chose to deliver — and an external scheduler pointed at this one
endpoint replaces the four per-worker ones entirely.

```bash
B=https://<domain>; S=$CRON_SECRET
# what it ran, what it refused to run, and the verdict after the poke
curl -s -X POST "$B/api/cron/supervisor" -H "x-cron-secret: $S" | head -c 400
```

Its own `*/10` schedule is delivered just as sparsely as the rest, and the four
worker workflows now end with the same poke, so the real poke rate is the union
of all five files — about 14 runs a day measured, worst gap 3h32 between any two
of them. That is what the 6-hour "Overdue" budget in §4.0.2 is calibrated to. The
**endpoint** is the unit of correctness, not the file —
so a free 5-minute monitor (cron-job.org, healthchecks.io) sending
`x-cron-secret` to `/api/cron/supervisor` gives per-minute precision for all four
workers at once, and so does Vercel Cron on Pro:

```json
{ "crons": [{ "path": "/api/cron/supervisor", "schedule": "*/5 * * * *" }] }
```

Three rules it shares with the watchdog on purpose, because both of them start
workers nobody asked for:

| Rule | Why |
|---|---|
| Only `late` workers run | `ok` / `running` need nothing; `never` is unconfigured setup that running by hand would hide; `stalled` / `failing` mean the job dies *when it runs*, so another run repeats the same death instead of recovering anything |
| `renew-subscriptions` is **never** started automatically | it can send a USSD charge request to a fan's phone. A missed renewal is recoverable by a person; a duplicate charge is not. It comes back in the response under `held`, with the reason, and **Run now** (§4.0.3) still runs it by hand |
| A run it starts is filed as its own (`started by the cron supervisor`) | the heartbeat is the record of who moved money — and the recovery notice (§4.0.2) reads that column to tell "the schedule came back" apart from "something restarted it", so a run must not claim to be something it was not |

#### Being told about the one thing it will not do

Holding a worker back is correct and it is also useless on its own: a worker that
nobody is told about is indistinguishable from one that never ran. So every poke
that finds a **held worker which is overdue** tells the admins — a notification
in the bell (the durable record, with the unread count that makes somebody look)
and an email (the channel that reaches a person who is not on the site), with the
link and the words *"Background jobs → Run now"*.

Two rules, both in `src/lib/services/cron-hold-alert.service.ts`:

- **Once per worker per window (12 h).** The supervisor runs on every poke — ~14
times a day — and a warning that arrives fourteen times is one somebody mutes.
The window is the notification row itself rather than anything in memory: on
serverless hosting each instance would otherwise keep its own cooldown and mail
the same worker once per instance.
- **Only `late`.** `never` is a schedule nobody has configured (setup work, and
the card says so), and `stalled` / `failing` are jobs that die when they run — a
fix, not a button. Alerting on those would put the same words in the bell every
poke while changing nothing.

The alert also answers the question the button asks. `renew-subscriptions` is the
one worker a person has to start, and *how many fans would this charge?* is what
decides it — so the poke previews the run first and puts the number in the alert:
*"Nothing has finished inside its budget. … A run now would charge 3
membership(s): 2 from wallet, 1 by USSD push to a fan's phone. Open
…/admin → Overview → Background jobs and press Run now on Renew subscriptions."*
The preview writes nothing (§4.0.5), so asking costs a read and no risk.

It never throws. This runs inside the poke that keeps renewals, releases and
publishing alive, so a mail host that is down costs a log line — never the poke —
and the notification it wrote first is already the record. If there is **no admin
account at all**, the answer says so out loud (`NOTHING WAS SENT: no admin
account exists to be told`) rather than looking like success.

- [ ] Leave `renew-subscriptions` overdue for one poke and confirm both arrive:
      the bell in the app, and an email to your admin address.
- [ ] Then check the throttle: run the supervisor again immediately and confirm
      the response reports it under `alreadyTold` and nothing new is sent.
- [ ] Confirm the case that matters most: the notification must say *what to do*
      (Admin → Overview → Background jobs → **Run now**), not merely that
      something is wrong.

A caller cannot name a worker: the endpoint takes no id, and the list of workers
it may start is `SUPERVISOR_WORKERS` in
`src/lib/services/cron-supervisor.service.ts`. `src/tests/cron-supervisor.test.ts`
**fails if that list ever drifts from the watchdog's `RECOVERABLE_WORKERS`** — two
copies of "may this be started by itself" is how one of them ends up charging
phones.

- [ ] With `APP_URL` and `CRON_SECRET` set (§4.0.1), run the `curl` above by
      hand: expect 200, and a `ran` / `held` pair that matches what the admin
      card says is actually overdue.
- [ ] Confirm it cannot be talked into running the charging worker: with
      `renew-subscriptions` overdue it must appear under `held`, and its
      heartbeat's `lastOrigin` must not change.
- [ ] After a day, check **Background jobs**: the four workers should read
      `Running on schedule` for most of the day rather than `Overdue`, and
      `/api/health` should answer 200 while nothing else is wrong.

### 4.0.5 Asking what a renewal run would charge (`?dryRun=1`)

`renew-subscriptions` is the one worker the supervisor will not start, because a
USSD push lands on a fan's phone. That refusal leaves whoever has to press **Run
now** (§4.0.3) deciding blind, and the audit log only answers afterwards. So the
same question can be asked first:

```bash
curl -s -X POST "$APP_URL/api/cron/renew-subscriptions?dryRun=1" \
  -H "x-cron-secret: $CRON_SECRET" | jq '.message, .data.lines'
#   "A run now would charge 3 membership(s): 2 from wallet, 1 by USSD push to a fan's phone"
```

`{ "dryRun": true }` in a POST body does the same thing. The answer names each
membership it would charge (`subscriptionId`, fan, creator, price, `method`, and
the phone a USSD push would go to), and lists what it would **not** charge with a
reason for each — out of attempts, inside the retry gap, an earlier checkout still
awaiting approval, or a wallet that cannot cover the price and no phone on file.

**It writes nothing, and that is the whole design.** No transaction row, no
attempt counter, no notification, no USSD push — and no run lock and no heartbeat
slot either. The heartbeat is this app's record of what moved money, so a dry run
that claimed one would also make `renew-subscriptions` look freshly run and
**silence the overdue alarm** that is the only reason somebody presses the button.
The same reason the supervisor uses it for the alert (§4.0.4) rather than starting
the worker in a pretend mode.

Both the preview and the worker decide with the same pure function
(`renewalGate` in `src/lib/services/subscription-renewal.service.ts`), so the
sentence in the bell cannot drift from what the worker then does.
`src/tests/renewal-preview.test.ts` pins the boundaries and asserts the preview
writes nothing.

- [ ] Ask before charging: run the `curl` above with `renew-subscriptions` due and
      confirm the numbers match what **Run now** then reports.
- [ ] Confirm it is genuinely read-only: the worker's `lastRunAt` / `lastOrigin`
      in **Background jobs** must not change, and no fan may receive a prompt.
- [ ] Confirm it still refuses without the secret (`401`), like every cron route
      (§4.0).

### 4.0.6 The float: warned before it is empty, not when it is

HarakaPay settles a USSD prompt out of a prepaid float on the merchant account,
and at 0 it does not refuse anything: it accepts the collect, answers *"USSD push
sent"*, and never delivers the prompt (§3.1). The customer is told it worked; the
order never settles; the merchant finds out from a complaint. The first one on
this deployment is in the admin's bell — *"Wallet top-up — TZS 1,000 did not go
through. The USSD prompt was never approved"*.

Topping the float up means moving money onto the merchant account, so the alarm
has to arrive on the way down. `src/lib/services/harakapay-float-alert.service.ts`
reads `GET /api/v1/balance` on every supervisor poke and, under
`HARAKAPAY_FLOAT_FLOOR_TZS` (default 10,000 TZS), tells the admins once per 12 h —
bell plus email — with the float, the floor, and what to top up.

| Where | What it says |
|---|---|
| `GET /api/health` | `payments: live`, and the services probe is `warn` below the floor, `fail` at 0 — a warning never joins `failing`, so `launch:check --remote` still reports READY while the float is low but usable |
| `/api/cron/supervisor` | a `float` field in every poke: `read`, `level`, `snapshot`, and what the alert did |
| The bell + email | the number, the floor, and *"top up the float on the HarakaPay merchant account"* — at most once per 12 h, throttled on the notification row so twelve pokes are one message |

Three rules worth keeping when this is changed again:

- **"Could not read the balance" is not "the float is fine".** A gateway that will
  not answer reports `read: false` with the reason; a `float_balance` the gateway
  did not send is unreadable too, never `0` — paging somebody about a float that is
  healthy is how the alarm gets ignored the one time it is right.
- **One title for both levels.** The bell line is the throttle key, so a float that
  crosses the floor and then empties inside the window is one problem and one row,
  not two. The severity lives in the message, which is read.
- **It never throws.** It runs inside the poke that also starts the workers: a
  balance call that times out may cost the alarm, never the poke.

- [ ] Set the floor for your own traffic and prove the alarm: with the float under
      it, one poke should write one notification and one email.
- [ ] Prove the throttle: poke again immediately — the answer must report
      `alreadyTold` and nothing new may be sent.
- [ ] Confirm the empty case reads honestly: at 0, the message must say the
      gateway *accepts and never delivers*, not that a payment failed.

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
- [ ] The **build** runs `prisma generate` (`build` is
      `prisma generate && next build`). Not only a `postinstall` hook — Vercel
      caches `node_modules` and skips the install entirely when the lockfile has
      not changed, so a postinstall-only generate never runs (see §5.3).
- [ ] `DATABASE_URL` points at **managed Postgres** (Neon / Supabase / RDS /
      Railway), not localhost. `npm run preflight:prod` blocks on this.
- [ ] Redis is managed, via **either** the Upstash REST pair
      (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, preferred: HTTPS,
      no TCP pool held open between serverless invocations) **or** a
      `rediss://` `REDIS_URL`. The REST pair wins when both are set. Without
      one of them rate limiting degrades to per-instance counters and every
      deploy starts with a cold cache — payment and auth throttling then depend
      on how many instances happen to be running.
- [ ] If Redis is configured, confirm it is *reachable*: a Redis that accepts
      the connection and never answers is worse than none. Every cache and
      rate-limit call is bounded (750ms) and a backend that fails twice in a row
      is skipped for a minute, so a settlement can no longer be held open by it —
      but the charge is still paying for a cache it is not getting, and rate
      limiting silently drops to per-instance memory. `npm run verify:live`
      probes it (that check is deliberately unbounded: an admin asking whether
      Redis works must get the truth, not the fast answer).
- [ ] Seed demo content **only** in dev — production starts clean
      (register the first admin through a controlled signup + role grant).
      The seed route refuses to run under `NODE_ENV=production`, so nobody can
      re-seed a live site through the API; this is about the rows already there.

### 5.1 Why `npm test` must not read `.env.local`'s `DATABASE_URL`

The database-backed suites are not read-only. They create creators, debit
wallets, release matured earnings and claw refunds back. Once `DATABASE_URL`
names a live database, a plain `npm test` would rewrite real money and delete
real rows, and a **green** run is exactly what that looks like from outside.

`src/tests/setup-env.ts` therefore resolves the test database in this order, and
this is the same shape as the existing `PAYMENT_SANDBOX` rail right below it:

| Setting | What the DB-backed suites do |
|---|---|
| `TEST_DATABASE_URL` | Run against it. **Use this** — a Neon branch is free and disposable. |
| `DATABASE_URL` is local | Run against it (the default on a dev machine). |
| `DATABASE_URL` is external | **Skip.** `DATABASE_URL` is cleared for the run, so the suites gate themselves off instead of failing. |
| `ALLOW_TESTS_ON_EXTERNAL_DB=1` | Run against `DATABASE_URL` anyway. Only for a database you accept being rewritten. |

The skip is loud on stdout, not silent, and Prisma only throws when something
actually queries — so a suite that forgets to gate fails visibly rather than
writing anywhere. That is not theoretical: adding the rail immediately caught
`cron-heartbeat.test.ts`, whose database sections ran with no gate at all.

```bash
# one-time: create a Neon branch (or any scratch database) and point the suite at it
echo 'TEST_DATABASE_URL=postgresql://...' >> .env.local
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy   # first run only
npm test            # the real number of tests, not a partial one
```

### 5.2 Clearing the demo content, and the first real accounts

A database that was ever seeded has 24 invented videos and 5 invented creators
in it, and the seed route cannot take them back out — it only ever adds. Those
rows are what a first visitor would see.

```bash
# 1. Look first. Nothing is deleted without --yes, on purpose: the first time
#    anyone runs this is on a database that may already have real users in it.
npm run demo:wipe

# 2. Delete, unless it stopped. It stops when a real person is attached to demo
#    content — a purchase, a subscription, a comment — and shows you the rows.
#    --force overrides that, and means refunding by hand.
npm run demo:wipe -- --yes

# 3. Create the first real accounts (prints a generated password once).
npm run accounts:create -- \
  --admin owner@yourdomain.com \
  --creator owner@yourdomain.com \
  --name "Your Display Name"
```

- [ ] Demo content removed (`npm run demo:wipe` reports 0 left).
- [ ] At least one real ADMIN account able to sign in.
- [ ] At least one CREATOR that can actually upload — see the KYC note below.
- [ ] Promo codes reviewed: the seed creates `WELCOME10`, `GENHUB500` and
      `TOPUP25`. The wipe lists what is still active; deactivate the rest.

**One address can be both.** `requireRole("CREATOR")` accepts an ADMIN, so
`--admin` and `--creator` may be the same email: the account stays ADMIN, gets
a `CreatorBalance` row, and can upload and moderate from one sign-in. Give the
creator side its own account later if you want the payout trail to belong to
somebody who is not also the reviewer.

**KYC is the gate.** Uploads require `kycStatus: APPROVED`, normally produced by
a review (submit at `/creator/kyc`, approve in Admin → KYC, which writes a
`KycVerification` row). `--kyc-approved` sets the flag directly and creates **no
review record**, so the account uploads while Admin → KYC shows nothing. That is
the right trade for your own account during setup and the wrong one for a third
party, which is why it is a flag and not the default.
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

### 5.3 Why the build regenerates Prisma Client itself

`build` is `prisma generate && next build`. The first half is not decoration.

Vercel caches `node_modules` between deployments and skips the install entirely
when the lockfile has not changed. `@prisma/client`'s `postinstall` hook — the
thing that normally runs `prisma generate` — is part of that install, so on a
cached build it does not happen, and the deployment is compiled against whatever
Prisma Client was baked into the cached tree.

An outdated client does not announce itself. Next.js imports every API route to
collect page data, that import loads the native query engine, and the failure
arrives wearing a Next.js costume:

```
> Build error occurred
Error: Failed to collect page data for /api/account/become-creator
  at /vercel/path0/.next/server/app/api/account/become-creator/route.js:1:955
  { clientVersion: '5.22.0', errorCode: undefined }
Error: Command "npm run build" exited with 1
```

The route named is incidental: whichever route Next imported first would have
raised it. The useful signal is `clientVersion` on an error that Next is
reporting about a page — that combination means Prisma, not the page.

- [ ] Do not "fix" this by moving `prisma generate` to `postinstall` and calling
      it done. The hook is skipped by exactly the caching that causes the
      problem.
- [ ] `prisma` stays declared in `devDependencies` (Vercel installs those for
      the build). If a deploy ever reports `prisma: command not found`, the CLI
      was not installed and must be moved to `dependencies`.
- [ ] `src/tests/build-generates-client.test.ts` fails if the generate step is
      dropped from `build`, because no local check can see this otherwise.

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

APP_URL=$DOMAIN npm run launch:check    # preflight + verify:live, one verdict (§0.1)
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


Automated gates: `npm run typecheck` · `npm test` (incl. the HarakaPay live-mode E2E
against a DB) · `npm run verify:lockfile` · `npm run preflight:prod` · `npm run build`.

No test counts are quoted here on purpose: a number in a launch checklist is
stale the next time anyone writes a test, and a checklist nobody trusts is worse
than a short one.

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

### 8.2 One balance, two writers

Money in this app is written from several places at once: a fan's wallet is
spent by a video purchase, a tip, a paid message and the renewal worker, and a
creator's balance is credited by a gateway webhook while it is drained by the
holdings release. Whenever two of those overlap, the risk is a **lost update**:
both read the same balance, both decide from what they read, and the second
write erases the first.

**The rule: the check and the write must be one statement.**

```ts
// WRONG — the comparison describes the moment before, not the write
const user = await tx.user.findUnique({ where: { id }, select: { walletBalance: true } });
if (user.walletBalance < amount) return "too low";
await tx.user.update({ where: { id }, data: { walletBalance: { decrement: amount } } });

// RIGHT — Postgres decides, and refuses rather than overdrawing
tx.user.updateMany({
  where: { id, walletBalance: { gte: amount } },
  data: { walletBalance: { decrement: amount } },
}); // count === 0 means insufficient funds, and nothing was written
```

`decrement` is *relative*, so it has no opinion about the result: against a
5,000 balance, five simultaneous purchases of 5,000 were **all accepted** and
the wallet finished at **-20,000**. Nothing raised an error. The window is
sub-millisecond against a local database — which is exactly why this class of
bug survives development and opens up on a networked one.

Where it is enforced:

| Flow | Guard |
|---|---|
| Wallet spend (purchase, tip, DM, subscribe, renewal) | `debitWallet()` in `lib/services/balance.service.ts` — one implementation, so the check cannot drift per route |
| Payout requests | `requestPayout()` in `lib/services/payout.service.ts` — conditional debit of `availableBalance` |
| Refund clawbacks | `reverseCollectedCharge()` — both legs conditional, amounts re-read once on a refusal |
| Holdings release | optimistic lock on `releasedTotal` plus `pendingBalance >= amount` — already correct, and now covered by tests |
| Credits | always `increment`, never a computed absolute value |

**The release worker and the renewal worker touching one creator at the same
instant is safe**, and there are tests for it: the release claims per creator
through `releasedTotal`, and credits are relative. What was *not* safe was the
fan's side of the same idea — five simultaneous spends of one wallet — and two
payout requests finding one balance.

**Check it, do not trust it:**

```bash
npm run audit:balances
```

It reports negative wallets, negative creator buckets (pending, available,
lifetime), and creators holding more than they have ever earned — the signature
of a credit that overwrote instead of adding. It exits `1` on a violation, so it
can run as a deploy gate or a nightly job. A clean run looks like:

```
✓ wallets below zero                                   0
✓ creator pending below zero                           0
✓ creator available below zero                         0
✓ creator lifetime earnings below zero                 0
✓ held (pending + available) above lifetime earnings   0
```

**Deliberately not left to scheduling.** `release-earnings` fires on the hour
and `renew-subscriptions` at :15, but an offset is not a guarantee — either can
be started by hand from the admin panel, GitHub Actions delays under load, and a
creator opening their balance page triggers a release for themselves. The guards
above are what hold; the offset only reduces how often they are exercised.

**Residual, stated rather than hidden:** the renewal worker's own claim on one
membership is its retry gap (`lastRenewAttemptAt`) plus the run lock, so two
*scheduled* runs cannot double-charge a fan. Reaching the service concurrently by
another route (support tooling calling it directly) is still possible; nothing
in the product does that today.
