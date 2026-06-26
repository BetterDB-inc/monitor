-- The public SNI host is now an opaque hash derived from the instance id, so the
-- name no longer has to be globally unique. Scope its uniqueness to the tenant
-- instead, letting different tenants reuse the same friendly name.

-- DropIndex
DROP INDEX "valkey_instances_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "valkey_instances_tenant_id_name_key" ON "valkey_instances"("tenant_id", "name");

-- The SNI host shares the valkey.app.betterdb.com wildcard, so it must stay
-- globally unique even though the name is now only unique per tenant.
-- CreateIndex
CREATE UNIQUE INDEX "valkey_instances_host_key" ON "valkey_instances"("host");
