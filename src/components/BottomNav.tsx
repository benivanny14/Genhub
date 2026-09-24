"use client";

import { useEffect, useState } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, Heart, Upload, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";

interface BottomNavProps {
  userRole?: string;
}

export default function BottomNav({ userRole }: BottomNavProps) {
  const pathname = usePathname();
  const { theme } = useTheme();
  const isLight = theme === "light";

  // Most pages (billing, playlists, legal) don't know the session, and passing
  // nothing used to render a "Sign In" tab for users who were already signed
  // in. Only the pages that already resolved the user may override our own
  // lookup, so we never fetch twice on the home page.
  const [role, setRole] = useState<string | undefined>(userRole);

  useEffect(() => {
    if (userRole !== undefined) {
      setRole(userRole);
      return;
    }

    let cancelled = false;
    fetchCurrentUser()
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setRole(data?.success ? data.data.role : undefined);
      })
      .catch(() => {
        if (!cancelled) setRole(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [userRole]);

  const navItems = [
    { href: "/", icon: Home, label: "Home" },
    { href: "/favorites", icon: Heart, label: "Saved" },
    ...(role === "CREATOR" ? [{ href: "/creator/upload", icon: Upload, label: "Upload" }] : []),
    { href: role ? "/profile" : "/login", icon: User, label: role ? "Profile" : "Sign In" },
  ];

  return (
    <nav className={cn(
      "md:hidden fixed bottom-0 left-0 right-0 z-50 border-t safe-bottom",
      isLight
        ? "bg-white/95 border-gray-200/60"
        : "bg-surface-500/95 border-white/5"
    )}>
      <div className="flex items-center justify-around px-2 py-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all duration-200",
                isActive
                  ? "text-brand-500"
                  : isLight ? "text-gray-400 hover:text-gray-600" : "text-white/40 hover:text-white/70"
              )}
            >
              <item.icon className={cn("w-5 h-5", isActive && "scale-110")} />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
