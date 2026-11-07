-- Team automation (TEAM_AUTOMATION.md): members matched to their WhatsApp IDs by themselves, replies from our own
-- number's phone credited to who uses it, a roster that fills itself. Additive; no existing row changes
-- except switching on the unified Team Report, which the owner asked to be on for everybody.

ALTER TABLE "InternalTeamMember" ADD COLUMN "identityLinkSource" TEXT;
ALTER TABLE "InternalTeamMember" ADD COLUMN "autoLinkOff" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TeamManagementSettings" ADD COLUMN "autoLinkMembers" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TeamManagementSettings" ADD COLUMN "autoRoster" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TeamManagementSettings" ADD COLUMN "matchRequestedAt" TIMESTAMP(3);

CREATE TABLE "WhatsAppIdentityEvidence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "lid" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppIdentityEvidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsAppIdentityEvidence_projectId_lid_key" ON "WhatsAppIdentityEvidence"("projectId", "lid");
CREATE INDEX "WhatsAppIdentityEvidence_projectId_phone_idx" ON "WhatsAppIdentityEvidence"("projectId", "phone");
ALTER TABLE "WhatsAppIdentityEvidence" ADD CONSTRAINT "WhatsAppIdentityEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WhatsAppNumberOperator" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppNumberOperator_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WhatsAppNumberOperator_projectId_accountId_idx" ON "WhatsAppNumberOperator"("projectId", "accountId");
CREATE INDEX "WhatsAppNumberOperator_teamMemberId_idx" ON "WhatsAppNumberOperator"("teamMemberId");
-- One open period per person per number.
CREATE UNIQUE INDEX "WhatsAppNumberOperator_one_open" ON "WhatsAppNumberOperator"("accountId", "teamMemberId") WHERE "endedAt" IS NULL;
ALTER TABLE "WhatsAppNumberOperator" ADD CONSTRAINT "WhatsAppNumberOperator_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNumberOperator" ADD CONSTRAINT "WhatsAppNumberOperator_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNumberOperator" ADD CONSTRAINT "WhatsAppNumberOperator_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE CONSTRAINT TRIGGER "WhatsAppNumberOperator_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "WhatsAppNumberOperator" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "WhatsAppNumberOperator_teamMemberId_same_project" AFTER INSERT OR UPDATE OF "teamMemberId", "projectId" ON "WhatsAppNumberOperator" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'teamMemberId');
CREATE TRIGGER "WhatsAppIdentityEvidence_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppIdentityEvidence" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "WhatsAppNumberOperator_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppNumberOperator" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The Team Report's personal and combined views, run information and identity tools are on for everybody now.
UPDATE "ProjectFeature" SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'UNIFIED_REPORTING';
