-- Automatic conversation routing (feature AUTO_ROUTING, with UNIFIED_INBOX_V3; both off by default;
-- AUTO_ROUTING.md). Additive only: one new table and two partial indexes on ChannelConversation. No
-- conversation, message or event is changed. Assignments it makes are ordinary ConversationEvent rows of the
-- existing ASSIGNEE kind, with { reason: "AUTO_ROUTING", method } in their context, so the event-kind CHECK
-- does not change.

-- CreateTable
CREATE TABLE "RoutingSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeWhatsAppGroups" BOOLEAN NOT NULL DEFAULT false,
    "method" TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
    "maxOpenPerAgent" INTEGER NOT NULL DEFAULT 15,
    "poolTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "poolUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onlyOnDuty" BOOLEAN NOT NULL DEFAULT false,
    "requireRecentlySeen" BOOLEAN NOT NULL DEFAULT false,
    "recentlySeenMinutes" INTEGER NOT NULL DEFAULT 15,
    "lastPickedUserId" TEXT,
    "lastUnroutedAt" TIMESTAMP(3),
    "lastUnroutedReasons" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoutingSettings_projectId_key" ON "RoutingSettings"("projectId");

-- AddForeignKey
ALTER TABLE "RoutingSettings" ADD CONSTRAINT "RoutingSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The setting's own bounds (packages/shared autoRouting.ts sanitizeRoutingSettings states the same rule).
ALTER TABLE "RoutingSettings" ADD CONSTRAINT "RoutingSettings_method_check" CHECK ("method" IN ('ROUND_ROBIN', 'LEAST_OPEN'));
ALTER TABLE "RoutingSettings" ADD CONSTRAINT "RoutingSettings_capacity_check" CHECK ("maxOpenPerAgent" BETWEEN 1 AND 200);
ALTER TABLE "RoutingSettings" ADD CONSTRAINT "RoutingSettings_seen_check" CHECK ("recentlySeenMinutes" BETWEEN 10 AND 1440);
ALTER TABLE "RoutingSettings" ADD CONSTRAINT "RoutingSettings_channels_check" CHECK ("channels" <@ ARRAY['WEBCHAT', 'MESSENGER', 'INSTAGRAM', 'TELEGRAM', 'WHATSAPP_PERSONAL']::TEXT[]);

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): a row never changes project. The pool's Team and user ids
-- are arrays, which cannot carry a same-project trigger of the usual shape; Teams are checked to be this
-- project's when saved and re-read through the project-scoped client when routing, so a stray id is simply
-- never found, and a user is routed only with a ProjectAccess row in this project.
CREATE TRIGGER "RoutingSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "RoutingSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The routing sweep reads only open, unassigned channel conversations; capacity counts a person's assigned
-- ones. ChannelConversation is small next to Message, so a plain build is fine.
CREATE INDEX "ChannelConversation_unassigned_open_idx" ON "ChannelConversation"("projectId", "lastInboundAt") WHERE "assignedUserId" IS NULL AND "status" = 'OPEN';
CREATE INDEX "ChannelConversation_assignee_idx" ON "ChannelConversation"("projectId", "assignedUserId") WHERE "assignedUserId" IS NOT NULL;
