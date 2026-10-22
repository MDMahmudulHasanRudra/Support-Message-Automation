-- SaaS platform, Phase 2 (SAAS_PLATFORM_PLAN.md): customers, the hostnames that open them, and the
-- platform's domain settings. Purely additive: new tables, two nullable columns, no row is changed.
-- Hostname routing is OFF by default (PlatformDomainSettings.hostRoutingEnabled = false, and no row
-- exists until a Main Admin saves one), so every existing hostname behaves exactly as before.
-- The removed Teams tables are deliberately NOT dropped here (see CLAUDE.md).

-- A session remembers the hostname it was created on; older sessions keep NULL and are accepted.
ALTER TABLE "UserSession" ADD COLUMN "hostname" TEXT;

-- A project may belong to one customer (one project per customer for now).
ALTER TABLE "Project" ADD COLUMN "customerId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "CustomerDomain" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verificationToken" TEXT NOT NULL,
    "lastCheck" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerDomain_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PlatformDomainSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "hostRoutingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rootDomain" TEXT,
    "adminHostnames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publicIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reservedLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedByUsername" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformDomainSettings_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "CustomerDomain_hostname_key" ON "CustomerDomain"("hostname");
-- CreateIndex
CREATE INDEX "CustomerDomain_customerId_idx" ON "CustomerDomain"("customerId");
-- CreateIndex
CREATE UNIQUE INDEX "Project_customerId_key" ON "Project"("customerId");
-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CustomerDomain" ADD CONSTRAINT "CustomerDomain_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
