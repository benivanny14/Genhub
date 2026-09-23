"use client";

// =============================================================================
// GENHUB - FAQ page
// =============================================================================

import { useState } from "react";
import Header from "@/components/Header";
import { HelpCircle, ArrowLeft, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

const FAQS: { q: string; a: string }[] = [
  {
    q: "What is Genhub?",
    a: "Genhub is a premium video streaming and monetization platform built for East African creators. Creators upload content, set their own prices, and earn 70% of every sale, subscription and tip.",
  },
  {
    q: "How much does it cost to join?",
    a: "Creating an account is free. You only pay when you buy a video, subscribe to a creator, or top up your wallet. Creators keep 70% of all revenue; Genhub takes a 30% platform fee.",
  },
  {
    q: "How do payments work?",
    a: "All payments go through HarakaPay mobile money — M-Pesa, Tigo Pesa and Airtel Money. You approve the charge with a USSD prompt on your phone. You can pay directly per video, or top up your wallet first and spend from it.",
  },
  {
    q: "When do creators get paid?",
    a: "Earnings enter a 14-day holding period for fraud and chargeback protection, then become available for payout. Minimum payout is TZS 30,000 and requires verified KYC.",
  },
  {
    q: "Is my data safe?",
    a: "Yes. Sessions use httpOnly JWT cookies, passwords are hashed with bcrypt, payment callbacks are verified with a shared secret, and we never store your mobile money PIN.",
  },
  {
    q: "How do I become a creator?",
    a: "Register with the Creator role, complete KYC verification (government ID + selfie), then upload your first video. Verification usually takes less than 48 hours.",
  },
  {
    q: "Can I watch on my phone?",
    a: "Yes — Genhub works in any modern mobile browser, streams adaptive HLS video, and remembers where you stopped so you can continue on any device.",
  },
  {
    q: "How do referral rewards work?",
    a: "Share your referral link from your profile. When a friend signs up, TZS 1,000 is added to your wallet instantly. There is no limit to how many friends you can invite.",
  },
  {
    q: "How do promo codes work?",
    a: "Enter a promo code in the purchase or top-up dialog. Percentage codes give % off purchases (or % extra on top-ups); fixed codes take a flat TZS amount off.",
  },
  {
    q: "How do I report content?",
    a: "Every video has a Report button. Reports are reviewed by our moderation team; violations lead to strikes, takedowns, or account bans. Copyright claims use the DMCA reason.",
  },
];

export default function FaqPage() {
  const [open, setOpen] = useState<number | null>(0);
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
          <HelpCircle className="w-8 h-8 text-brand-400" />
          <h1 className="text-3xl font-display font-bold">Frequently Asked Questions</h1>
        </div>

        <div className="space-y-3">
          {FAQS.map((faq, i) => (
            <div
              key={i}
              className={cn(
                "rounded-2xl border overflow-hidden transition",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}
            >
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className={cn(
                  "w-full flex items-center justify-between gap-4 px-5 py-4 text-left",
                  isLight ? "hover:bg-gray-50" : "hover:bg-white/5"
                )}
              >
                <span className={cn("font-medium text-sm", isLight ? "text-gray-900" : "text-white")}>
                  {faq.q}
                </span>
                <ChevronDown
                  className={cn(
                    "w-4 h-4 shrink-0 transition-transform",
                    open === i && "rotate-180",
                    isLight ? "text-gray-400" : "text-white/40"
                  )}
                />
              </button>
              {open === i && (
                <p className={cn("px-5 pb-4 text-sm leading-relaxed", isLight ? "text-gray-600" : "text-white/60")}>
                  {faq.a}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className={cn("mt-8 text-center text-sm", isLight ? "text-gray-500" : "text-white/50")}>
          Still have questions?{" "}
          <Link href="/support" className="text-brand-400 hover:underline">
            Contact support
          </Link>
        </div>
      </main>
    </div>
  );
}
