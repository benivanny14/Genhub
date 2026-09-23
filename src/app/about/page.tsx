"use client";

// =============================================================================
// GENHUB - About page
// =============================================================================

import Header from "@/components/Header";
import { Info, ArrowLeft, Heart, Globe, Shield, Zap } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";
import config from "@/lib/config";

const VALUES = [
  {
    icon: Heart,
    title: "Creators first",
    body: "70% of every shilling goes to the creator. Transparent splits, real-time analytics, and payouts you can track.",
  },
  {
    icon: Globe,
    title: "Built for East Africa",
    body: "Mobile-money native (M-Pesa, Tigo, Airtel), Swahili and English, and pricing that makes sense in TZS.",
  },
  {
    icon: Shield,
    title: "Safe by default",
    body: "18+ age gate, KYC verification, signature-verified webhooks, and a fast human moderation team.",
  },
  {
    icon: Zap,
    title: "Fast streaming",
    body: "Adaptive HLS delivery with instant free teasers, resume-playback, and hover previews on every card.",
  },
];

export default function AboutPage() {
  const { theme } = useTheme();
  const isLight = theme === "light";

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-brand-400 hover:text-brand-300 text-sm mb-6 transition"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>

        <div className="flex items-center gap-3 mb-8">
          <Info className="w-8 h-8 text-brand-400" />
          <h1 className="text-3xl font-display font-bold">About Genhub</h1>
        </div>

        <div className={cn("rounded-2xl border p-8 space-y-6", isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5")}>
          <section>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Genhub is a premium video streaming platform built in Tanzania for East African
              creators. We give musicians, comedians, educators, filmmakers and internet
              personalities a place to publish exclusive content, set their own prices, and earn a
              real living from their audience — with payouts in Tanzanian shillings straight to
              mobile money.
            </p>
          </section>

          <section>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Our model is simple: creators keep <strong>70%</strong> of every sale, subscription
              and tip. Viewers pay only for what they want, with a free teaser on every video and a
              secure wallet for one-tap purchases. Everyone is verified, everything is moderated,
              and the platform is for audiences 18+.
            </p>
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {VALUES.map((v) => (
              <div
                key={v.title}
                className={cn(
                  "rounded-xl p-4 border",
                  isLight ? "bg-gray-50 border-gray-100" : "bg-surface-300/40 border-white/5"
                )}
              >
                <v.icon className="w-5 h-5 text-brand-400 mb-2" />
                <h3 className={cn("font-medium text-sm mb-1", isLight ? "text-gray-900" : "text-white")}>
                  {v.title}
                </h3>
                <p className={cn("text-xs leading-relaxed", isLight ? "text-gray-500" : "text-white/50")}>
                  {v.body}
                </p>
              </div>
            ))}
          </div>

          <section>
            <h2 className="font-display font-bold mb-2">Join us</h2>
            <p className={cn("text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
              Watch as a viewer, create as a creator, or partner with us — start at{" "}
              <Link href="/register" className="text-brand-400 hover:underline">
                registration
              </Link>{" "}
              or read the{" "}
              <Link href="/faq" className="text-brand-400 hover:underline">
                FAQ
              </Link>
              .
            </p>
          </section>

          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
            {config.compliance.legalName}
            {config.compliance.address ? ` — ${config.compliance.address}` : " — Tanzania"}.{" "}
            {config.compliance.supportEmail}
          </p>
        </div>
      </main>
    </div>
  );
}
