// =============================================================================
// GENHUB - Changing a username is a choice; keeping one is not
//
// The migration that gave every existing account a handle numbers an email
// local part (`admin@…` becomes `admin_1`), so a legacy account can hold a name
// the format rules would refuse as a NEW choice — it opens with a reserved
// word, which is exactly what the reserved list exists to stop for new
// sign-ups. The route learned that the hard way: it validated first and
// compared second, so such an account could not save its own profile form at
// all, and the refusal ("that username is reserved") appeared beside a field
// nobody had touched.
//
// What these tests pin is the order: compare, then judge. Everything else about
// the endpoint — uniqueness, normalisation, the P2002 race — is unchanged.
//
// Prisma, auth and the cache are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUser: vi.fn(),
  findTaken: vi.fn(),
  updateUser: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findUnique: (...a: unknown[]) => mocks.findUser(...a),
      update: (...a: unknown[]) => mocks.updateUser(...a),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/redis", () => ({
  cacheDel: (...a: unknown[]) => mocks.cacheDel(...a),
}));

import { POST } from "./route";

const ME = "user-1";

function change(body: unknown) {
  return new NextRequest("https://app.test/api/account/username", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** `prisma.user.findUnique` answers both questions: who am I, and is it taken. */
function account(username: string | null, taken: { id: string } | null = null) {
  mocks.findUser.mockImplementation((args: { where: { id?: string } }) =>
    Promise.resolve(args.where.id ? { username } : taken)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: ME, role: "CREATOR" });
  mocks.updateUser.mockResolvedValue({ id: ME, username: "newname" });
  mocks.cacheDel.mockResolvedValue(undefined);
});

describe("POST /api/account/username", () => {
  it("accepts a legacy handle that the rules would refuse as a new choice", async () => {
    // The backfill gave this account `admin_1` from admin@example.com.
    account("admin_1");

    const response = await POST(change({ username: "admin_1" }));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("accepts the same handle typed with an @ and capitals", async () => {
    account("admin_1");

    const response = await POST(change({ username: "@Admin_1" }));

    expect(response.status).toBe(200);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("still refuses a reserved name that is actually a change", async () => {
    account("amani");

    const response = await POST(change({ username: "admin_1" }));
    const body = await json(response);

    // 422 is api.validation's status; the point is that it is refused, and that
    // the sentence names the reason.
    expect(response.status).toBe(422);
    expect(String(body.error)).toContain("reserved");
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a name somebody else holds", async () => {
    account("amani", { id: "user-2" });

    const response = await POST(change({ username: "neema" }));

    expect(response.status).toBe(409);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("writes a new handle and drops the cached session copy", async () => {
    account("amani");

    const response = await POST(change({ username: "Neema_2" }));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ id: ME, username: "newname" });
    // Normalised: what is stored is what the rules describe.
    const write = mocks.updateUser.mock.calls[0][0] as { data: { username: string } };
    expect(write.data.username).toBe("neema_2");
    expect(mocks.cacheDel).toHaveBeenCalledWith(`user:${ME}:*`);
  });

  it("reports a race for the same name as taken, not as a server fault", async () => {
    account("amani");
    mocks.updateUser.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["username"] } })
    );

    const response = await POST(change({ username: "neema" }));

    expect(response.status).toBe(409);
  });

  it("asks for a username when the field is missing", async () => {
    account("amani");

    const response = await POST(change({}));

    expect(response.status).toBe(422);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("refuses a name that is too short before touching the database", async () => {
    account("amani");

    const response = await POST(change({ username: "ab" }));

    expect(response.status).toBe(422);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
