"use client";

// =============================================================================
// GENHUB - Notifications
//
// The place a creator, a viewer or an admin reads what Genhub and its admins
// have told them. Until this page existed the ONLY surface was the bell in the
// header — and the bell is inside the desktop nav (`hidden md:flex`), so on a
// phone there was no notification surface at all. A creator whose withdrawal an
// admin rejected with a reason written in plain words never saw those words: the
// row was written, the push went out if they had allowed it, and there was
// nowhere on the site to read it back.
//
// The bell keeps being the glance — the newest few. This page is the record:
// everything, with the full message (the bell clamps it to two lines), the
// unread ones first so the new is never buried under the read, and one button
// that clears the badge.
//
// A row that carries a link opens it. Links are checked by notificationHref()
// before they are followed, so a row can only ever take you somewhere inside
// Genhub.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import {
  Bell,
  CheckCheck,
  ChevronRight,
  Inbox,
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import {
  formatNotificationAge,
  notificationHref,
  notificationTone,
  type NotificationTone,
} from "@/lib/notification-view";

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

/**
 * The tone of a row, in the one place that draws it.
 *
 * Icon and colours come from `notificationTone()`, which is tested separately:
 * an unknown type has to read as neutral, not borrow an alarm.
 */
const TONE_STYLES: Record<
  NotificationTone,
  { wrap: string; text: string; icon: typeof Info }
> = {
  success: {
    wrap: "bg-emerald-500/10 text-emerald-400",
    text: "text-emerald-400",
    icon: CheckCircle2,
  },
  warning: {
    wrap: "bg-amber-500/10 text-amber-400",
    text: "text-amber-400",
    icon: AlertTriangle,
  },
  error: {
    wrap: "bg-red-500/10 text-red-400",
    text: "text-red-400",
    icon: XCircle,
  },
  info: {
    wrap: "bg-brand-500/10 text-brand-400",
    text: "text-white/50",
    icon: Info,
  },
};

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const { theme } = useTheme();
  const isLight = theme === "light";

  const fetchNotifications = useCallback(async () => {
    try {
      // 200 is the API's ceiling: this page is the history, so it asks for all
      // of it rather than the bell's drop-down worth of rows.
      const res = await fetch("/api/notifications?limit=200");
      const data = await res.json();
      if (!data?.success) {
        router.push("/login");
        return;
      }
      setNotifications(data.data.notifications || []);
      setUnreadCount(data.data.unreadCount || 0);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  async function markAllRead() {
    if (marking) return;
    setMarking(true);
    try {
      const res = await fetch("/api/notifications", { method: "PATCH" });
      const data = await res.json();
      if (data?.success) {
        setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
        setUnreadCount(0);
      }
    } catch {
      // Nothing was marked; the badge stays and the button can be pressed again.
    } finally {
      setMarking(false);
    }
  }

  /**
   * Read one and, if it points somewhere, go there.
   *
   * Marking read does not wait for the network: it is the reader's intent, and
   * a slow request must not cost them the navigation. A failure only costs the
   * unread dot coming back, which is the harmless direction.
   */
  function open(n: NotificationRow) {
    if (!n.isRead) {
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      void fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }

    const href = notificationHref(n.link);
    if (href) router.push(href);
  }

  const unread = notifications.filter((n) => !n.isRead);
  const read = notifications.filter((n) => n.isRead);

  function renderRow(n: NotificationRow) {
    const tone = TONE_STYLES[notificationTone(n.type)];
    const Icon = tone.icon;
    const href = notificationHref(n.link);

    return (
      <button
        key={n.id}
        type="button"
        onClick={() => open(n)}
        title={href ? `Open ${href}` : undefined}
        className={cn(
          "w-full text-left rounded-2xl border p-4 flex items-start gap-3 transition",
          href ? "cursor-pointer" : "cursor-default",
          isLight
            ? cn(
                "border-gray-200 bg-white",
                href && "hover:border-brand-300 hover:bg-gray-50"
              )
            : cn(
                "border-white/10 bg-surface-400/60",
                href && "hover:border-brand-500/40 hover:bg-surface-400"
              )
        )}
      >
        <span
          className={cn(
            "w-9 h-9 rounded-xl flex items-center justify-center shrink-0",
            tone.wrap
          )}
        >
          <Icon className="w-5 h-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {/* The dot is the only mark of "new" once the row is on this page —
                the grouping above it says it too, but a row that has been read
                since the page loaded must lose the mark immediately. */}
            {!n.isRead && (
              <span className="w-2 h-2 rounded-full bg-brand-500 shrink-0" />
            )}
            <span
              className={cn(
                "text-sm font-semibold truncate",
                isLight ? "text-gray-900" : "text-white"
              )}
            >
              {n.title}
            </span>
          </span>
          {/* The whole message, not a clamped preview: this is the page someone
              opens to read the reason, and a reason cut off at two lines is the
              same as no reason. */}
          <span
            className={cn(
              "block text-sm mt-1 whitespace-pre-line",
              isLight ? "text-gray-600" : "text-white/60"
            )}
          >
            {n.message}
          </span>
          <span
            className={cn(
              "block text-[11px] mt-2",
              isLight ? "text-gray-400" : "text-white/30"
            )}
          >
            {formatNotificationAge(n.createdAt)}
            {href ? " • Tap to open" : ""}
          </span>
        </span>
        {href && (
          <ChevronRight
            className={cn(
              "w-4 h-4 shrink-0 mt-2.5",
              isLight ? "text-gray-300" : "text-white/20"
            )}
          />
        )}
      </button>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1
              className={cn(
                "text-2xl font-display font-bold flex items-center gap-3",
                isLight && "text-gray-900"
              )}
            >
              <Bell className="w-6 h-6 text-brand-400" />
              Notifications
              {unreadCount > 0 && (
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-brand-500 text-white">
                  {unreadCount} new
                </span>
              )}
            </h1>
            <p className={cn("text-sm mt-1", isLight ? "text-gray-500" : "text-white/50")}>
              Everything Genhub and its admins have told you about your account,
              your purchases and your withdrawals.
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              disabled={marking}
              className={cn(
                "btn-ghost flex items-center gap-2 shrink-0 text-sm",
                marking && "opacity-60"
              )}
            >
              <CheckCheck className="w-4 h-4" />
              Mark all read
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-24 rounded-2xl" />
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-20">
            <Inbox
              className={cn(
                "w-16 h-16 mx-auto mb-4",
                isLight ? "text-gray-300" : "text-white/10"
              )}
            />
            <h3
              className={cn(
                "text-lg font-medium mb-2",
                isLight ? "text-gray-500" : "text-white/60"
              )}
            >
              Nothing yet
            </h3>
            <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
              A purchase, a withdrawal or a message from an admin will appear
              here, and on the bell at the top of every page.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {unread.length > 0 && (
              <section>
                <h2
                  className={cn(
                    "text-[11px] font-semibold uppercase tracking-wider mb-2",
                    isLight ? "text-gray-500" : "text-white/40"
                  )}
                >
                  New
                </h2>
                <div className="space-y-3">{unread.map(renderRow)}</div>
              </section>
            )}
            {read.length > 0 && (
              <section>
                <h2
                  className={cn(
                    "text-[11px] font-semibold uppercase tracking-wider mb-2",
                    isLight ? "text-gray-500" : "text-white/40"
                  )}
                >
                  {unread.length > 0 ? "Earlier" : "All"}
                </h2>
                <div className="space-y-3">{read.map(renderRow)}</div>
              </section>
            )}
          </div>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
