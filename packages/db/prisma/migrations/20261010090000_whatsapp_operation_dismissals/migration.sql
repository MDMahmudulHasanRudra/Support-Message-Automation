-- WhatsApp operations: per-user Clear / Hide (display only).
--
-- One row per person per operation they cleared from their own operation tracker. Nothing about the
-- job changes — its rows, items and results stay exactly as they are, and its page still shows it.
-- Additive: a new, empty table. Nothing is backfilled (the old per-browser dismissals lived in
-- localStorage and are simply forgotten — a finished job leaves the indicator after 12 hours anyway).

-- CreateTable
CREATE TABLE "WhatsAppOperationDismissal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stateAtDismissal" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppOperationDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppOperationDismissal_projectId_userId_idx" ON "WhatsAppOperationDismissal"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppOperationDismissal_projectId_userId_kind_jobId_key" ON "WhatsAppOperationDismissal"("projectId", "userId", "kind", "jobId");

-- AddForeignKey
ALTER TABLE "WhatsAppOperationDismissal" ADD CONSTRAINT "WhatsAppOperationDismissal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppOperationDismissal" ADD CONSTRAINT "WhatsAppOperationDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project. (The job it names is checked through the scoped
-- client when it is written; jobId is deliberately not a foreign key, since it names a row in one of
-- two job tables by kind.)
CREATE TRIGGER "WhatsAppOperationDismissal_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppOperationDismissal" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
