-- MAIN ADMIN: organisation configuration and project access levels. See MAIN_ADMIN_WORKSPACE.md §4–§5.
--
-- Additive only: three new platform-level tables, one sequence, two enums and one NULLABLE column.
-- No existing row is read or changed. Every existing ProjectAccess row gets level NULL, which means
-- FULL — so every user keeps exactly the rights they have today until a Main Admin narrows them.
--
-- The new tables carry no "projectId" on purpose: a department, a job title or a person belongs to the
-- organisation, not to one project. They therefore need no Phase 7 consistency triggers (those guard
-- references BETWEEN project-owned tables), and projectIntegrity.integration.test.ts agrees.

-- Access levels ------------------------------------------------------------------------------------
CREATE TYPE "ProjectAccessLevel" AS ENUM ('READ', 'WRITE', 'FULL');

ALTER TABLE "ProjectAccess" ADD COLUMN "level" "ProjectAccessLevel";

-- Organisation ------------------------------------------------------------------------------------
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobTitle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobTitle_pkey" PRIMARY KEY ("id")
);

-- Employee codes ("EMP-000001") come from this sequence, read by the application in the same
-- transaction that creates the employee (apps/web/src/server/configuration.ts). A sequence never hands
-- out the same number twice, even to two transactions at once, and a rolled-back create only leaves a
-- gap — so codes are unique and never reused. Prisma does not model sequences, so it will not propose
-- dropping this one.
CREATE SEQUENCE "employee_code_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "departmentId" TEXT,
    "jobTitleId" TEXT,
    "userId" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Employee_employeeCode_format" CHECK ("employeeCode" ~ '^EMP-[0-9]{6,}$')
);

CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");
CREATE UNIQUE INDEX "JobTitle_name_key" ON "JobTitle"("name");
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON "Employee"("employeeCode");
CREATE UNIQUE INDEX "Employee_email_key" ON "Employee"("email");
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");
CREATE INDEX "Employee_jobTitleId_idx" ON "Employee"("jobTitleId");

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_jobTitleId_fkey" FOREIGN KEY ("jobTitleId") REFERENCES "JobTitle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
