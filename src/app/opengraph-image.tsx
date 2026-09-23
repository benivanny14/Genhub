// =============================================================================
// GENHUB - Open Graph share image
// Served automatically at /opengraph-image (1200x630) and injected into
// og:image / twitter:image metadata for every page. Replaces the missing
// public/og-image.png that the root layout used to reference.
// =============================================================================

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Genhub — Premium Content Streaming";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #0b0b14 0%, #1b1035 55%, #2b1455 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 160,
            height: 160,
            borderRadius: 40,
            background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
            boxShadow: "0 20px 60px rgba(139,92,246,0.45)",
          }}
        >
          <svg width="84" height="84" viewBox="0 0 64 64">
            <path d="M24 16 L50 32 L24 48 Z" fill="#ffffff" />
          </svg>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 92,
            fontWeight: 700,
            marginTop: 44,
            letterSpacing: -2,
          }}
        >
          Genhub
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 34,
            marginTop: 18,
            color: "#c4b5fd",
          }}
        >
          Premium Content Streaming
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            marginTop: 40,
            color: "#9ca3af",
          }}
        >
          East Africa · Pay per view · 18+
        </div>
      </div>
    ),
    { ...size }
  );
}
