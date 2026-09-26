"use client";

import { Play, ShieldCheck, Sparkles, Zap } from "lucide-react";

/**
 * The brand half of the sign-in / sign-up split screen.
 *
 * A full-bleed aurora panel carrying the logo orb, a headline and a short list
 * of reasons to trust the platform. It is purely decorative, so it is hidden
 * below `lg` where the form is the whole job — and it holds no focusable
 * content, so a keyboard user never has to tab past it to reach the fields.
 */
export default function AuthBrandPanel({
  eyebrow,
  headline,
  sub,
  points,
}: {
  eyebrow: string;
  headline: string;
  sub: string;
  points: string[];
}) {
  const icons = [Sparkles, ShieldCheck, Zap];

  return (
    <aside className="auth-aurora relative hidden overflow-hidden p-10 text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between xl:w-1/2 xl:p-14">
      {/* Soft vignette so text stays readable over the moving colour */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

      {/* Logo */}
      <div className="relative flex items-center gap-3">
        <div className="auth-float relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 glow-brand">
          <Play className="h-6 w-6 fill-white text-white" />
        </div>
        <span className="font-display text-xl font-bold tracking-tight">Genhub</span>
      </div>

      {/* Headline */}
      <div className="relative max-w-md">
        <div className="relative mb-7 h-20 w-20">
          {/* Rotating conic ring behind the orb */}
          <div
            className="auth-orbit absolute inset-0 rounded-full opacity-70"
            style={{
              background:
                "conic-gradient(from 0deg, transparent, rgba(139,92,246,0.9), transparent 60%)",
              mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0)",
              WebkitMask:
                "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0)",
            }}
          />
          <div className="auth-float absolute inset-0 flex items-center justify-center rounded-full bg-black/40 backdrop-blur">
            <Play className="h-8 w-8 fill-white text-white" />
          </div>
        </div>

        <p className="mb-3 text-xs font-bold uppercase tracking-[0.25em] text-brand-300">
          {eyebrow}
        </p>
        <h2 className="font-display text-3xl font-bold leading-tight xl:text-4xl">
          {headline}
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-white/60 xl:text-base">{sub}</p>
      </div>

      {/* Reassurance points */}
      <ul className="relative space-y-3">
        {points.map((point, i) => {
          const Icon = icons[i % icons.length];
          return (
            <li key={point} className="flex items-start gap-3 text-sm text-white/70">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
                <Icon className="h-3.5 w-3.5 text-brand-300" />
              </span>
              {point}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
