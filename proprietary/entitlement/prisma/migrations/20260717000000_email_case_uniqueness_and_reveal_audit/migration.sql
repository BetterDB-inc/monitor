-- Backfill: normalize existing rows so pre-index mixed-case accounts stay
-- reachable by the (normalized) lookup paths.
UPDATE "customers" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");

-- Case-insensitive uniqueness for customer emails: lookups are insensitive,
-- so two rows differing only by case would conflate accounts (key reveal /
-- offline issuance could cross account boundaries).
-- NB: fails loudly if two distinct accounts collapse to the same LOWER(email)
-- (the backfill above would also fail on the @unique constraint in that
-- case) — resolve such duplicates manually before deploying.
CREATE UNIQUE INDEX "customers_email_lower_key" ON "customers" (LOWER("email"));

-- CreateTable
CREATE TABLE "license_key_reveals" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "revealed_to_email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_key_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "license_key_reveals_license_id_idx" ON "license_key_reveals"("license_id");

-- AddForeignKey
ALTER TABLE "license_key_reveals" ADD CONSTRAINT "license_key_reveals_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
