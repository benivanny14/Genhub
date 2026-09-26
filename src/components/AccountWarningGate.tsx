"use client";

// =============================================================================
// GENHUB - The warning a person has to read
//
// A warning is the step before a ban, and it used to be delivered as a
// notification — which means it was delivered to a bell the recipient can simply
// never open. They kept uploading (or kept behaving) until the ban landed, which
// fails them and wastes the warning entirely.
//
// So this mounts once, above every page, and shows any unacknowledged warning as
// a modal that cannot be dismissed: no close button, no backdrop click. The only
// way past it is the button, which writes `acknowledgedAt` on the server. The
// record of the warning and the record of it being read are the same row, which
// is what makes "we told them" checkable later.
//
// It lives in the layout rather than on /creator because warnings are issued to
// viewers too, and a suspended viewer has no dashboard to be blocked on.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

interface Warning {
  id: string;
  action: string;
  reason: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

/** How often to look for a warning issued while somebody is browsing. */
const POLL_MS = 120_000;

export default function AccountWarningGate() {
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [acking, setAcking] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/creator/warnings");
      // 401 is the ordinary signed-out case, not an error: there are no warnings
      // to show somebody who is not signed in.
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) setWarnings(data.data.warnings || []);
    } catch {
      // Offline or the API is down. Silence is right here — this is an overlay,
      // and a network hiccup must not sit on top of every page.
    }
  }, []);

  useEffect(() => {
    void load();

    // A warning can be issued while somebody is mid-session, and waiting for the
    // next full page load to show it is how a warning arrives a day late.
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void load();
    };
    const timer = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  // Oldest first: read them in the order they were issued.
  const unread = warnings.filter((w) => !w.acknowledgedAt);
  const current = unread[0];

  // The page behind is unusable while this is up, so it must not scroll.
  useEffect(() => {
    if (!current) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [current]);

  async function acknowledge(id: string) {
    setAcking(id);
    setFailed(false);
    try {
      const res = await fetch("/api/creator/warnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.success) {
        // Optimistic on purpose: the server has already recorded it, and this
        // only decides which warning is shown next.
        setWarnings((prev) =>
          prev.map((w) =>
            w.id === id ? { ...w, acknowledgedAt: new Date().toISOString() } : w
          )
        );
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setAcking(null);
    }
  }

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-warning-title"
    >
      <div className="glass-card w-full max-w-lg p-6 animate-slide-up">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-6 h-6 text-red-400" />
          <h2 id="account-warning-title" className="text-xl font-display font-bold">
            Warning from Genhub
          </h2>
        </div>

        <p className="text-sm text-white/60 mt-2">
          An admin has issued you a warning. Read it and confirm below — this has
          to be acknowledged before you can carry on.
        </p>

        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-white/90 whitespace-pre-wrap break-words">
            {current.reason}
          </p>
          <p className="text-xs text-white/40 mt-2">
            {current.action === "WARNING" ? "Warning" : current.action} ·{" "}
            {new Date(current.createdAt).toLocaleString("en-GB")}
          </p>
        </div>

        <p className="text-xs text-amber-300/90 mt-3 leading-relaxed">
          Three warnings remove your account. Ujumbe huu unatoka kwa admin —
          unatakiwa kuusoma na kubonyeza kitufe hapa chini kuthibitisha.
        </p>

        {unread.length > 1 && (
          <p className="text-xs text-white/50 mt-2">
            {unread.length - 1} more warning{unread.length - 1 === 1 ? "" : "s"} to read
            after this one.
          </p>
        )}

        {failed && (
          <p className="text-xs text-red-300 mt-3">
            Could not save that — check your connection and try again.
          </p>
        )}

        <button
          onClick={() => acknowledge(current.id)}
          disabled={acking === current.id}
          className="btn-brand w-full mt-5 disabled:opacity-50"
        >
          {acking === current.id ? "Saving…" : "I have read this — continue"}
        </button>
      </div>
    </div>
  );
}
