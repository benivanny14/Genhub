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
  "frame-src https://streamtape.com https://*.streamtape.com https://*.tapecontent.net",
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

// `picsum.photos` and `i.pravatar.cc` exist for the DEMO fallbacks in
// lib/demo-data.ts, which are dead code in a production build (`demoDataEnabled()`
// is `NODE_ENV !== "production"`, inlined to `false` there). Every host on this
// list is a host a client-supplied `next/image` src can be pointed at and have
// our server fetch, so a host nothing in production references is a proxy this
// deployment does not need. Outside a production build they stay, because the
// demo screens are the reason they are here.
const demoImagePatterns =
  process.env.NODE_ENV === "production"
    ? []
    : [
        { protocol: "https", hostname: "picsum.photos" },
        { protocol: "https", hostname: "i.pravatar.cc" },
      ];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The framework banner told every visitor and every scanner which version of
  // Next is running, which is the first thing a version-based exploit needs.
  poweredByHeader: false,
  // Stated rather than assumed. The default is already `false`, but a build flag
  // or a well-meaning "make debugging easier" commit is one line from shipping
  // the entire source of the app — route logic, comments and all — to every
  // visitor as `.map` files next to the bundles. A silent default is not a
  // control, so the value is pinned here and asserted by a test.
  productionBrowserSourceMaps: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "iframe.mediadelivery.net",
      },
      {
        protocol: "https",
        hostname: "storage.freebuff.co.tz",
      },
      {
        protocol: "https",
        hostname: "storage.genhub.co.tz",
      },
      ...demoImagePatterns,
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // The admin readiness card reports pending Prisma migrations by reading
  // prisma/migrations and comparing it with `_prisma_migrations`. A serverless
  // bundle only traces files that are referenced, and `fs.readdirSync` is
  // invisible to that analysis — so without this the folder is absent in
  // production, the check reports "cannot tell", and the one number that would
  // have made a failed deploy obvious is the one that goes missing exactly
  // where it matters. The SQL files are a few KB.
  outputFileTracingIncludes: {
    "/api/admin/live-probes": ["./prisma/migrations/**/*"],
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
