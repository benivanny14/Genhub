"use client";

// =============================================================================
// GENHUB - Support / Contact page
// =============================================================================

import { useState } from "react";
import Header from "@/components/Header";
import { LifeBuoy, ArrowLeft, Mail, Phone, MapPin, Send } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn, toTelHref } from "@/lib/utils";
import config from "@/lib/config";

const TOPICS = [
  "Account & login",
  "Payment issue",
  "Creator payout",
  "Report content",
  "KYC verification",
  "Something else",
];

export default function SupportPage() {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const { theme } = useTheme();
  const isLight = theme === "light";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Static site fallback: open the user's mail client with the ticket pre-filled
    const body = `Topic: ${topic}\n\n${message}`;
    window.location.href = `mailto:${config.compliance.supportEmail}?subject=${encodeURIComponent(
      subject || `Genhub support — ${topic}`
    )}&body=${encodeURIComponent(body)}`;
    setSent(true);
  }

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
          <LifeBuoy className="w-8 h-8 text-brand-400" />
          <h1 className="text-3xl font-display font-bold">Support</h1>
        </div>

        {/* Contact channels */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {[
            {
              icon: Mail,
              label: "Email",
              value: config.compliance.supportEmail,
              href: `mailto:${config.compliance.supportEmail}`,
            },
            {
              icon: Phone,
              label: "Phone",
              value: config.compliance.phone,
              href: toTelHref(config.compliance.phone),
            },
            { icon: MapPin, label: "Office", value: "Dar es Salaam, TZ", href: null },
          ].map((c) => (
            <div
              key={c.label}
              className={cn(
                "rounded-2xl border p-4 text-center",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}
            >
              <c.icon className="w-5 h-5 text-brand-400 mx-auto mb-2" />
              <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>{c.label}</p>
              {c.href ? (
                <a href={c.href} className="text-sm font-medium text-brand-400 hover:underline">
                  {c.value}
                </a>
              ) : (
                <p className={cn("text-sm font-medium", isLight ? "text-gray-900" : "text-white")}>{c.value}</p>
              )}
            </div>
          ))}
        </div>

        {/* Ticket form */}
        <form
          onSubmit={handleSubmit}
          className={cn("rounded-2xl border p-6 space-y-4", isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5")}
        >
          <h2 className="font-display font-bold">Open a ticket</h2>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Topic</label>
            <select value={topic} onChange={(e) => setTopic(e.target.value)} className="input-field">
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Short summary"
              className="input-field"
              required
              maxLength={200}
            />
          </div>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder="Describe the issue…"
              className="input-field resize-none"
              required
              maxLength={4000}
            />
          </div>

          <button type="submit" className="btn-brand flex items-center gap-2">
            <Send className="w-4 h-4" /> Send to support
          </button>

          {sent && (
            <p className="text-sm text-emerald-400">
              ✓ Your email client should have opened. If not, write to{" "}
              {config.compliance.supportEmail} directly.
            </p>
          )}

          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
            We reply within 24 hours. For payment issues include your transaction ID.
          </p>
        </form>
      </main>
    </div>
  );
}
