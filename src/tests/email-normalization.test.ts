// =============================================================================
// GENHUB - One form of an email address
//
// `User.email` is `@unique` on PostgreSQL, which is case-SENSITIVE. Nothing
// normalised the value, so:
//
//   * `User@Example.com` and `user@example.com` were two accounts for one
//     person — the second sign-up passed the "already in use" check because the
//     unique index saw two different strings — and
//   * the person who typed a capital letter at sign-up was told "Incorrect
//     sign-in details" later for the same address in lowercase, and the reset
//     link was never sent ("if that account exists…" while sending nothing).
//
// What is pinned here:
//   1. The sign-up schema stores the address lowercase, so new rows are one
//      canonical form.
//   2. Sign-in and password reset LOOK UP case-insensitively, because rows
//      created before the rule still hold their original capitals. Fixing only
//      the write would have left every existing account failing to sign in.
//
// Prisma is mocked; the schemas and the route logic are real.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  sendResetLink: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate } },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: 0 })),
  cacheDel: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => ({
  generateToken: vi.fn(async () => "test-token"),
  setAuthCookie: vi.fn(async () => {}),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/services/password-reset.service", () => ({
  sendPasswordResetLink: (...args: unknown[]) => mocks.sendResetLink(...args),
}));

import { normalizeEmail, emailMatch, registerSchema, loginSchema } from "@/lib/validation";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";

/** The `where` clause handed to prisma's findFirst on the first call. */
function whereClause() {
  return mocks.userFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.userUpdate.mockResolvedValue({});
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  User@Example.COM \n")).toBe("user@example.com");
  });

  it("leaves an already-normalised address alone", () => {
    expect(normalizeEmail("a@b.co")).toBe("a@b.co");
  });
});

describe("emailMatch", () => {
  it("builds a case-insensitive filter for the normalised address", () => {
    expect(emailMatch(" User@Example.com ")).toEqual({
      email: { equals: "user@example.com", mode: "insensitive" },
    });
  });
});

describe("the sign-up schema", () => {
  it("stores the address lowercase, so one person cannot hold two accounts", () => {
    const parsed = registerSchema.safeParse({
      displayName: "Ivanny",
      username: "ivanny",
      email: "  Ivanny@Example.COM ",
      password: "password123",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("ivanny@example.com");
  });
});

describe("the sign-in schema", () => {
  it("normalises the address before it is looked up", () => {
    const parsed = loginSchema.safeParse({
      email: "Ivanny@Example.COM",
      password: "password123",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("ivanny@example.com");
  });
});

describe("POST /api/auth/login", () => {
  it("finds the account whatever case it was stored in", async () => {
    const hash = await bcrypt.hash("password123", 4);
    mocks.userFindFirst.mockResolvedValue({
      id: "u1",
      email: "Ivanny@Example.com",
      phone: null,
      role: "VIEWER",
      isBanned: false,
      passwordHash: hash,
    });

    const response = await login(
      new NextRequest("https://app.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "ivanny@example.com", password: "password123" }),
      })
    );

    expect(response.status).toBe(200);
    expect(whereClause().where).toEqual({
      OR: [{ email: { equals: "ivanny@example.com", mode: "insensitive" } }],
    });
  });

  it("still accepts a phone number sign-in for accounts that predate email", async () => {
    await login(
      new NextRequest("https://app.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ phone: "0712345678", password: "password123" }),
      })
    );

    expect(whereClause().where).toEqual({ OR: [{ phone: "0712345678" }] });
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("matches the address case-insensitively before deciding to send", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u1" });

    const response = await forgotPassword(
      new NextRequest("https://app.test/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "Ivanny@Example.COM" }),
      })
    );

    expect(response.status).toBe(200);
    expect(whereClause().where).toEqual({
      email: { equals: "ivanny@example.com", mode: "insensitive" },
    });
    // The account was found, so the link is actually issued — this is the half
    // that used to fail silently for a row stored with capitals.
    expect(mocks.sendResetLink).toHaveBeenCalledWith("u1");
  });

  it("answers identically for an address that has no account", async () => {
    mocks.userFindFirst.mockResolvedValue(null);

    const response = await forgotPassword(
      new NextRequest("https://app.test/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "nobody@example.com" }),
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.sendResetLink).not.toHaveBeenCalled();
  });
});
