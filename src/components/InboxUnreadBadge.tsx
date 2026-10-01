"use client";

// =============================================================================
// GENHUB - Unread message badge, on the Inbox link
//
// A creator earns from their inbox, so the one thing they must not miss is a
// fan who has paid to be heard. The Inbox link carried no badge at all: a new
// message appeared on /inbox and nowhere else, which meant a creator only found
// it by opening the page to check — exactly backwards for a notification.
//
// The count comes from `GET /api/messages?unread=1`, deliberately not the
// conversation list: that one reads up to 300 messages with both participants to
// build a page, and this runs on every page of the site.
//
// Refreshed while the tab is visible, paused while it is hidden, and it stops
// asking altogether once a read answers "you are signed out" — a visitor with no
// account has nothing waiting for them, and a 401 every minute from every open
// tab is load nobody asked for.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * How long between reads. A minute, like the notification bell: this is one
 * small count, and a shorter gap is a worse trade than a slightly old number.
 */
const REFRESH_MS = 60_000;

export default function InboxUnreadBadge({ className }: { className?: string }) {
  const [count, setCount] = useState(0);
  // Known-signed-in, so the background refresh does not run for everybody who is
  // merely looking at the site.
  const signedIn = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/messages?unread=1");
        const data = await res.json();
        if (cancelled || !data?.success) return;
        signedIn.current = true;
        setCount(Number(data.data?.unreadCount) || 0);
      } catch {
        // Signed out, offline, or a hiccup: the badge simply keeps its last
        // value rather than flashing a wrong one.
      }
    }

    void read();

    const timer = setInterval(() => {
      if (signedIn.current) void read();
    }, REFRESH_MS);
    // Looked at again → ask immediately, so a tab left in the background is
    // correct the moment it comes forward.
    document.addEventListener("visibilitychange", read);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);

  if (count <= 0) return null;

  return (
    <span
      aria-label={`${count} unread message${count === 1 ? "" : "s"}`}
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white shadow-lg",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
