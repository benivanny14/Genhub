// =============================================================================
// GENHUB - Every migration runs, on a real Postgres, with no server
//
// `prisma/migrations` is the only description of this database, and until now
// nothing executed it in a test: the suites that would need a database skip
// themselves when there is none, so a broken migration was found by whoever ran
// `db:deploy` — on staging, or on production.
//
// PGlite is Postgres 16 compiled to WebAssembly. It runs in this process, needs
// no server, no Docker and no credentials, and it executes the real SQL. So the
// whole chain is applied here in Prisma's order, and the username backfill is
// exercised on a legacy population rather than described in a comment.
//
// Deliberately NOT a socket-and-Prisma-client harness: measured, PGlite's
// single-threaded wire-protocol server refuses later connections once a client
// has come and gone abruptly (the Prisma CLI exiting, or a vitest worker being
// recycled), which made the money suites flaky. The schema is the part that can
// be proven in-process, so that is the part proven here.
// =============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN, isReservedUsername } from "@/lib/usernames";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const USERNAME_MIGRATION = "20260927120000_user_username";

const readMigration = (name: string) =>
  readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");

/**
 * A legacy account population: the shapes the backfill has to survive. Ids are
 * ordered so the numbering is deterministic.
 */
const LEGACY: Array<[string, string | null, string | null]> = [
  ["u01", "john@example.com", "John A"],
  ["u02", "john@gmail.com", "John B"],
  ["u03", "Bob@Example.com", null],
  ["u04", null, "Asha M."],
  ["u05", null, null],
  ["u06", "", ""],
  ["u07", "محمد@example.com", null],
  ["u08", "_juma_@example.com", null],
  ["u09", "juma+promo@example.com", null],
  ["u10", "admin@example.com", null],
  ["u11", "support@example.com", null],
  ["u12", "genhub@example.com", null],
  ["u13", "2257@example.com", null],
  ["u14", "x@example.com", null],
  ["u15", "averyveryverylonglocalpartindeed@example.com", null],
  ["u16", "Mary.Wanjiku@x.com", null],
  ["u17", "EMAIL@UPPER.EXAMPLE", null],
];

describe("the migration chain", () => {
  let db: PGlite;
  let usernames: Map<string, string>;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;

    const migrations = readdirSync(MIGRATIONS)
      .filter((name) => existsSync(join(MIGRATIONS, name, "migration.sql")))
      .sort();

    // Everything that came before the username column, then the legacy rows,
    // then the migration under test — the order a real deploy sees them in.
    for (const name of migrations.filter((n) => n !== USERNAME_MIGRATION)) {
      await db.exec(readMigration(name));
    }

    for (const [id, email, displayName] of LEGACY) {
      await db.query(
        `INSERT INTO "User" ("id", "email", "displayName", "passwordHash", "updatedAt")
         VALUES ($1, $2, $3, 'x', CURRENT_TIMESTAMP)`,
        [id, email, displayName]
      );
    }

    await db.exec(readMigration(USERNAME_MIGRATION));

    const rows = await db.query<{ id: string; username: string }>(
      `SELECT "id", "username" FROM "User" ORDER BY "id"`
    );
    usernames = new Map(rows.rows.map((row) => [row.id, row.username]));
  }, 120_000);

  it("applies the whole chain in order", async () => {
    // If this is zero the glob stopped matching and the test proves nothing.
    const tables = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
    );
    expect(tables.rows[0].n).toBeGreaterThan(20);

    // Spot-check the tables the money and video paths cannot run without.
    for (const table of [
      "User",
      "Video",
      "Transaction",
      "CreatorBalance",
      "CreatorSubscription",
      "PayoutRequest",
      "PayMessage",
      "CronHeartbeat",
      "KycVerification",
    ]) {
      const found = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      expect(found.rows[0].n, table).toBe(1);
    }
  });

  it("leaves the username column protected by a unique index Prisma recognises", async () => {
    const index = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'User' AND indexname = 'User_username_key'`
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(index.rows[0].indexdef).toMatch(/\(username\)/);
  });

  it("gives every legacy account a handle that follows the app's own rules", () => {
    for (const [id] of LEGACY) {
      const username = usernames.get(id) as string;
      expect(username, id).toBeTruthy();
      expect(username, id).toMatch(USERNAME_PATTERN);
      expect(username.length, id).toBeGreaterThanOrEqual(USERNAME_MIN_LENGTH);
      expect(username.length, id).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      // The rule the sign-up form applies, applied to what the backfill handed
      // out: a handle the app would refuse must not be created here either.
      expect(isReservedUsername(username), `${id} -> ${username}`).toBe(false);
    }
  });

  it("is deterministic about what it derives", () => {
    expect(usernames.get("u01")).toBe("john_1");
    expect(usernames.get("u02")).toBe("john_2");
    expect(usernames.get("u03")).toBe("bob_1"); // lowercased
    expect(usernames.get("u08")).toBe("juma_1"); // `_juma_` loses the underscores
    expect(usernames.get("u09")).toBe("jumapromo_1"); // plus-addressing stripped
    expect(usernames.get("u16")).toBe("marywanjiku_1");
    expect(usernames.get("u17")).toBe("email_1");
    expect(usernames.get("u15")).toBe("averyveryverylongloc_1"); // 20 characters, then the number
  });

  it("falls back to the neutral series instead of handing out a reserved word", () => {
    // admin@…, support@… and genhub@… would otherwise become admin_1, support_1
    // and genhub_1: handles that read as official voices, that the sign-up form
    // exists to refuse, and that the account would keep forever.
    for (const id of ["u10", "u11", "u12"]) {
      expect(usernames.get(id), id).toMatch(/^user_\d+$/);
    }
    // An account with no usable name at all lands in the same series.
    expect(usernames.get("u05")).toMatch(/^user_\d+$/);
    expect(usernames.get("u07")).toMatch(/^user_\d+$/);
  });

  it("cannot be handed a duplicate even if the numbering were wrong", async () => {
    const taken = usernames.get("u02") as string;
    await expect(
      db.query(`UPDATE "User" SET "username" = $1 WHERE "id" = 'u01'`, [taken])
    ).rejects.toThrow();
  });
});
