// =============================================================================
// GENHUB - Is this account still allowed to act?
//
// Before this service existed a ban only stopped the NEXT sign-in, so a banned
// account kept buying, tipping, requesting payouts and posting for the rest of its
// seven-day token. The check itself is one lookup; what is pinned here is how it
// behaves when it cannot get an answer, because both wrong directions are real
// failures:
//
//   * caching "allowed" forever  -> the ban is decorative
//   * failing closed on an outage -> every user is locked out of a working site
//
// So: a missing row is enforced at once (the account was erased and the token is
// a credential for nobody), while a database error reads as allowed and is NOT
// cached, so the next request asks again.
//
// Prisma and the clock are mocked: no database, no waiting.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { user: { findUnique: mocks.userFindUnique } },
}));

import {
  accountStatusFor,
  invalidateAccountStatus,
  resetAccountStatusCache,
  ACCOUNT_STATUS_TTL_MS,
} from "@/lib/services/account-status.service";

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountStatusCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
  mocks.userFindUnique.mockResolvedValue({ isBanned: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the verdict", () => {
  it("reads an ordinary account as allowed", async () => {
    await expect(accountStatusFor("u1")).resolves.toEqual({
      exists: true,
      banned: false,
    });
  });

  it("reads a banned account as banned", async () => {
    mocks.userFindUnique.mockResolvedValue({ isBanned: true });

    await expect(accountStatusFor("u1")).resolves.toEqual({
      exists: true,
      banned: true,
    });
  });

  it("says the account is gone when the row is gone", async () => {
    // The erasure flow deletes the row; the token outlives it. Nothing may treat
    // a deleted user as a live session for the rest of the token's seven days.
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(accountStatusFor("u1")).resolves.toEqual({
      exists: false,
      banned: false,
    });
  });
});

describe("the cache", () => {
  it("asks the database once for a burst of requests", async () => {
    await accountStatusFor("u1");
    await accountStatusFor("u1");
    await accountStatusFor("u1");

    expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
  });

  it("asks again once the window has passed", async () => {
    await accountStatusFor("u1");
    vi.setSystemTime(new Date(Date.now() + ACCOUNT_STATUS_TTL_MS + 1));
    await accountStatusFor("u1");

    expect(mocks.userFindUnique).toHaveBeenCalledTimes(2);
  });

  it("re-reads immediately when an admin action drops the verdict", async () => {
    // The case the stale minute would look like a broken check: an admin bans
    // somebody and then watches them.
    await accountStatusFor("u1");
    invalidateAccountStatus("u1");
    await accountStatusFor("u1");

    expect(mocks.userFindUnique).toHaveBeenCalledTimes(2);
  });

  it("keeps users apart", async () => {
    await accountStatusFor("u1");
    await accountStatusFor("u2");

    expect(mocks.userFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("when the database cannot answer", () => {
  it("allows the request, because an outage is not a ban", async () => {
    mocks.userFindUnique.mockRejectedValue(new Error("connection refused"));

    await expect(accountStatusFor("u1")).resolves.toEqual({
      exists: true,
      banned: false,
    });
  });

  it("does not remember that answer", async () => {
    // Caching a failure would hold the door open for the whole window after the
    // database came back, which is how an unrelated outage turns into a ban.
    mocks.userFindUnique.mockRejectedValueOnce(new Error("connection refused"));
    await accountStatusFor("u1");

    mocks.userFindUnique.mockResolvedValue({ isBanned: true });
    await expect(accountStatusFor("u1")).resolves.toEqual({
      exists: true,
      banned: true,
    });
  });
});
