-- A profile subscription costs TZS 8,000 a month (see lib/subscription.ts).

-- 1. New profiles get 8,000 unless a price is passed in explicitly.
ALTER TABLE "CreatorProfile" ALTER COLUMN "subscriptionPrice" SET DEFAULT 8000;

-- 2. Profiles still carrying 5,000 were created with the OLD default. Nothing in
--    the app has ever offered a creator a way to set this number, so a 5,000 here
--    is the old default rather than somebody's decision — leaving it alone would
--    keep quoting TZS 5,000 on every existing profile while the code said 8,000.
UPDATE "CreatorProfile" SET "subscriptionPrice" = 8000 WHERE "subscriptionPrice" = 5000;

-- 3. A NULL price falls back to the constant in code. Fill it in so the row and
--    the code answer the same question the same way.
UPDATE "CreatorProfile" SET "subscriptionPrice" = 8000 WHERE "subscriptionPrice" IS NULL;
