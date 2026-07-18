-- Snapshot a durable, non-FK identifier of WHICH license each audit row refers
-- to. licenseId is nulled on license delete (ON DELETE SET NULL), which would
-- otherwise leave reveal/issuance rows with no way to identify the license.
-- Storing the key's last 4 chars is enough to identify it without persisting
-- the secret. Nullable: pre-existing rows have no snapshot.
ALTER TABLE "license_key_reveals" ADD COLUMN "license_key_last4" TEXT;
ALTER TABLE "offline_license_issuances" ADD COLUMN "license_key_last4" TEXT;
