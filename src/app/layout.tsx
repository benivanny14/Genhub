import type { Metadata, Viewport } from "next";
import { Inter, Poppins } from "next/font/google";
import "./globals.css";
import ClientProviders from "@/components/ClientProviders";
import config from "@/lib/config";

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
            __html: JSON.stringify({
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
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
