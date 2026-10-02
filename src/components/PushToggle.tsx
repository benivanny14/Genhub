"use client";

// =============================================================================
// GENHUB - The browser-notifications switch
//
// One card, one switch. It reflects the browser's real state rather than a
// server flag, because the two can disagree: a person who revoked permission in
// their browser settings is not subscribed however our database reads. Asking
// the browser (see lib/push-client.ts) is what keeps the switch honest.
//
// It renders nothing at all when push is unsupported or unconfigured — a dead
// toggle is worse than no toggle.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useI18n } from "@/lib/i18n";
import {
  getPushState,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from "@/lib/push-client";

export default function PushToggle() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/push/vapid");
        const body = await res.json();
        if (cancelled) return;
        if (!body?.success || !body.data?.configured) {
          setAvailable(false);
          setState("unsupported");
          return;
        }
        setAvailable(true);
        setState(await getPushState());
      } catch {
        if (!cancelled) {
          setAvailable(false);
          setState("unsupported");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      const result =
        state === "subscribed" ? await unsubscribeFromPush() : await subscribeToPush();
      if (result.ok) {
        setState(result.state);
        toast(
          "success",
          result.state === "subscribed" ? t("push.on") : t("push.off")
        );
      } else if (result.state === "denied") {
        setState("denied");
        toast("warning", t("push.blocked"));
      } else {
        toast("error", result.error || t("push.changeFailed"));
      }
    } finally {
      setBusy(false);
    }
  }, [state, toast, t]);

  if (!available) return null;

  const subscribed = state === "subscribed";
  // `t` is used in the click handler too; keep the dependency honest there.

  return (
    <div className="glass-card p-6 space-y-3">
      <h2 className="font-display font-bold flex items-center gap-2">
        {subscribed ? (
          <Bell className="w-5 h-5 text-brand-400" />
        ) : (
          <BellOff className="w-5 h-5 text-white/50" />
        )}
        {t("push.title")}
      </h2>
      <p className="text-sm text-white/60">{t("push.desc")}</p>
      {state === "denied" && (
        <p className="text-xs text-amber-300">{t("push.blocked")}</p>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={subscribed}
        className={
          subscribed
            ? "btn-ghost flex items-center gap-2 disabled:opacity-50"
            : "btn-brand flex items-center gap-2 disabled:opacity-50"
        }
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : subscribed ? (
          <BellOff className="w-4 h-4" />
        ) : (
          <Bell className="w-4 h-4" />
        )}
        {subscribed ? t("push.turnOff") : t("push.turnOn")}
      </button>
    </div>
  );
}
