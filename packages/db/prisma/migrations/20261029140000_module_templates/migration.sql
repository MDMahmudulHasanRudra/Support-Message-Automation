-- Reusable module templates (PROJECT_MODULES.md §8). Additive: a new customer-owned table and two
-- nullable history columns. Nothing existing changes.
ALTER TABLE "ProjectModuleConfigChange" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "ProjectModuleConfigChange" ADD COLUMN "templateVersion" INTEGER;

CREATE TABLE "ModuleTemplate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseType" "ProjectType" NOT NULL,
    "modules" TEXT[],
    "declined" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdByUsername" TEXT NOT NULL,
    "updatedByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModuleTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModuleTemplate_customerId_idx" ON "ModuleTemplate"("customerId");

-- One template in use per name per customer, case-insensitive; archived ones free the name.
CREATE UNIQUE INDEX "ModuleTemplate_name_original_key" ON "ModuleTemplate"(lower("name")) WHERE "customerId" IS NULL AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "ModuleTemplate_name_customer_key" ON "ModuleTemplate"("customerId", lower("name")) WHERE "customerId" IS NOT NULL AND "archivedAt" IS NULL;

ALTER TABLE "ModuleTemplate" ADD CONSTRAINT "ModuleTemplate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The history row was append-only before the new columns existed; it still is (the trigger covers
-- every column of a row, including these).
