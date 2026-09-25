// =============================================================================
// GENHUB - DMCA policy page
// Takedown + counter-notice procedure for copyright owners, plus our repeat
// infringer policy. Complements the in-app "Report" button on every video.
// =============================================================================

import type { Metadata } from "next";
import Link from "next/link";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import { Copyright, Mail, Gavel, ListChecks } from "lucide-react";
import config from "@/lib/config";

export const metadata: Metadata = {
  title: "DMCA Policy",
  description:
    "How to submit a DMCA takedown notice to Genhub, what a valid notice must contain, and how counter-notices and repeat infringers are handled.",
  alternates: { canonical: "/dmca" },
  robots: { index: true, follow: true },
};

const NOTICE_REQUIREMENTS = [
  "A physical or electronic signature of the copyright owner or a person authorised to act on their behalf.",
  "Identification of the copyrighted work claimed to have been infringed.",
  // Built from the domain actually serving the site, for the same reason
  // everything else is: a takedown template that shows an address nobody can
  // open produces notices naming the wrong host — and a copyright owner who
  // cannot see the material they are complaining about sends a notice a human
  // has to guess at.
  `The exact URL of the material on Genhub that you say is infringing (for example ${config.appUrl}/video/…).`,
  "Your full name, address, telephone number and email address.",
  "A statement that you have a good-faith belief that the disputed use is not authorised by the copyright owner, its agent, or the law.",
  "A statement, under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorised to act on their behalf.",
];

const COUNTER_REQUIREMENTS = [
  "Your physical or electronic signature.",
  "Identification of the material that was removed and the URL where it appeared before removal.",
  "A statement under penalty of perjury that you have a good-faith belief the material was removed by mistake or misidentification.",
  "Your name, address and telephone number, and consent to the jurisdiction of the courts where you live.",
];

export default function DmcaPage() {
  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex items-center gap-3 mb-2">
          <Copyright className="w-7 h-7 text-brand-400" />
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white">DMCA Policy</h1>
        </div>
        <p className="text-sm text-white/50 mb-8">
          Genhub responds to clear notices of alleged copyright infringement under the Digital
          Millennium Copyright Act (DMCA).
        </p>

        <div className="space-y-8">
          <section>
            <h2 className="font-display font-bold text-lg text-white mb-3 flex items-center gap-2">
              <Mail className="w-4 h-4 text-brand-400" /> How to file a takedown notice
            </h2>
            <p className="text-sm text-white/60 mb-3">
              Send your notice to{" "}
              <span className="text-brand-300">{config.compliance.supportEmail}</span> with the
              subject line “DMCA Takedown”. A valid notice must include:
            </p>
            <ul className="space-y-2">
              {NOTICE_REQUIREMENTS.map((item) => (
                <li key={item} className="flex gap-2 text-sm text-white/60">
                  <ListChecks className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="font-display font-bold text-lg text-white mb-3 flex items-center gap-2">
              <Gavel className="w-4 h-4 text-brand-400" /> What happens next
            </h2>
            <div className="space-y-3 text-sm text-white/60">
              <p>
                We review complete notices within 24 hours. Verified infringing material is removed
                (or access is disabled) promptly, and the uploader is notified together with a copy
                of the notice.
              </p>
              <p>
                Accounts that repeatedly upload infringing material are terminated. Creators can
                appeal by emailing the same address with evidence that they own the rights or are
                licensed to publish the material.
              </p>
            </div>
          </section>

          <section>
            <h2 className="font-display font-bold text-lg text-white mb-3 flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-brand-400" /> Counter-notice
            </h2>
            <p className="text-sm text-white/60 mb-3">
              If your content was removed by mistake or misidentification, send a counter-notice
              including:
            </p>
            <ul className="space-y-2">
              {COUNTER_REQUIREMENTS.map((item) => (
                <li key={item} className="flex gap-2 text-sm text-white/60">
                  <ListChecks className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="glass-card p-5">
            <h2 className="font-display font-bold text-white mb-2">Report in-app instead</h2>
            <p className="text-sm text-white/60">
              For non-copyright issues (abuse, non-consensual content, spam) use the{" "}
              <span className="text-white/80">Report</span> button on any video or comment — it
              reaches our moderation queue directly.
            </p>
            <div className="flex flex-wrap gap-3 mt-4 text-sm">
              <Link href="/2257" className="btn-ghost">
                2257 statement
              </Link>
              <Link href="/terms" className="btn-ghost">
                Terms of Service
              </Link>
              <Link href="/support" className="btn-ghost">
                Help &amp; Support
              </Link>
            </div>
          </section>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
