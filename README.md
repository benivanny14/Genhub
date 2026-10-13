# Genhub

A video monetisation and streaming platform: creators upload scenes, set a price,
and get paid; viewers buy single videos, subscribe to creators, or pay from their
wallet. Built for East African mobile-money audiences — payments run over
SonicPesa USSD pushes, not cards.

## What it does

**Viewers** — browse by category, trending, top rated and most viewed; watch free
videos; buy a video, subscribe to a creator, tip, add to watch-later playlists
and favourites; keep a wallet and a billing history.

**Creators** — onboard and verify (KYC), upload through a signed direct upload to
private Cloudflare R2 staging; Streamtape imports and converts videos before
they can be published. Creators set prices, publish status posts, see earnings
with the 70/30 split, and request payouts.

**Admins** — moderation queue, KYC review, payouts, coupons, earnings, a payment
reconciliation view for charges the network never settled, and a launch checklist
that probes every external service for real.

## Stack

Next.js 15 (App Router) · TypeScript · Prisma + Postgres · Tailwind ·
Streamtape + Cloudflare R2 (video) · Bunny Storage (images) · SonicPesa (payments) · Upstash Redis (rate limits + cache)
· Resend/SMTP (email) · Vitest

## Running it locally

```bash
npm install
cp .env.example .env.local     # then fill it in — see SETUP.md
npm run db:push                # create the schema
npm run db:seed                # demo content
npm run dev
```

`SETUP.md` walks through every variable, where to get it, and what breaks without
it. Two commands tell you the truth about your configuration at any time:

```bash
npm run verify:live      # real connections: Postgres, Redis, Streamtape/R2, SMTP, SonicPesa
npm run preflight:prod   # what is still blocking real users
```

The admin panel's **Setup** tab shows the same readiness checks. For R2 access
and upload CORS, use `npm run verify:r2`; then test a small video upload and
playback after deployment (see `PRODUCTION.md`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run test` | Vitest suite |
| `npm run db:push` / `db:deploy` | Sync schema (dev) / apply migrations (production) |
| `npm run db:seed` | Demo content |
| `npm run admin:create` | Create an admin account |
| `npm run verify:live` | Open real connections to every service |
| `npm run preflight:prod` | Launch blockers (`--env-from .env.vercel` to check a list pulled from the deployment) |
| `npm run launch:check` | Post-deploy: preflight + verify:live, one verdict (`--collect` for a real USSD push) |
| `npm run launch:check:remote` | The same verdict asked of the deployment (`--json` for CI; needs only `CRON_SECRET`) |
| `npm run launch:check:wait` | The remote check, repeated until READY — for the minutes a redeploy takes |
| `npm run setup` | Show what is left to configure, and open `.env.local` |
| `npm run verify:r2` | Verify R2 bucket access and production-origin upload CORS |

## Money

Single purchases and tips use a 70/30 split, with the creator's share held for 14
days before it becomes withdrawable (chargeback window). Subscriptions renew
automatically and are charged from the wallet or by USSD push. Scheduled
operational jobs release matured earnings and renew subscriptions; see
`PRODUCTION.md` for their deployment and monitoring requirements.

## Payments and compliance

SonicPesa is the only gateway. Every charge is verified against the gateway before
access is granted, and a charge the customer approved but the network never settled
is shown as *under investigation* rather than inviting a second payment.

Uploads carry an 18 U.S.C. § 2257 attestation that the server enforces, alongside
KYC, DMCA, Terms and Privacy pages. `PRODUCTION.md` documents the legal and
operational requirements before real users are allowed in.
