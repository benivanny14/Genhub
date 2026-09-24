"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  /** Where the notification is about, e.g. `/admin`. Null for a plain notice. */
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const isLight = theme === "light";

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function fetchNotifications() {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications");
      const data = await res.json();
      if (data.success) {
        setNotifications(data.data.notifications || []);
        setUnreadCount(data.data.unreadCount || 0);
      }
    } catch {
      // Not logged in or API unavailable
    } finally {
      setLoading(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) fetchNotifications();
  }

  async function markAllRead() {
    try {
      await fetch("/api/notifications", { method: "PATCH" });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch {}
  }

  /**
   * Open a notification: mark this one read, then go where it points.
   *
   * The record already says what to do — every alert in this app is written with
   * the action in it ("Open /admin → Background jobs and press Run now") — and
   * until now the only way to act on that was to read the sentence and type the
   * path out by hand. A notification that names a problem and cannot take you to
   * it is a notification somebody closes.
   *
   * Marking read happens first and does not wait: it is the reader's intent, and
   * a slow network must not cost them the navigation. A failure there costs the
   * unread dot coming back, which is the harmless direction.
   */
  function openNotification(n: Notification) {
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

    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  }

  function formatTime(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={toggleOpen} className="btn-ghost relative" title="Notifications">
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center shadow-lg">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 w-80 max-w-[90vw] rounded-2xl shadow-2xl border animate-fade-in overflow-hidden z-50",
            isLight
              ? "bg-white border-gray-200"
              : "bg-surface-400 border-white/10"
          )}
        >
          <div
            className={cn(
              "flex items-center justify-between px-4 py-3 border-b",
              isLight ? "border-gray-100" : "border-white/5"
            )}
          >
            <h3 className={cn("font-display font-bold text-sm", isLight ? "text-gray-900" : "text-white")}>
              Notifications
            </h3>
            {notifications.length > 0 && (
              <button
                onClick={markAllRead}
                className={cn(
                  "flex items-center gap-1 text-xs hover:text-brand-400 transition",
                  isLight ? "text-gray-500" : "text-white/50"
                )}
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-4 space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="animate-pulse space-y-2">
                    <div className={cn("h-3 rounded w-3/4", isLight ? "bg-gray-100" : "bg-white/10")} />
                    <div className={cn("h-3 rounded w-1/2", isLight ? "bg-gray-100" : "bg-white/5")} />
                  </div>
                ))}
              </div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center">
                <Inbox className={cn("w-10 h-10 mx-auto mb-3", isLight ? "text-gray-300" : "text-white/20")} />
                <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
                  No notifications yet
                </p>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotification(n)}
                  title={n.link ? `Open ${n.link}` : undefined}
                  className={cn(
                    "w-full text-left px-4 py-3 border-b last:border-b-0 transition",
                    n.link ? "cursor-pointer hover:bg-brand-500/10" : "cursor-default",
                    isLight
                      ? `border-gray-50 ${n.isRead ? "bg-white" : "bg-brand-50/50"}`
                      : `border-white/5 ${n.isRead ? "bg-transparent" : "bg-brand-500/5"}`
                  )}
                >
                  <div className="flex items-start gap-2">
                    {!n.isRead && (
                      <span className="w-2 h-2 rounded-full bg-brand-500 mt-1.5 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium truncate", isLight ? "text-gray-800" : "text-white")}>
                        {n.title}
                      </p>
                      <p className={cn("text-xs line-clamp-2", isLight ? "text-gray-500" : "text-white/50")}>
                        {n.message}
                      </p>
                      <p className={cn("text-[10px] mt-1", isLight ? "text-gray-400" : "text-white/30")}>
                        {formatTime(n.createdAt)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
