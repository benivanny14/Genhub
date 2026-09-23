"use client";

import Link from "next/link";
import { Play, Home, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mb-6 glow-brand">
          <Play className="w-10 h-10 text-white fill-white" />
        </div>
        <h1 className="text-6xl font-display font-bold text-gradient mb-4">404</h1>
        <h2 className="text-xl font-display font-bold mb-2">Page Not Found</h2>
        <p className="text-white/50 mb-8">
          The page you are looking for does not exist or has been removed.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => window.history.back()}
            className="btn-ghost flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Go Back
          </button>
          <Link href="/" className="btn-brand flex items-center gap-2">
            <Home className="w-4 h-4" /> Home
          </Link>
        </div>
      </div>
    </div>
  );
}
