// =============================================================================
// GENHUB - JWT Authentication & Session Management
// Uses jose for edge-compatible JWT operations
// =============================================================================

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import config from "./config";

// JWT Payload type
export interface AuthPayload extends JWTPayload {
  userId: string;
  email?: string;
  phone?: string;
  role: "VIEWER" | "CREATOR" | "ADMIN";
}

// The development fallback is a PUBLIC constant, not a real secret. If it ever
// signs a production token, anyone who reads this file can mint an ADMIN session
// — and jose would verify it happily, so nothing would look wrong. Missing
// config must therefore fail closed at the point tokens are minted or checked,
// rather than silently inheriting a secret the whole internet knows.
//
// Deliberately NOT thrown at module load: a misconfigured deploy should still
// serve public pages and /api/health, which is how you find out what is wrong.
// Only auth stops — which is exactly the part that would be forgeable.
function jwtSecret(): Uint8Array {
  const secret = config.jwtSecret;
  const isPlaceholder = !secret || secret === "dev-secret-change-in-production";

  if (isPlaceholder && config.nodeEnv === "production") {
    throw new Error(
      "JWT_SECRET is unset or still the development default. Refusing to sign or " +
        "verify tokens with a publicly known secret. Generate one with " +
        "`openssl rand -hex 32` and set it in the environment."
    );
  }

  return new TextEncoder().encode(secret);
}

// Token generation
export async function generateToken(payload: Omit<AuthPayload, "iat" | "exp" | "iss">): Promise<string> {
  const secret = jwtSecret();

  return new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("genhub")
    .setAudience("genhub-app")
    .setExpirationTime(config.jwtExpiresIn)
    .sign(secret);
}

// Token verification
export async function verifyToken(token: string): Promise<AuthPayload | null> {
  // Resolved outside the try: a misconfiguration must surface as an error, not
  // be swallowed into "this token is invalid" while we quietly trust a
  // well-known secret.
  const secret = jwtSecret();

  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "genhub",
      audience: "genhub-app",
    });
    return payload as AuthPayload;
  } catch {
    return null;
  }
}

// Set auth cookie
export async function setAuthCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(config.cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });
}

// Remove auth cookie
export async function removeAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(config.cookieName, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

// Get current user from request (for API routes)
export async function getCurrentUser(): Promise<AuthPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(config.cookieName)?.value;
  if (!token) return null;
  return verifyToken(token);
}

// Require authenticated user - throws if not
export async function requireAuth(): Promise<AuthPayload> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError("Authentication required", 401);
  }
  return user;
}

// Require specific role
export async function requireRole(role: "VIEWER" | "CREATOR" | "ADMIN"): Promise<AuthPayload> {
  const user = await requireAuth();
  if (user.role !== role && user.role !== "ADMIN") {
    throw new AuthError("Insufficient permissions", 403);
  }
  return user;
}

// Custom error class for auth errors
export class AuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}
