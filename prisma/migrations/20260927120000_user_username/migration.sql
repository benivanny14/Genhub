-- =============================================================================
-- GENHUB - Unique username on accounts
--
-- The handle that nobody else may take. displayName is free text and two
-- accounts can share it, so it cannot stop one person from passing as another;
-- this column is unique and is what makes impersonation a non-starter.
--
-- Existing accounts are backfilled, so in practice every row has a value. The
-- column stays NULLABLE on purpose: a legacy row must never be the thing that
-- fails a deploy, and the app reads a missing handle as "no handle yet".
--
-- The backfill is deterministic and collision-free by construction:
--   * the base is a person's email local part (or their display name, or
--     "user"), lowercased and stripped to [a-z0-9], so it can never contain an
--     underscore;
--   * every base is numbered within itself and the row number is appended, so
--     the stored value is always "<base>_<n>". The last underscore separates a
--     (underscore-free) base from its number, which means two rows can only
--     collide if both the base and the number match — i.e. they are the same
--     row. No md5, no truncation luck.
--
-- A base that OPENS with a reserved word is thrown away and the account joins
-- the neutral "user_N" series instead. Without that, the backfill hands out
-- handles the sign-up form exists to refuse: admin@… would become `admin_1`,
-- support@… would become `support_1`, and both read as official voices for as
-- long as the account keeps them (and it may keep them forever — it already
-- holds one, so nothing forces a change). An exact reserved word is impossible
-- by construction, because every stored value ends in `_<n>`; the prefix is the
-- whole of what is left to defend against.
--
-- The list below is a frozen copy of RESERVED_PREFIXES in src/lib/usernames.ts.
-- It has to be a copy: a migration is a historical document and cannot import
-- today's TypeScript. A prefix added to the list later applies to new handles
-- from that point on, not to this one-time backfill, which is the correct
-- reading — this file ran once, on 2026-09-27.
-- =============================================================================

ALTER TABLE "User" ADD COLUMN "username" TEXT;

WITH base AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        LEFT(
          LOWER(
            REGEXP_REPLACE(
              SPLIT_PART(COALESCE("email", "displayName", ''), '@', 1),
              '[^a-zA-Z0-9]+', '', 'g'
            )
          ),
          20
        ),
        ''
      ),
      'user'
    ) AS b
  FROM "User"
  WHERE "username" IS NULL
),
-- A base that starts with one of our reserved words is replaced, not fixed:
-- `admin_1` with a zero-width joiner or a different suffix is still a handle
-- that claims to be us. "user" is already the answer for an account with no
-- usable name, and it collides with nothing (numbering handles that).
safe AS (
  SELECT
    "id",
    CASE
      WHEN b ~ '^(genhub|admin|support|official|moderator|staff|system|security)'
        THEN 'user'
      ELSE b
    END AS b
  FROM base
),
numbered AS (
  SELECT "id", b, ROW_NUMBER() OVER (PARTITION BY b ORDER BY "id") AS rn
  FROM safe
),
candidate AS (
  SELECT "id", LEFT(b, 20) || '_' || rn::text AS uname
  FROM numbered
)
UPDATE "User" u
SET "username" = c.uname
FROM candidate c
WHERE u."id" = c."id";

-- Named exactly as Prisma names a @unique index, so `migrate dev` reports no
-- drift and a fresh database ends up identical to a migrated one.
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
