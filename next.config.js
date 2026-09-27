// =============================================================================
// GENHUB - Next.js configuration
//
// The header block below is the whole of the platform's response hardening, and
// it is split by audience on purpose:
//
//   /:path*        every response, including the HTML pages middleware's matcher
//                  deliberately skips (static assets, images). The pages were
//                  getting four headers from middleware and nothing else.
//   /api/:path*    the same set; listed separately so the API's own framing rule
//                  is stated where an API reader looks for it.
//
// Added here: HSTS, Permissions-Policy, and a Content-Security-Policy. The CSP
// is the one worth explaining, because it is the only header that can break a
// working site:
//
//   * 'unsafe-inline' for scripts and styles. Next.js ships its hydration payload
//     as an inline <script>, and the app writes inline styles, so a strict
//     nonce-based policy needs that plumbing built first. This is still a real
//     gain: it names where code may be loaded FROM, so injected markup cannot
//     pull a script off somebody else's origin.
//   * 'unsafe-eval' in development only. React's dev build uses eval for
//     readable stack traces; production does not need it.
//   * https: for img/media/connect. Thumbnails, avatars and HLS all come back
//     through our own /api routes, but demo rows and side-loaded content can
//     point at an external host, and a policy that silently blanks those images
//     is worse than the narrow loosening.
//   * frame-ancestors 'none' overrides X-Frame-Options for browsers that read
//     the modern directive, and the older header stays for the rest.
//
// No HSTS `preload`: that is a submission to a browser-vendor list and belongs to
// whoever owns the domain, not to a config file.
// =============================================================================

const isDev = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

// `*.bunnycdn.com` was a wildcard over Bunny's WHOLE namespace, and that is a
// security problem, not a convenience: `storage.bunnycdn.com` matches it, and
// any Bunny customer can serve a file from a path under that host. Next 14's
// image optimiser decodes by content, so a free Bunny account was enough to
// point our optimiser at an AVIF it did not create — the critical libheif RCE
// (GHSA-2xp9-vwfh-vxw4). The deployed CDN hostname is knowable at build time, so
// the pattern is narrowed to it. The wildcard is kept only for a build that has
// no BUNNY_CDN_HOSTNAME configured, where removing it would break every legacy
// CDN cover instead of protecting anything.
const cdnHostname = process.env.BUNNY_CDN_HOSTNAME || "";
const bunnyImagePatterns = cdnHostname
  ? [{ protocol: "https", hostname: cdnHostname }]
  : [
      {
        protocol: "https",
        hostname: "*.bunnycdn.com",
      },
    ];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The framework banner told every visitor and every scanner which version of
  // Next is running, which is the first thing a version-based exploit needs.
  poweredByHeader: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "iframe.mediadelivery.net",
      },
      ...bunnyImagePatterns,
      {
        protocol: "https",
        hostname: "storage.freebuff.co.tz",
      },
      {
        protocol: "https",
        hostname: "storage.genhub.co.tz",
      },
      {
        protocol: "https",
        hostname: "picsum.photos",
      },
      {
        protocol: "https",
        hostname: "i.pravatar.cc",
      },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: securityHeaders,
    },
    {
      source: "/api/:path*",
      headers: securityHeaders,
    },
  ],
};

module.exports = nextConfig;
