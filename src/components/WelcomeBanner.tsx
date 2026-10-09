"use client";

import { Sparkles } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

/**
 * The welcome line carried by both the sign-in and sign-up screens.
 *
 * It is the first thing a visitor reads on either page, so it is set as a hero
 * rather than body copy: a gradient headline, bold and large on every breakpoint,
 * sitting inside a soft brand panel. Kept in one component so the two pages can
 * never drift apart.
 */
export default function WelcomeBanner() {
  const { theme } = useTheme();
  const isLight = theme === "light";

  return (
    <div className="mx-auto max-w-5xl px-4 pt-8 sm:pt-10">
      <div className="glass-panel auth-rise relative overflow-hidden px-5 py-8 text-center sm:px-8 sm:py-10">
        {/* Soft radial bloom behind the headline */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.22),transparent_65%)]" />

        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.3em] text-brand-400">
            <Sparkles className="h-3.5 w-3.5" />
            Genhub
          </span>

          <h2 className="mt-5 font-display text-[2rem] font-black uppercase leading-[1.05] tracking-tight sm:text-4xl lg:text-5xl">
            <span className="text-gradient drop-shadow-[0_0_28px_rgba(139,92,246,0.35)]">
              Welcome to Genhub
            </span>
            <span
              className={cn(
                "mt-2 block text-lg font-extrabold uppercase sm:text-2xl lg:text-3xl",
                isLight ? "text-gray-700" : "text-white/85"
              )}
            >
              and start making and earning money
            </span>
            <span className="mt-3 block text-2xl font-black uppercase sm:text-3xl lg:text-4xl">
              <span className={cn("align-middle", isLight ? "text-gray-500" : "text-white/60")}>
                with
              </span>{" "}
              {/* The payoff gets its own look so it separates from the rest:
                  a solid gradient chip that reads as a badge, not body copy. */}
              <span className="glow-brand inline-block rounded-2xl bg-gradient-to-r from-brand-400 via-fuchsia-500 to-brand-600 px-4 py-1.5 align-middle text-white shadow-lg shadow-brand-500/40 ring-1 ring-white/20">
                it&apos;s me again
              </span>
            </span>
          </h2>
        </div>
      </div>
    </div>
  );
}
