// =============================================================================
// GENHUB - Is the database schema the one this code expects?
// =============================================================================
// The question nobody asks until a customer clicks Pay. `prisma migrate deploy`
// is a deploy step, and a deploy that skipped it leaves the code and the schema
// disagreeing — which surfaces as a Prisma error on the first query that touches
// a new column, at the exact moment money is meant to move.
//
// This answers it two ways and is honest when it cannot:
//
//   expected  the migration directories in prisma/migrations, read from disk.
//   applied   the rows in `_prisma_migrations` with a `finished_at`, no
//             `rolled_back_at`.
//
// `pending` is the difference, and it is the number that matters: three pending
// migrations should be visible on the admin card BEFORE a customer meets them.
//
// The migrations folder is not in a serverless bundle by default, so
// next.config.js traces it into the route that calls this. When it is still
// unreadable (a bare function, a test), `known` is false and the card says
// "cannot tell" rather than reporting a false "up to date" — a clean bill of
// health nobody can support is worse than an admission.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import prisma from "./db";

export interface MigrationStatus {
  /** False when the migrations directory could not be read at all. */
  known: boolean;
  appliedCount: number;
  expectedCount: number;
  /** Expected migrations the database has not recorded as finished. */
  pending: string[];
  /** Migrations that started and never finished (a failed apply). */
  failed: string[];
  lastAppliedAt: string | null;
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

const MIGRATIONS_DIR = () => path.resolve(process.cwd(), "prisma", "migrations");

/**
 * The migrations this checkout ships, newest last.
 *
 * Only directories that actually hold a `migration.sql` are counted, so a
 * half-created folder cannot be reported as a pending change that can never
 * apply.
 */
export function readExpectedMigrations(dir: string = MIGRATIONS_DIR()): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(dir, entry.name, "migration.sql"))
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  const expected = readExpectedMigrations();
  const known = expected.length > 0;

  let rows: MigrationRow[] = [];
  try {
    // `_prisma_migrations` is created by the first `migrate deploy`. On a
    // database that has never been migrated the table is absent and this
    // THROWS — which is the answer "nothing has been applied", so it is caught
    // and turned into that rather than returned as an error.
    rows = await prisma.$queryRawUnsafe<MigrationRow[]>(
      `SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"`
    );
  } catch {
    return {
      known,
      appliedCount: 0,
      expectedCount: expected.length,
      pending: expected,
      failed: [],
      lastAppliedAt: null,
    };
  }

  const appliedNames = new Set(
    rows
      .filter((r) => r.finished_at && !r.rolled_back_at)
      .map((r) => r.migration_name)
  );

  const failed = rows
    .filter((r) => !r.finished_at && !r.rolled_back_at)
    .map((r) => r.migration_name);

  const pending = expected.filter((name) => !appliedNames.has(name));

  const lastApplied = rows
    .map((r) => r.finished_at)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    known,
    appliedCount: appliedNames.size,
    expectedCount: expected.length,
    pending,
    failed,
    lastAppliedAt: lastApplied ? new Date(lastApplied).toISOString() : null,
  };
}
