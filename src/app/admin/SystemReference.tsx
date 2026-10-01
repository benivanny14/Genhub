"use client";

// =============================================================================
// GENHUB - Admin-only system reference
//
// This is where the platform's internals live ON PURPOSE. How uploads are
// ingested, which provider holds the media, where the encoding callbacks land,
// how a charge settles — none of it is shown on a page an ordinary user can
// reach, because a walkthrough of the plumbing is a map for anyone looking for a
// way in. Operators and support need it; visitors do not.
//
// It is static text, not a live probe: the live checks (are the keys accepted?
// does the CDN sign?) are on Setup and Overview. Keep this file about how the
// pieces fit together, and keep operational detail out of user-facing copy.
// =============================================================================

import {
  Upload,
  Webhook,
  CreditCard,
  Database,
  ShieldCheck,
  Globe,
  Clock,
} from "lucide-react";

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Upload;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-card p-5">
      <h2 className="font-display font-bold flex items-center gap-2 mb-3">
        <Icon className="w-5 h-5 text-brand-400" />
        {title}
      </h2>
      <div className="space-y-3 text-sm text-white/70 leading-relaxed">{children}</div>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-xs font-bold text-brand-300">
        {n}
      </span>
      <div>
        <p className="font-medium text-white/90">{title}</p>
        <p className="text-white/60">{children}</p>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-300/50 px-1.5 py-0.5 text-xs text-brand-200">
      {children}
    </code>
  );
}

