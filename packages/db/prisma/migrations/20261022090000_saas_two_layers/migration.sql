-- Two administration layers (SAAS_PLATFORM_PLAN.md §12). Additive, plus three unique-index
-- swaps that keep every existing row valid:
--   * customer-owned rows (users, roles, departments, job titles, employees, security settings,
--     branding, portal log entries) gain a nullable "customerId"; NULL = the original installation,
--     so every existing row keeps its meaning and nothing is rewritten;
--   * role / department / job-title names become unique per customer (partial unique indexes);
--   * a customer may now own several projects (the one-project-per-customer index is dropped);
--   * the RELQIVO platform layer gets its own operators and sessions, support access sessions and
--     platform email settings;
--   * the "All Access" plan is created and preselected for NEW customers. No existing customer,
--     subscription, project or user is changed.
-- The retired Teams tables are deliberately not dropped.

DROP INDEX "Department_code_key";

DROP INDEX "Department_name_key";

DROP INDEX "JobTitle_name_key";

DROP INDEX "PermissionModule_name_key";

DROP INDEX "Project_customerId_key";

ALTER TABLE "Customer" ADD COLUMN     "isFounding" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Department" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "Employee" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "JobTitle" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "PermissionModule" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "Plan" ADD COLUMN     "allModules" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Subscription" ADD COLUMN "allModules" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PlatformBillingSettings" ADD COLUMN     "defaultPlanId" TEXT;

ALTER TABLE "PlatformBranding" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "SecuritySettings" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "SystemLog" ADD COLUMN     "customerId" TEXT;

ALTER TABLE "User" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "supportOperatorId" TEXT;

ALTER TABLE "UserSession" ADD COLUMN     "supportAccessSessionId" TEXT;

CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "canSupport" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUsername" TEXT,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformOperatorSession" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "hostname" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "stepUpAt" TIMESTAMP(3),

    CONSTRAINT "PlatformOperatorSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportAccessSession" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT,
    "operatorUsername" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "supportUserId" TEXT,
    "hostname" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketHash" TEXT NOT NULL,
    "ticketExpiresAt" TIMESTAMP(3) NOT NULL,
    "ticketUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "endedByUsername" TEXT,

    CONSTRAINT "SupportAccessSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformEmailSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 587,
    "tlsMode" TEXT NOT NULL DEFAULT 'STARTTLS',
    "username" TEXT,
    "passwordCiphertext" TEXT,
    "fromAddress" TEXT,
    "fromName" TEXT,
    "testRequestedAt" TIMESTAMP(3),
    "testRequestedTo" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedByUsername" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmailSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformOperator_username_key" ON "PlatformOperator"("username");

CREATE UNIQUE INDEX "PlatformOperatorSession_secretHash_key" ON "PlatformOperatorSession"("secretHash");

CREATE INDEX "PlatformOperatorSession_operatorId_idx" ON "PlatformOperatorSession"("operatorId");

CREATE UNIQUE INDEX "SupportAccessSession_ticketHash_key" ON "SupportAccessSession"("ticketHash");

CREATE INDEX "SupportAccessSession_customerId_createdAt_idx" ON "SupportAccessSession"("customerId", "createdAt");

CREATE INDEX "Department_customerId_idx" ON "Department"("customerId");

CREATE INDEX "Employee_customerId_idx" ON "Employee"("customerId");

CREATE INDEX "JobTitle_customerId_idx" ON "JobTitle"("customerId");

CREATE INDEX "PermissionModule_customerId_idx" ON "PermissionModule"("customerId");

CREATE UNIQUE INDEX "PlatformBranding_customerId_key" ON "PlatformBranding"("customerId");

CREATE UNIQUE INDEX "SecuritySettings_customerId_key" ON "SecuritySettings"("customerId");

CREATE INDEX "SystemLog_customerId_createdAt_idx" ON "SystemLog"("customerId", "createdAt");

CREATE INDEX "User_customerId_idx" ON "User"("customerId");

CREATE INDEX "UserSession_supportAccessSessionId_idx" ON "UserSession"("supportAccessSessionId");

ALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_supportOperatorId_fkey" FOREIGN KEY ("supportOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PermissionModule" ADD CONSTRAINT "PermissionModule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_supportAccessSessionId_fkey" FOREIGN KEY ("supportAccessSessionId") REFERENCES "SupportAccessSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecuritySettings" ADD CONSTRAINT "SecuritySettings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformBranding" ADD CONSTRAINT "PlatformBranding_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Department" ADD CONSTRAINT "Department_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobTitle" ADD CONSTRAINT "JobTitle_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformOperatorSession" ADD CONSTRAINT "PlatformOperatorSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportAccessSession" ADD CONSTRAINT "SupportAccessSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportAccessSession" ADD CONSTRAINT "SupportAccessSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportAccessSession" ADD CONSTRAINT "SupportAccessSession_supportUserId_fkey" FOREIGN KEY ("supportUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Names unique per customer; the original installation (NULL) keeps today's uniqueness exactly.
CREATE UNIQUE INDEX "PermissionModule_name_original_key" ON "PermissionModule"("name") WHERE "customerId" IS NULL;
CREATE UNIQUE INDEX "PermissionModule_customer_name_key" ON "PermissionModule"("customerId", "name") WHERE "customerId" IS NOT NULL;
CREATE UNIQUE INDEX "Department_name_original_key" ON "Department"("name") WHERE "customerId" IS NULL;
CREATE UNIQUE INDEX "Department_customer_name_key" ON "Department"("customerId", "name") WHERE "customerId" IS NOT NULL;
CREATE UNIQUE INDEX "Department_code_original_key" ON "Department"("code") WHERE "customerId" IS NULL AND "code" IS NOT NULL;
CREATE UNIQUE INDEX "Department_customer_code_key" ON "Department"("customerId", "code") WHERE "customerId" IS NOT NULL AND "code" IS NOT NULL;
CREATE UNIQUE INDEX "JobTitle_name_original_key" ON "JobTitle"("name") WHERE "customerId" IS NULL;
CREATE UNIQUE INDEX "JobTitle_customer_name_key" ON "JobTitle"("customerId", "name") WHERE "customerId" IS NOT NULL;

-- A customer's projects are looked up by customer.
CREATE INDEX "Project_customerId_idx" ON "Project"("customerId");

-- At most one founding customer (the original installation adopted as Customer #1).
CREATE UNIQUE INDEX "Customer_one_founding" ON "Customer"("isFounding") WHERE "isFounding";

-- One support identity per operator per customer.
CREATE UNIQUE INDEX "User_support_identity_key" ON "User"("supportOperatorId", COALESCE("customerId", '')) WHERE "supportOperatorId" IS NOT NULL;

-- The launch plan. Its price starts at 0 and is set on the platform (Plans), or per customer when
-- it is assigned. Created only if no plan of that name exists; never changes an existing plan.
INSERT INTO "Plan" ("id", "name", "description", "priceMinor", "currency", "interval", "trialDays", "features", "allModules", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES ('plan_all_access', 'All Access', 'Every module of the software, including ones added later.', 0, 'BDT', 'MONTH', 0, '{}', true, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- Preselected for new customers, unless a default was already chosen.
INSERT INTO "PlatformBillingSettings" ("id", "defaultPlanId", "updatedAt")
SELECT 'default', "id", CURRENT_TIMESTAMP FROM "Plan" WHERE "name" = 'All Access'
ON CONFLICT ("id") DO UPDATE SET "defaultPlanId" = COALESCE("PlatformBillingSettings"."defaultPlanId", EXCLUDED."defaultPlanId");
