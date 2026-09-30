// =============================================================================
// GENHUB - PATCH /api/profile
//
// The name and the language used to be copied out of the request body
// unexamined, and both are read back on every device:
//
//   * a number or an object in `displayName` reached a String column, which
//     Prisma refuses — the profile form answered 500 for a field the person can
//     see and fix — and any length at all was stored and then rendered in the
//     header, on cards and inside the page's JSON-LD;
//   * `locale` was stored as whatever string arrived, so a typo ("swh", "EN")
//     left that account permanently on the fallback language with nothing on
//     screen to explain why the language switch did nothing.
//
// Prisma and the session are mocked; the route logic is real. A validation
// refusal is 422 (api.validation), the status every other schema error uses.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  userUpdate: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { user: { update: mocks.userUpdate, findUnique: mocks.userFindUnique } },
}));

vi.mock("@/lib/redis", () => ({
  cacheDel: vi.fn(async () => {}),
  checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0, degraded: false }),
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ userId: "u1", role: "VIEWER" }),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

import { PATCH } from "@/app/api/profile/route";

function patch(payload: Record<string, unknown>) {
  return PATCH(
    new NextRequest("https://app.test/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

/** The `data` handed to prisma's user.update. */
function updateData() {
  return (mocks.userUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userUpdate.mockResolvedValue({
    id: "u1",
    displayName: "Ivanny",
    locale: "sw",
    avatarUrl: null,
    earningsDigestEnabled: true,
  });
});

describe("PATCH /api/profile", () => {
  it("refuses a name that is not text instead of failing at the database", async () => {
    const response = await patch({ displayName: 12 as unknown as string });

    expect(response.status).toBe(422);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name that is too long to render", async () => {
    const response = await patch({ displayName: "x".repeat(51) });

    expect(response.status).toBe(422);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("trims an acceptable name before storing it", async () => {
    const response = await patch({ displayName: "  Ivanny  " });

    expect(response.status).toBe(200);
    expect(updateData().displayName).toBe("Ivanny");
  });

  it("still lets the form clear the name", async () => {
    await patch({ displayName: "" });

    expect(updateData().displayName).toBeNull();
  });

  it("accepts only the languages the interface ships", async () => {
    const response = await patch({ locale: "fr" });

    expect(response.status).toBe(422);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("accepts sw and en", async () => {
    await patch({ locale: "sw" });
    expect(updateData().locale).toBe("sw");

    mocks.userUpdate.mockClear();
    await patch({ locale: "en" });
    expect(updateData().locale).toBe("en");
  });

  it("still refuses an empty update", async () => {
    const response = await patch({});

    expect(response.status).toBe(422);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The name is the username
//
// Saving a name also claims the @handle folded from it, so the public name and
// the username cannot drift apart. A handle somebody else already holds is
// NUMBERED (the name is the person's own; they are not asked to pick another),
// and a name that folds to something the rules refuse (`Admin`) leaves the
// existing handle alone rather than refusing the name.
// -----------------------------------------------------------------------------

describe("PATCH /api/profile — the handle follows the name", () => {
  /** `prisma.user.findUnique` answers both questions in this route. */
  function account(handle: string | null, taken: string[] = []) {
    mocks.userFindUnique.mockImplementation(
      (args: { where: { id?: string; username?: string } }) => {
        if (args.where.id) return Promise.resolve({ username: handle });
        return Promise.resolve(
          taken.includes(args.where.username as string) ? { id: "someone" } : null
        );
      }
    );
  }

  it("claims the handle made from the new name", async () => {
    account("kayena");

    const response = await patch({ displayName: "Kayena Mushi" });

    expect(response.status).toBe(200);
    expect(updateData().displayName).toBe("Kayena Mushi");
    expect(updateData().username).toBe("kayena_mushi");
  });

  it("numbers the handle when the name is already somebody else's", async () => {
    account("kayena", ["amani"]);

    await patch({ displayName: "Amani" });

    expect(updateData().username).toBe("amani_2");
  });

  it("does not touch the handle when the name still folds to it", async () => {
    account("amani");

    await patch({ displayName: "Amani" });

    expect(updateData()).not.toHaveProperty("username");
    expect(updateData().displayName).toBe("Amani");
  });

  it("saves a name that would be a reserved handle, keeping the old handle", async () => {
    account("amani");

    const response = await patch({ displayName: "Admin" });

    // The name is the person's to choose; renaming the account to `admin` is
    // not. The handle it already had stands.
    expect(response.status).toBe(200);
    expect(updateData().displayName).toBe("Admin");
    expect(updateData()).not.toHaveProperty("username");
  });
});
