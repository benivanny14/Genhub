// =============================================================================
// GENHUB - 18 U.S.C. § 2257 Compliance page
// Required statement for a platform that hosts adult content: records
// custodian, age-verification duties of every uploader, and how to reach us.
// =============================================================================

import type { Metadata } from "next";
import Link from "next/link";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import { ShieldCheck, FileText, Mail, AlertTriangle } from "lucide-react";
import config from "@/lib/config";

export const metadata: Metadata = {
  title: "18 U.S.C. § 2257 Statement",
  description:
    "Genhub's 18 U.S.C. § 2257 records statement: age verification duties for every creator, the records custodian, and how to report non-compliant content.",
  alternates: { canonical: "/2257" },
  robots: { index: true, follow: true },
};

// 28 C.F.R. § 75.2 requires the custodian's real name, title and place of
// business to be published. Set these in the environment so the statement can
// never drift from the real entity holding the records. All three come from
// one place (config.compliance) so this page cannot contradict the DMCA page,
// the Terms, or the address in the footer.
const COMPANY_LEGAL_NAME = config.compliance.legalName;
const COMPANY_ADDRESS = config.compliance.address;
const SUPPORT_EMAIL = config.compliance.supportEmail;

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Compliance statement",
    body: [
      "Genhub is an adult content platform restricted to users aged 18 years or older. All performers appearing in content published on Genhub were over the age of 18 at the time the content was created.",
      "Every creator must tick an explicit 18 U.S.C. § 2257 attestation before a video can be created. The server refuses to store any video without it, and the time of the attestation is recorded against the video along with the creator's verified identity (KYC).",
    ],
  },
  {
    title: "Records custodian",
    body: [
      "Proof-of-age records required by 18 U.S.C. § 2257 and 28 C.F.R. Part 75 are maintained by the Records Custodian below and are available for inspection by authorised parties during normal business hours.",
      `Records Custodian, ${COMPANY_LEGAL_NAME} — ${SUPPORT_EMAIL}`,
    ],
  },
  {
    title: "Creator obligations",
    body: [
      "Creators may not upload, and Genhub does not knowingly publish, any content depicting a person under 18 years of age, non-consensual activity, or any material prohibited by our Terms of Service.",
      "Creators must keep government-issued photo identification and signed consent records for every performer, and must provide them to the Records Custodian within 5 business days of a request. Failure to do so results in immediate removal of the content and suspension of the account.",
    ],
  },
  {
    title: "Enforcement and reporting",
    body: [
      "Genhub reviews every abuse report and removes content that fails these requirements within 24 hours of confirmation. Accounts that upload non-compliant material are banned and reported to the relevant authorities where required by law.",
      `If you believe content on Genhub violates these requirements, email ${SUPPORT_EMAIL} with the video link and details. Reports are treated confidentially.`,
      "Takedown and copyright notices go to the same inbox. See our DMCA policy for what a valid notice must contain.",
    ],
  },
];

export default function Section2257Page() {
  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="w-7 h-7 text-brand-400" />
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-white">
            18 U.S.C. § 2257 Statement
          </h1>
        </div>
        <p className="text-sm text-white/50 mb-8">
          Last updated: {new Date().getFullYear()} · Applies to all content published on Genhub
        </p>

        <div className="glass-card p-4 mb-8 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-white/70">
            Genhub is strictly for adults. Every uploader confirms that all performers are 18+ and
            that age records are held on file.
          </p>
        </div>

        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="font-display font-bold text-lg text-white mb-3 flex items-center gap-2">
                <FileText className="w-4 h-4 text-brand-400" />
                {section.title}
              </h2>
              <div className="space-y-3">
                {section.body.map((paragraph, i) => (
                  <p key={i} className="text-sm text-white/60 leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-10 glass-card p-5">
          <h2 className="font-display font-bold text-white mb-2 flex items-center gap-2">
            <Mail className="w-4 h-4 text-brand-400" /> Contact
          </h2>
          <p className="text-sm text-white/60">
            Records custodian and compliance enquiries:{" "}
            <span className="text-brand-300">{SUPPORT_EMAIL}</span>
          </p>
          <p className="text-sm text-white/60 mt-2">
            {COMPANY_ADDRESS ? (
              <>
                Custodian of records, {COMPANY_LEGAL_NAME}:{" "}
                <span className="text-white/80">{COMPANY_ADDRESS}</span>
              </>
            ) : (
              <>
                The custodian&apos;s place of business is available to authorised parties on request
                — write to <span className="text-brand-300">{SUPPORT_EMAIL}</span>.
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-3 mt-4 text-sm">
            <Link href="/dmca" className="btn-ghost">
              DMCA policy
            </Link>
            <Link href="/terms" className="btn-ghost">
              Terms of Service
            </Link>
            <Link href="/support" className="btn-ghost">
              Report content
            </Link>
          </div>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
