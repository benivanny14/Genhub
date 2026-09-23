"use client";

import Header from "@/components/Header";
import { Lock, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";
import config from "@/lib/config";

export default function PrivacyPage() {
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
          <Lock className="w-8 h-8 text-brand-400" />
          <h1 className="text-3xl font-display font-bold">Privacy Policy</h1>
        </div>

        <div className={cn("glass-card p-8 space-y-6", isLight && "bg-white")}>
          <section>
            <h2 className="text-lg font-display font-bold mb-3">1. Information We Collect</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              We collect your name, email, phone number, payment information, viewing history, device information, and IP address. KYC verification requires government ID documents and selfies.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">2. How We Use Your Information</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Your data is used to provide platform services, process payments, prevent fraud, enforce KYC compliance, personalize your experience, and communicate important updates. We never sell your personal data to third parties.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">3. Data Security</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              We employ industry-standard encryption (TLS 1.3), secure HTTP-only cookies, HMAC webhook verification, and Redis-backed rate limiting to protect your data. KYC documents are encrypted at rest and reviewed by authorized personnel only.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">4. Content Protection</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Video content is protected via signed HLS tokens with expiration, dynamic viewer watermarking, and DRM-ready delivery through Bunny.net. Watermarks display viewer identifiers to prevent screen recording.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">5. Your Rights</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              You may request access to, correction of, or deletion of your personal data at any time. Contact {config.compliance.supportEmail} for data-related requests. Account deletion will remove all personal data within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-display font-bold mb-3">6. Cookies</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Genhub uses essential cookies for authentication, session management, and security. We also use analytics cookies to understand platform usage patterns. You can manage cookie preferences in your browser settings.
            </p>
          </section>

          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
            Last updated: September 2026. For privacy-related inquiries, contact privacy@genhub.co.tz
          </p>
        </div>
      </main>
    </div>
  );
}
