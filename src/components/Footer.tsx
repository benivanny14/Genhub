"use client";

import Link from "next/link";
import { Play } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { cn, toTelHref } from "@/lib/utils";
import config from "@/lib/config";

export default function Footer() {
  const { theme } = useTheme();
  const isLight = theme === "light";

  return (
    <footer className={cn(
      "border-t py-12 px-4",
      isLight ? "bg-white border-gray-200" : "bg-surface-600/30 border-white/5"
    )}>
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center glow-brand">
                <Play className="w-4 h-4 text-white fill-white" />
              </div>
              <span className="text-xl font-display font-bold text-gradient">Genhub</span>
            </div>
            <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/40")}>
              Premium video streaming platform for East African creators. Upload, monetize, and enjoy exclusive content.
            </p>
          </div>

          {/* Platform */}
          <div>
            <h3 className={cn("font-display font-bold text-sm mb-3", isLight ? "text-gray-900" : "text-white")}>Platform</h3>
            <ul className="space-y-2">
              <li><Link href="/" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Home</Link></li>
              <li><Link href="/trending" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Trending</Link></li>
              <li><Link href="/top-rated" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Top Rated</Link></li>
              <li><Link href="/most-viewed" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Most Viewed</Link></li>
              <li><Link href="/playlists" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Playlists</Link></li>
              <li><Link href="/billing" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Billing</Link></li>
              <li><Link href="/payments" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>My Payments</Link></li>
              <li><Link href="/creators" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Creators A–Z</Link></li>
              <li><Link href="/about" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>About Us</Link></li>
              <li><Link href="/become-creator" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Become a Creator</Link></li>
              <li><Link href="/login" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Sign In</Link></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className={cn("font-display font-bold text-sm mb-3", isLight ? "text-gray-900" : "text-white")}>Legal</h3>
            <ul className="space-y-2">
              <li><Link href="/terms" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Terms of Service</Link></li>
              <li><Link href="/privacy" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Privacy Policy</Link></li>
              <li><Link href="/dmca" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>DMCA Policy</Link></li>
              <li><Link href="/2257" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>18 U.S.C. § 2257</Link></li>
              <li><Link href="/faq" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>FAQ</Link></li>
              <li><Link href="/forgot-password" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Reset Password</Link></li>
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className={cn("font-display font-bold text-sm mb-3", isLight ? "text-gray-900" : "text-white")}>Support</h3>
            <ul className="space-y-2">
              <li><Link href="/support" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Help &amp; Support</Link></li>
              <li><Link href="/support" className={cn("text-sm hover:text-brand-400 transition", isLight ? "text-gray-500" : "text-white/40")}>Open a Ticket</Link></li>
              <li><span className={cn("text-sm", isLight ? "text-gray-500" : "text-white/40")}>Email: {config.compliance.supportEmail}</span></li>
              <li>
                <span className={cn("text-sm", isLight ? "text-gray-500" : "text-white/40")}>
                  Phone:{" "}
                  <a
                    href={toTelHref(config.compliance.phone)}
                    className="hover:text-brand-400 transition"
                  >
                    {config.compliance.phone}
                  </a>
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div className={cn("border-t pt-6 flex flex-col sm:flex-row justify-between items-center gap-4", isLight ? "border-gray-200" : "border-white/5")}>
          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/30")}>
            © 2026 Genhub. All rights reserved. 18+ Only.
          </p>
          <div className="flex items-center gap-4">
            <Link href="/terms" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>Terms</Link>
            <Link href="/privacy" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>Privacy</Link>
            <Link href="/dmca" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>DMCA</Link>
            <Link href="/2257" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>2257</Link>
            <Link href="/faq" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>FAQ</Link>
            <Link href="/support" className={cn("text-xs hover:text-brand-400 transition", isLight ? "text-gray-400" : "text-white/30")}>Support</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
