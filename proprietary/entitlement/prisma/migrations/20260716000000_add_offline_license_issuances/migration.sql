-- CreateTable
CREATE TABLE "offline_license_issuances" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "issued_to_email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_license_issuances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offline_license_issuances_jti_key" ON "offline_license_issuances"("jti");

-- CreateIndex
CREATE INDEX "offline_license_issuances_license_id_idx" ON "offline_license_issuances"("license_id");

-- AddForeignKey
ALTER TABLE "offline_license_issuances" ADD CONSTRAINT "offline_license_issuances_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
