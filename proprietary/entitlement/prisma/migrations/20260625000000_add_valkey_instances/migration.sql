-- CreateEnum
CREATE TYPE "ValkeyInstanceStatus" AS ENUM ('pending', 'provisioning', 'ready', 'error', 'suspended', 'deleting');

-- CreateTable
CREATE TABLE "valkey_instances" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ValkeyInstanceStatus" NOT NULL DEFAULT 'pending',
    "status_message" TEXT,
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 6379,
    "secret_name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "maxmemory" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "valkey_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "valkey_instances_tenant_id_idx" ON "valkey_instances"("tenant_id");

-- CreateIndex
CREATE INDEX "valkey_instances_status_idx" ON "valkey_instances"("status");

-- AddForeignKey
ALTER TABLE "valkey_instances" ADD CONSTRAINT "valkey_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
