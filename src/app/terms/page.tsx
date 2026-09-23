"use client";

import Header from "@/components/Header";
import { Shield, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";
import config from "@/lib/config";

export default function TermsPage() {
  const { theme } = useTheme();
  const isLight = theme === "light";

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-12">
        <Link href="/" className="inline-flex items-center gap-2 text-brand-400 hover:text-brand-300 text-sm mb-6 transition">
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>

        <div className="flex items-center gap-3 mb-8">
          <Shield className="w-8 h-8 text-brand-400" />
          <h1 className="text-3xl font-display font-bold">Terms of Service</h1>
        </div>

        <div className={cn("glass-card p-8 space-y-6", isLight && "bg-white")}>
          <section>
            <h2 className="text-lg font-display font-bold mb-3">1. Acceptance of Terms</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              By accessing or using Genhub (&quot;the Platform&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Platform. Genhub reserves the right to modify these terms at any time.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">2. Age Requirement</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              You must be at least 18 years of age to create an account or access premium content on Genhub. By using this Platform, you represent and warrant that you are of legal age.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">3. Content & Ownership</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Creators retain full ownership of their uploaded content. Genhub is granted a limited license to distribute, encode, and deliver content on behalf of creators. Creators are responsible for ensuring their content complies with all applicable laws.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">4. Revenue & Payouts</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Creators earn 70% of revenue from video sales. Genhub retains a 30% platform fee. All earnings are subject to a 14-day holding period. Minimum payout threshold is TZS 30,000. KYC verification is required before payouts.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">5. Prohibited Content</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Content that is illegal, non-consensual, exploitative, or violates copyright is strictly prohibited. Violations result in immediate account termination and potential legal action.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">6. Account Termination</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Genhub reserves the right to suspend or terminate any account that violates these terms. Three strikes result in automatic permanent ban and forfeiture of pending balances.
            </p>
          </section>

          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
            Last updated: September 2026. For questions, contact {config.compliance.supportEmail}
          </p>
        </div>
      </main>
    </div>
  );
}
