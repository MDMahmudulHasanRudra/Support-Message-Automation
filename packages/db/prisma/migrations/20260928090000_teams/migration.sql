-- Teams: an organisational Team (Support, Billing, Commercial...) as a first-class record, a
-- membership history so reports attribute work to the Team somebody was in AT THE TIME, and a
-- convenience `teamId` on InternalTeamMember for the person's current Team.
--
-- Additive only. No existing row is changed except that members whose department names one of the
-- two departments below get a Team; nothing is deleted, no column is dropped or renamed ("role" stays
-- and is labelled Designation in the UI).
-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "InternalTeamMember" ADD COLUMN     "teamId" TEXT;

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "status" "TeamStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_code_key" ON "Team"("code");

-- CreateIndex
CREATE INDEX "TeamMembership_teamMemberId_idx" ON "TeamMembership"("teamMemberId");

-- CreateIndex
CREATE INDEX "TeamMembership_teamId_idx" ON "TeamMembership"("teamId");

-- CreateIndex
CREATE INDEX "InternalTeamMember_teamId_idx" ON "InternalTeamMember"("teamId");

-- AddForeignKey
ALTER TABLE "InternalTeamMember" ADD CONSTRAINT "InternalTeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Starting Teams, derived from the departments already on the roster — and only if somebody is
-- actually in that department, so a deployment without them gets no invented Teams. Everyone else
-- stays without a Team until an admin assigns one. `startedAt` is NULL ("since before Teams were
-- recorded") so past reports can be filtered by these Teams straight away.
INSERT INTO "Team" ("id", "name", "code", "description", "status", "updatedAt")
SELECT gen_random_uuid()::text, 'Support Team', 'SUPPORT', 'Customer support and technical assistance', 'ACTIVE', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "InternalTeamMember" WHERE lower(trim("department")) = 'customer support');

INSERT INTO "Team" ("id", "name", "code", "description", "status", "updatedAt")
SELECT gen_random_uuid()::text, 'Commercial Team', 'COMMERCIAL', 'Business development and sales', 'ACTIVE', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "InternalTeamMember" WHERE lower(trim("department")) = 'business development');

UPDATE "InternalTeamMember" m SET "teamId" = t."id"
FROM "Team" t
WHERE m."teamId" IS NULL
  AND ((t."name" = 'Support Team' AND lower(trim(m."department")) = 'customer support')
    OR (t."name" = 'Commercial Team' AND lower(trim(m."department")) = 'business development'));

INSERT INTO "TeamMembership" ("id", "teamMemberId", "teamId", "startedAt", "endedAt")
SELECT gen_random_uuid()::text, m."id", m."teamId", NULL, NULL
FROM "InternalTeamMember" m
WHERE m."teamId" IS NOT NULL;
