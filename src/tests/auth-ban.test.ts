// =============================================================================
// GENHUB - A session is not a permission slip
//
// Every write route in the app funnels through requireAuth or requireRole, which
// is why the ban check lives there rather than in thirty-one handlers. That also
// makes this file the place the rule is pinned: get it wrong here and every route
// is wrong at once.
//
// A real token is minted and verified (jose, the development secret) and the
// cookie jar is a single mutable value, so the only thing being stubbed is where
// the session came from.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  cookie: { token: null as string | null },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.cookie.token ? { name, value: mocks.cookie.token } : undefined,
    set: () => {},
  }),
}));

vi.mock("@/lib/db", () => ({
  default: { user: { findUnique: mocks.userFindUnique } },
}));

import { generateToken, requireAuth, requireRole } from "@/lib/auth";
import { resetAccountStatusCache } from "@/lib/services/account-status.service";

async function signInAs(userId: string, role: "VIEWER" | "CREATOR" | "ADMIN" = "VIEWER") {
  mocks.cookie.token = await generateToken({ userId, role });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountStatusCache();
  mocks.cookie.token = null;
  mocks.userFindUnique.mockResolvedValue({ isBanned: false });
});

describe("an ordinary session", () => {
  it("is allowed through", async () => {
    await signInAs("u1");
    await expect(requireAuth()).resolves.toMatchObject({ userId: "u1" });
  });

  it("still carries the role it was issued with", async () => {
    await signInAs("creator-1", "CREATOR");
    await expect(requireRole("CREATOR")).resolves.toMatchObject({ userId: "creator-1" });
  });
});

describe("a suspended account", () => {
  it("is refused by requireAuth, with 403 and not 401", async () => {
    // The distinction matters to the client: 401 means "sign in again", which
    // would send somebody to a login form that refuses them. 403 says the
    // session is fine and the account is not.
    await signInAs("u1");
    mocks.userFindUnique.mockResolvedValue({ isBanned: true });

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("is refused by requireRole as well", async () => {
    await signInAs("creator-1", "CREATOR");
    mocks.userFindUnique.mockResolvedValue({ isBanned: true });

    await expect(requireRole("CREATOR")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("is still allowed to erase its own account", async () => {
    // Deleting your data is not a moderation privilege. Refusing here would turn
    // a suspension into a reason somebody cannot be forgotten.
    await signInAs("u1");
    mocks.userFindUnique.mockResolvedValue({ isBanned: true });

    await expect(requireAuth({ allowBanned: true })).resolves.toMatchObject({
      userId: "u1",
    });
  });
});

describe("an erased account", () => {
  it("is refused at once, even though the token has not expired", async () => {
    await signInAs("u1");
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("no session", () => {
  it("is refused without asking the database anything", async () => {
    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });
});
