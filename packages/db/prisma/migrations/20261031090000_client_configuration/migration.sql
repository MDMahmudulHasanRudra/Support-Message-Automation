-- Smart Import V5 / Client Configuration Center (CLIENT_CONFIGURATION.md). Additive only: three new, empty,
-- project-owned tables; two nullable or empty-default columns on Client; a false-default flag on ClientBillingCurrency.
-- Adding a column with a constant default does not rewrite Client on PostgreSQL 11+.

-- CreateEnum
CREATE TYPE "ClientCatalogKind" AS ENUM ('TAG', 'CATEGORY', 'BUSINESS_TYPE');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "additionalLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "businessType" TEXT;

-- AlterTable
ALTER TABLE "ClientBillingCurrency" ADD COLUMN     "favorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClientCatalogEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "kind" "ClientCatalogKind" NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientServicePlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "service" TEXT,
    "defaultKind" "ClientSubscriptionKind" NOT NULL DEFAULT 'PAID',
    "defaultDuration" INTEGER,
    "defaultUnit" "ClientDurationUnit",
    "prices" JSONB NOT NULL DEFAULT '[]',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientServicePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientCountrySetting" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "country" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT,
    "language" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientCountrySetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientCatalogEntry_projectId_kind_archivedAt_idx" ON "ClientCatalogEntry"("projectId", "kind", "archivedAt");

-- CreateIndex
CREATE INDEX "ClientServicePlan_projectId_archivedAt_idx" ON "ClientServicePlan"("projectId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientCountrySetting_projectId_country_key" ON "ClientCountrySetting"("projectId", "country");

-- AddForeignKey
ALTER TABLE "ClientCatalogEntry" ADD CONSTRAINT "ClientCatalogEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientServicePlan" ADD CONSTRAINT "ClientServicePlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCountrySetting" ADD CONSTRAINT "ClientCountrySetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A name is one entry per project and kind (or per project, for plans), whatever its case: "VIP" and "vip" are one tag.
CREATE UNIQUE INDEX "ClientCatalogEntry_projectId_kind_name_ci_key" ON "ClientCatalogEntry"("projectId", "kind", lower("name"));
CREATE UNIQUE INDEX "ClientServicePlan_projectId_name_ci_key" ON "ClientServicePlan"("projectId", lower("name"));

-- Project integrity: a row never changes project.
CREATE TRIGGER "ClientCatalogEntry_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientCatalogEntry" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientServicePlan_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientServicePlan" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientCountrySetting_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientCountrySetting" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
