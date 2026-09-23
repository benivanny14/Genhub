"use client";

import { useState, useEffect } from "react";
import { Shield, AlertTriangle, X } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

export default function AgeVerification() {
  const [show, setShow] = useState(false);
  const [verified, setVerified] = useState(false);
  const { theme } = useTheme();
  const isLight = theme === "light";

  useEffect(() => {
    const ageVerified = localStorage.getItem("genhub-age-verified");
    if (ageVerified === "true") {
      setVerified(true);
    } else {
      setShow(true);
    }
  }, []);

  function handleVerify() {
    localStorage.setItem("genhub-age-verified", "true");
    setVerified(true);
    setShow(false);
  }

  function handleDeny() {
    window.location.href = "https://www.google.com";
  }

  if (verified || !show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className={cn(
        "w-full max-w-md rounded-2xl p-8 text-center animate-slide-up",
        isLight ? "bg-white shadow-2xl" : "bg-surface-400 border border-white/10"
      )}>
        {/* Warning Icon */}
        <div className="w-20 h-20 mx-auto rounded-full bg-amber-500/20 flex items-center justify-center mb-6">
          <AlertTriangle className="w-10 h-10 text-amber-400" />
        </div>

        <h2 className={cn(
          "text-2xl font-display font-bold mb-2",
          isLight ? "text-gray-900" : "text-white"
        )}>
          Age Verification Required
        </h2>

        <p className={cn(
          "text-sm mb-6",
          isLight ? "text-gray-500" : "text-white/60"
        )}>
          This platform contains premium content that may not be suitable for all audiences. You must be 18 years or older to access Genhub.
        </p>

        <div className={cn(
          "rounded-xl p-4 mb-6",
          isLight ? "bg-gray-50" : "bg-surface-300/40"
        )}>
          <p className={cn(
            "text-xs",
            isLight ? "text-gray-500" : "text-white/50"
          )}>
            By clicking &quot;I Am 18+&quot; you confirm that you are at least 18 years old and agree to our{' '}
            <a href="/terms" className="text-brand-400 hover:underline">Terms of Service</a> and{' '}
            <a href="/privacy" className="text-brand-400 hover:underline">Privacy Policy</a>.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={handleVerify}
            className="btn-brand w-full flex items-center justify-center gap-2"
          >
            <Shield className="w-5 h-5" />
            I Am 18+ — Enter Genhub
          </button>
          <button
            onClick={handleDeny}
            className={cn(
              "w-full py-3 rounded-xl text-sm font-medium transition",
              isLight
                ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                : "bg-surface-300/40 text-white/60 hover:text-white hover:bg-surface-300"
            )}
          >
            I Am Under 18 — Exit
          </button>
        </div>
      </div>
    </div>
  );
}
