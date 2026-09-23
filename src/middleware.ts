// =============================================================================
// GENHUB - Route Protection Middleware
// Protects creator, admin, and authenticated routes
// =============================================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
    // Match all paths except static files, images, and api routes (for performance)
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