export default function SystemReference() {
  return (
    <div className="space-y-6">
      <div className="glass-card p-5">
        <h2 className="font-display font-bold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-brand-400" />
          System reference
        </h2>
        <p className="text-sm text-white/50 mt-1">
          How the platform is wired, kept here so it stays off the pages users and
          visitors can reach. Everything below is internal.
        </p>
      </div>

      {/* --------------------------------------------------------------- */}
      <Section icon={Upload} title="Video upload &amp; processing">
        <p>
          A creator&apos;s file goes directly from the browser to Bunny Stream&apos;s
          resumable TUS endpoint. Genhub only creates the signed session, checks
          ownership and confirms the final byte offset; video bytes never pass
          through Vercel, R2 or a separate Worker.
        </p>
        <div className="space-y-3 mt-2">
          <Step n={1} title="Create a signed upload session">
            <Code>POST /api/videos/upload-signature</Code> authenticates the
            creator, checks KYC and limits, creates the Bunny video slot, then
            returns a short-lived session token and Bunny TUS URL. The library key
            stays on the server.
          </Step>
          <Step n={2} title="Upload resumable chunks directly">
            The browser sends 16&nbsp;MB <Code>PATCH</Code> chunks to Bunny with
            retries. Before each resume it asks Bunny for the saved offset, so a
            connection reset continues from the confirmed byte instead of
            restarting the whole file.
          </Step>
          <Step n={3} title="Confirm and publish metadata">
            <Code>POST /api/videos/upload-complete</Code> confirms that Bunny has
            the declared length. Then <Code>POST /api/videos</Code> verifies the
            signed creator session again before writing the database row. The row
            enters processing immediately while Bunny encodes in the background.
          </Step>
          <Step n={3} title="Store the row, live, immediately">
            <Code>POST /api/videos</Code> writes the row <em>published</em> with{" "}
            <Code>encodingStatus = 0</Code>. The post is on the creator&apos;s
            profile and in the feed straight away, marked{" "}
            <Code>status = PROCESSING</Code> — an &ldquo;Inachakatwa...&rdquo; badge
            over the cover, with nothing to press. Only playback waits for the
            host, and a scene Bunny fails is kept out of the public feed.
          </Step>
          <Step n={4} title="The host calls us back">
            Bunny Stream posts a signed callback to{" "}
            <Code>POST /api/webhooks/bunny</Code> on every state change. On{" "}
            <Code>Status 3</Code> (Finished) the row is refreshed from the API and
            the creator is notified once. It is already published, so nothing has
            to flip: the badge is what changes. Open pages learn it by polling{" "}
            <Code>POST /api/videos/status</Code> and swap the placeholder for the
            player in place; the two on-read refreshes — a creator&apos;s own
            dashboard and an owner&apos;s or an admin&apos;s read of the video
            page — cover the case where no webhook is configured.
          </Step>
        </div>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={Webhook} title="The encoding webhook">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Endpoint: <Code>/api/webhooks/bunny</Code>. Set it as the Stream
            library&apos;s Webhook URL, for example{" "}
            <Code>https://&lt;your-domain&gt;/api/webhooks/bunny</Code>.
          </li>
          <li>
            Verification: Bunny signs the exact raw request body with HMAC-SHA256
            and sends lowercase hex in <Code>X-BunnyStream-Signature</Code>. The
            signing key is the library&apos;s <strong>Read-Only</strong> API key,
            kept in <Code>BUNNY_STREAM_WEBHOOK_SECRET</Code>. It is a different key
            from <Code>BUNNY_STREAM_API_KEY</Code> and can be rotated on its own.
          </li>
          <li>
            The body is verified <em>before</em> it is parsed, and the handler never
            trusts the payload beyond the video id — it re-reads the real status
            from the API, so a forged callback cannot publish a video that is not
            actually ready.
          </li>
          <li>
            With no secret configured the route fails closed in production (401);
            in development it accepts unsigned callbacks so local work needs no
            secret.
          </li>
          <li>
            Verifying it: the Setup tab has a <Code>Bunny webhook</Code> check that
            reports the secret&apos;s state and when a real callback last arrived
            (every verified one is recorded), plus a button that posts a signed
            callback to this deployment&apos;s own endpoint and a forged one beside
            it. Bunny&apos;s library API cannot report the Webhook URL it holds —
            it answers with counts and nothing else — so that single setting is
            confirmed by eye against <Code>/api/webhooks/bunny</Code>, and then by
            the first callback that appears in the check.
          </li>
        </ul>
        <div className="mt-2 rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-white/50">
              <tr>
                <th className="text-left px-3 py-2">Webhook Status</th>
                <th className="text-left px-3 py-2">Meaning</th>
                <th className="text-left px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="text-white/70">
              {[
                ["0/1/2", "Queued / processing / encoding", "refresh quietly"],
                ["3", "Finished — fully playable", "refresh + notify (already published)"],
                ["4", "One resolution finished (playable)", "refresh"],
                ["5", "Encoding failed", "refresh + notify the creator"],
                ["6/7", "Presigned upload started / finished", "refresh"],
                ["8", "Presigned upload failed", "refresh + notify"],
                ["9/10", "Captions / title generated", "refresh"],
              ].map(([s, m, a]) => (
                <tr key={s} className="border-t border-white/5">
                  <td className="px-3 py-2 font-mono">{s}</td>
                  <td className="px-3 py-2">{m}</td>
                  <td className="px-3 py-2">{a}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-white/50 text-xs mt-2">
          Note: this is Bunny&apos;s own numbering, and the same one it reports as
          a video object&apos;s <Code>status</Code> — 3 means Finished in both.
          The lifecycle still re-reads the object rather than trusting the
          callback, so a stale or forged payload cannot make a video look ready.
        </p>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={Clock} title="Why nothing depends on one scheduler">
        <p>
          Completion is announced three ways, in order of speed, so a video never
          strands because a schedule did not fire:
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong>Webhook</strong> — the fast path, seconds after the host
            finishes.
          </li>
          <li>
            <strong>Creator dashboard</strong> —{" "}
            <Code>GET /api/creator/videos</Code> refreshes that creator&apos;s own
            pending uploads on read (with a re-check floor), so a creator watching
            their page advances their own video.
          </li>
          <li>
            <strong>Video page read</strong> —{" "}
            <Code>GET /api/videos/&lt;id&gt;</Code> refreshes a stale row when the
            video&apos;s owner or an admin opens its own page, so the person with
            the most reason to care can always advance it.
          </li>
        </ul>
        <p className="text-white/60">
          There is <strong>no scheduled encoding poller</strong>: the webhook is
          the source of truth, and the two on-read paths are the fallback. They
          all call the same lifecycle code, so publication, the 8-minute duration
          floor and the once-only notification cannot drift between them.
        </p>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={CreditCard} title="Payments">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Checkout is a USSD push to the customer&apos;s phone via ClickPesa; the
            charge is always the amount on the video row, never a number from the
            client.
          </li>
          <li>
            Settlement arrives at <Code>POST /api/webhooks/clickpesa</Code> (HMAC
            checksum or a shared token in <Code>?t=</Code>, fail-closed in
            production) and through{" "}
            <Code>/api/payments/status/&lt;orderId&gt;</Code>, which reconciles with
            the gateway on demand.
          </li>
          <li>
            The <Code>reconcile-payments</Code> worker sweeps every checkout still
            pending, so a missed callback delays settlement by at most one sweep.
          </li>
          <li>
            Public pages describe the outcome (&quot;pay with mobile money&quot;)
            and not the rails — the gateway, the callback and the reconciliation
            live here.
          </li>
        </ul>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={Database} title="Background workers">
        <p>
          Each worker is idempotent, holds a run lock and records a heartbeat (see{" "}
          <Code>lib/services/cron-heartbeat.service.ts</Code>). The Schedule and
          Jobs panels on Overview show their live health.
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Code>release-earnings</Code> — move matured funds out of the 14-day
            hold.
          </li>
          <li>
            <Code>reconcile-payments</Code> — settle or flag stale charges.
          </li>
          <li>
            <Code>renew-subscriptions</Code> — renew due subscriptions.
          </li>
          <li>
            <Code>earnings-digest</Code> — weekly creator summary email.
          </li>
        </ul>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={Globe} title="What stays internal">
        <p>
          Provider names, endpoints, keys, encrypted/verification mechanisms and
          step-by-step flows are documented only on admin pages like this one.
          Anything reachable by a visitor, viewer or creator describes what happens
          for them — never how it is built or which systems run it. When you add a
          feature, keep that line: outcome on the public page, mechanism here.
        </p>
      </Section>
    </div>
  );
}
