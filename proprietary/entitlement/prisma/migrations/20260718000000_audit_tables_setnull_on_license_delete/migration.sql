-- Audit tables must OUTLIVE the license they reference: switch their FKs from
-- ON DELETE CASCADE to ON DELETE SET NULL so deleting a license/customer no
-- longer erases the record of who revealed a key / was issued an offline token.

-- DropForeignKey
ALTER TABLE "license_key_reveals" DROP CONSTRAINT "license_key_reveals_license_id_fkey";
ALTER TABLE "offline_license_issuances" DROP CONSTRAINT "offline_license_issuances_license_id_fkey";

-- AlterTable — license_id becomes nullable (SET NULL target)
ALTER TABLE "license_key_reveals" ALTER COLUMN "license_id" DROP NOT NULL;
ALTER TABLE "offline_license_issuances" ALTER COLUMN "license_id" DROP NOT NULL;

-- AddForeignKey — ON DELETE SET NULL
ALTER TABLE "license_key_reveals" ADD CONSTRAINT "license_key_reveals_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offline_license_issuances" ADD CONSTRAINT "offline_license_issuances_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
