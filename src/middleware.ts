// =============================================================================
// GENHUB - Route Protection Middleware
// Protects creator, admin, and authenticated routes
// =============================================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRequestOrigin } from "@/lib/request-origin";

// Routes that require authentication
const protectedRoutes = [
  "/wallet",
  "/favorites",
  "/profile",
  "/admin",
  "/feed",
  "/inbox",
];

// Creator dashboard pages are private — but /creator/[id] is a PUBLIC profile
const creatorDashboardRoutes = ["/creator", "/creator/analytics", "/creator/kyc", "/creator/upload"];

// Routes only for unauthenticated users
const publicOnlyRoutes = ["/login", "/register"];

// Public marketing pages that must never be treated as dashboard routes
const openRoutes = ["/become-creator", "/creators", "/browse", "/about", "/faq", "/support"];

/**
 * Methods that change something, and therefore have to be asked where they came
 * from.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The API paths this middleware watches.
 *
 * Deliberately only the credential routes. The rest of /api is protected by the
 * session cookie's `sameSite: "lax"`, and running an edge invocation on every
 * API request would put this in front of the video-segment proxy, where a
 * manifest has hundreds of children and a per-request check is a real cost for
 * no gain. These five are the endpoints a cross-site form can drive without
 * anybody's session at all.
 */
const WATCHED_API_PREFIXES = ["/api/auth/"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- CSRF: refuse a state-changing request from somebody else's page --------
  //
  // `Origin` is attached by the browser to cross-origin writes and cannot be
  // forged by the page, which is what makes this check worth having. A missing
  // header is a non-browser caller (curl, cron, the payment gateway) and is left
  // alone — see lib/request-origin.ts.
  if (
    MUTATING_METHODS.has(request.method) &&
    WATCHED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    const verdict = checkRequestOrigin({
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      allowedHosts: [
        process.env.NEXT_PUBLIC_APP_URL,
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL,
      ],
    });

    if (!verdict.ok) {
      return NextResponse.json(
        { success: false, error: "This request must come from the Genhub site", code: "CROSS_ORIGIN" },
        { status: 403 }
      );
    }
  }

  // Get token from cookie (kept in sync with config.cookieName)
  const cookieName = process.env.COOKIE_NAME || "genhub_token";
  const token = request.cookies.get(cookieName)?.value;
  const isAuthenticated = !!token;

  // Security headers
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Exact segment match so /creators is NOT caught by /creator
  const matches = (route: string) => pathname === route || pathname.startsWith(route + "/");

  // Open pages short-circuit: never redirect, just pass through
  if (openRoutes.some(matches)) {
    return response;
  }

  // Protect authenticated routes
  if (protectedRoutes.some(matches) || creatorDashboardRoutes.includes(pathname)) {
    if (!isAuthenticated) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Redirect authenticated users away from login/register
  if (publicOnlyRoutes.some(matches)) {
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Match all paths except static files, images, and api routes (for
    // performance), plus the credential routes — see WATCHED_API_PREFIXES for
    // why exactly those are the exception.
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    "/api/auth/:path*",
  ],
};
