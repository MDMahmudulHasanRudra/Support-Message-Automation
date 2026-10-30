-- Social Studio AI Content Studio requests (SOCIAL_STUDIO.md §AI). A new, empty, project-owned table.

-- CreateTable
CREATE TABLE "SocialAiRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "kind" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "providerId" TEXT,
    "modelId" TEXT,
    "tokensUsed" INTEGER,
    "requestedByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAiRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAiRequest_projectId_status_createdAt_idx" ON "SocialAiRequest"("projectId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "SocialAiRequest" ADD CONSTRAINT "SocialAiRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Project integrity: a row never changes project.
CREATE TRIGGER "SocialAiRequest_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialAiRequest" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
