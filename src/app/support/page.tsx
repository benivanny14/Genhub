"use client";

// =============================================================================
// GENHUB - Support / Contact page
// =============================================================================

import { useState, useEffect } from "react";
import Header from "@/components/Header";
import { LifeBuoy, ArrowLeft, Mail, Phone, MapPin, Send, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeProvider";
import { cn, toTelHref } from "@/lib/utils";
import config from "@/lib/config";
import { fetchCurrentUser } from "@/lib/current-user";

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
  const [replyEmail, setReplyEmail] = useState("");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useTheme();
  const isLight = theme === "light";

  // Whether a reply address has to be asked for. A signed-in ticket already
  // carries the account, so the field stays out of the way for them.
  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setSignedIn(Boolean(data?.success));
        if (data?.success && data.data?.email) setReplyEmail(data.data.email);
      })
      .catch(() => {
        // A signed-out visitor gets a 401 response, not a rejection; a rejection
        // here is a network failure, and the safe reading of that is "ask for an
        // address", which is what `false` does.
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * POST the ticket. The old version opened a `mailto:` link, which only works
   * when the visitor's machine has a mail client registered and leaves the
   * message sitting in a draft they still have to send — so a ticket could look
   * sent and never leave the browser. This says what actually happened: success
   * means the message reached support, failure names a way to reach them.
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, subject, message, email: replyEmail }),
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        setSent(true);
        return;
      }
      setError(data?.error || "We could not send your message. Please try again.");
    } catch {
      setError("Network error — your message was not sent. Please try again.");
    } finally {
      setSending(false);
    }
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
              minLength={3}
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
              minLength={10}
              maxLength={4000}
            />
            <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>
              For a payment issue, include the transaction ID — it is the one thing we cannot
              look up for you.
            </p>
          </div>

          {/* Only when nobody is signed in: a ticket with no reply address is a
              ticket nobody can answer, and the people who need support most are
              often the ones who cannot log in. */}
          {signedIn === false && (
            <div>
              <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>
                Your email (we reply here)
              </label>
              <input
                type="email"
                value={replyEmail}
                onChange={(e) => setReplyEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-field"
                autoComplete="email"
                required
              />
            </div>
          )}

          <button
            type="submit"
            disabled={sending}
            className="btn-brand flex items-center gap-2 disabled:opacity-60"
          >
            <Send className="w-4 h-4" /> {sending ? "Sending…" : "Send to support"}
          </button>

          {error && (
            <p className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" /> {error}
            </p>
          )}

          {sent && (
            <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              ✓ Message received. Support will reply to{" "}
              {replyEmail || "the email on your account"} — usually within 24 hours. Keep this
              page or the email for reference.
            </p>
          )}

          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
            Tickets reach support immediately. If you would rather write to us yourself, our
            address is {config.compliance.supportEmail}.
          </p>
        </form>
      </main>
    </div>
  );
}
