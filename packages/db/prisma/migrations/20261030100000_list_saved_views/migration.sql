-- Saved views on list pages (PROJECT_MODULES.md §Saved views). Additive: one project-owned table.

-- CreateTable
CREATE TABLE "ListSavedView" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "ownerId" TEXT,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListSavedView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListSavedView_projectId_path_ownerId_idx" ON "ListSavedView"("projectId", "path", "ownerId");

-- AddForeignKey
ALTER TABLE "ListSavedView" ADD CONSTRAINT "ListSavedView_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListSavedView" ADD CONSTRAINT "ListSavedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A row's project never changes (MULTI_PROJECT_PLAN.md Phase 7). Its owner is a User (platform), not a
-- project-owned row, so no same-project trigger applies.
CREATE TRIGGER "ListSavedView_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ListSavedView" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
