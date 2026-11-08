-- One customer's choices never block another's (A1): a project's address, its employee numbers and a linked Google
-- account are each unique inside a customer, not across the installation. NULL customer = the original installation.

-- A project's address.
DROP INDEX "Project_slug_key";
CREATE UNIQUE INDEX "Project_customer_slug_key" ON "Project" (COALESCE("customerId", ''), "slug");
CREATE INDEX "Project_slug_idx" ON "Project" ("slug");

-- Employee numbers: one counter per customer, so a new customer starts at 1 and no number says how many others exist.
DROP INDEX "Employee_employeeCode_key";
CREATE UNIQUE INDEX "Employee_customer_code_key" ON "Employee" (COALESCE("customerId", ''), "employeeCode");
CREATE INDEX "Employee_employeeCode_idx" ON "Employee" ("employeeCode");

CREATE TABLE "EmployeeCodeCounter" (
  "tenantKey" TEXT NOT NULL,
  "last" BIGINT NOT NULL,
  CONSTRAINT "EmployeeCodeCounter_pkey" PRIMARY KEY ("tenantKey")
);

-- Every customer continues after its own highest number. Never reused: the original installation also continues
-- after the old shared counter, which may have handed out a number since deleted.
INSERT INTO "EmployeeCodeCounter" ("tenantKey", "last")
SELECT COALESCE("customerId", ''), MAX(substring("employeeCode" from '^EMP-([0-9]+)$')::BIGINT)
FROM "Employee"
WHERE "employeeCode" ~ '^EMP-[0-9]+$'
GROUP BY 1;

INSERT INTO "EmployeeCodeCounter" ("tenantKey", "last")
SELECT '', "last_value" FROM "employee_code_seq" WHERE "is_called"
ON CONFLICT ("tenantKey") DO UPDATE SET "last" = GREATEST("EmployeeCodeCounter"."last", EXCLUDED."last");

-- A Google account is linked once per customer. '' = the original installation.
ALTER TABLE "UserGoogleIdentity" ADD COLUMN "customerKey" TEXT NOT NULL DEFAULT '';
UPDATE "UserGoogleIdentity" i
SET "customerKey" = u."customerId"
FROM "User" u
LEFT JOIN "Customer" c ON c."id" = u."customerId"
WHERE u."id" = i."userId" AND u."customerId" IS NOT NULL AND NOT COALESCE(c."isFounding", false);
DROP INDEX "UserGoogleIdentity_googleSubject_key";
CREATE UNIQUE INDEX "UserGoogleIdentity_customerKey_googleSubject_key" ON "UserGoogleIdentity" ("customerKey", "googleSubject");
