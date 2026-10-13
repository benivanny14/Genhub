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
    <code className="rounded glass-surface px-1.5 py-0.5 text-xs text-brand-200">
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
      <Section icon={Upload} title="Video upload and Streamtape processing">
        <p>
          Streamtape is the only video host. Video bytes are uploaded by the browser to private
          Cloudflare R2 staging, then Streamtape imports the staged object and converts it. No
          Bunny Stream upload, playback, webhook or encoding worker is used.
        </p>
        <div className="space-y-3 mt-2">
          <Step n={1} title="Create an upload session">
            <Code>POST /api/videos/upload-signature</Code> verifies creator permissions and KYC,
            then returns a signed R2 upload URL and a short-lived session token.
          </Step>
          <Step n={2} title="Upload directly to private R2">
            The browser sends the video with a signed <Code>PUT</Code>. Vercel never proxies the
            video bytes; the bucket CORS policy must allow the production origin and content-type.
          </Step>
          <Step n={3} title="Import and convert at Streamtape">
            <Code>POST /api/videos/upload-complete</Code> asks Streamtape to import a temporary
            signed R2 URL. The browser polls <Code>POST /api/videos/upload-status</Code> until the
            remote file is converted. The staging object is then removed.
          </Step>
          <Step n={4} title="Finalize only a ready file">
            <Code>POST /api/videos</Code> verifies the creator-bound session and converted
            Streamtape file id before writing the video row. Old Bunny-backed records remain
            unpublished drafts until their creators reupload them. Purchase history is preserved.
          </Step>
        </div>
        <p className="text-white/50 text-xs mt-3">
          Streamtape iframe URLs are shareable outside GenHub after an entitled viewer receives
          them. The provider does not offer per-viewer signed playback or DRM.
        </p>
      </Section>

      {/* --------------------------------------------------------------- */}
      <Section icon={CreditCard} title="Payments">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Checkout is a USSD push to the customer&apos;s phone via SonicPesa; the
            charge is always the amount on the video row, never a number from the
            client.
          </li>
          <li>
            Settlement arrives at <Code>POST /api/webhooks/sonicpesa</Code> (HMAC
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
            <Code>release-earnings</Code> — legacy: there is no holding period, so
            creator earnings are available immediately; this only clears a
            balance left over from before that change.
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
