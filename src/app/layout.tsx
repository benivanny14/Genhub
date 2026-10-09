import type { Metadata, Viewport } from "next";
import { Inter, Poppins } from "next/font/google";
import "./globals.css";
import ClientProviders from "@/components/ClientProviders";
import BackgroundVideo from "@/components/BackgroundVideo";
import SiteBanner from "@/components/SiteBanner";
import config from "@/lib/config";
import { serializeJsonLd } from "@/lib/json-ld";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

export const metadata: Metadata = {
  // Resolve relative OG/twitter image URLs against the real domain
  // (without this, Next falls back to http://localhost:0 in production).
  metadataBase: new URL(config.appUrl),
  title: {
    default: "Genhub - Premium Content Streaming",
    template: "%s | Genhub",
  },
  description:
    "Genhub - Premium video streaming platform for East African creators. Upload, monetize, and enjoy exclusive content. Pay with M-Pesa, Tigo Pesa, or Airtel Money.",
  keywords: [
    "video streaming",
    "pay per view",
    "premium content",
    "M-Pesa",
    "Tanzania",
    "content creators",
    "video monetization",
    "East Africa",
    "subscription",
  ],
  authors: [{ name: "Genhub" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Genhub",
    title: "Genhub - Premium Content Streaming",
    description: "Premium video streaming platform for East African creators",
    // og:image comes from src/app/opengraph-image.tsx (auto-generated,
    // resolves against metadataBase) — no static file to go missing.
  },
  twitter: {
    card: "summary_large_image",
    title: "Genhub - Premium Content Streaming",
    description: "Premium video streaming platform for East African creators",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#050506",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Genhub",
              // The domain that is ACTUALLY serving this page, not a domain we
              // hope to move to. This used to be the literal genhub.co.tz, while
              // `metadataBase` below and every canonical tag were built from
              // `config.appUrl` — so the page told Google its identity was one
              // domain and its canonical location was another, and the one it
              // claimed as its identity did not resolve at all. Structured data
              // that is wrong is worse than absent: it is an assertion about a
              // site that does not exist. One source of truth fixes it, and it
              // follows the domain automatically when the real one goes live.
              url: config.appUrl,
              description:
                "Premium video streaming platform for East African creators",
              potentialAction: {
                "@type": "SearchAction",
                target: `${config.appUrl}/?q={search_term_string}`,
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
      </head>
      <body
        className={`${inter.variable} ${poppins.variable} font-sans min-h-screen transition-colors duration-300`}
      >
        {/*
          The colour the glass frosts.

          A fixed layer of slow colour fields behind every page, painted by the
          root stacking context at z-index -10 so it sits above the page colour
          and below all content. <body> is transparent for exactly this reason
          (see globals.css) — an opaque body background would bury it and every
          pane on the site would frost a flat black rectangle.

          Without this the frosted panels have nothing to be frosted over, which
          is what made the old translucent cards read as grey boxes.
        */}
        {/* The operator's backdrop, if there is one: one layer DEEPER than the
            aurora, so it is only ever seen through it. Renders nothing at all
            when no clip is set, when the browser asked for reduced motion, or
            when it is on Save-Data — see components/BackgroundVideo. */}
        <BackgroundVideo />
        <div aria-hidden className="gh-aurora" />
        <div aria-hidden className="gh-grid" />
        <div aria-hidden className="gh-vignette" />
        <ClientProviders>
          {/* The operator's announcement, above every page. Publishes without a
              deploy — see /api/site/status and the admin Overview card. */}
          <SiteBanner />
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
