-- WhatsApp profile pictures and group icons (WHATSAPP_AVATARS.md). Additive: one new table, nothing
-- else changes. Used only when a project's WHATSAPP_AVATARS feature is on (off by default) and the
-- server's WHATSAPP_AVATARS_DISABLED emergency switch is not set.
-- Rollback: DROP TABLE "WhatsAppPicture";

-- CreateTable
CREATE TABLE "WhatsAppPicture" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceTag" TEXT,
    "sourceUrl" TEXT,
    "mimeType" TEXT,
    "bytes" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "storedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppPicture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppPicture_state_nextAttemptAt_idx" ON "WhatsAppPicture"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppPicture_projectId_accountId_jid_key" ON "WhatsAppPicture"("projectId", "accountId", "jid");

-- AddForeignKey
ALTER TABLE "WhatsAppPicture" ADD CONSTRAINT "WhatsAppPicture_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppPicture" ADD CONSTRAINT "WhatsAppPicture_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The stored picture is a small, checked image or nothing (the worker enforces the same limits).
ALTER TABLE "WhatsAppPicture" ADD CONSTRAINT "WhatsAppPicture_bounded" CHECK (
  "state" IN ('PENDING', 'STORED', 'FAILED')
  AND ("bytes" IS NULL OR (octet_length("bytes") BETWEEN 1 AND 102400 AND "mimeType" IN ('image/jpeg', 'image/png', 'image/webp')))
  AND ("state" <> 'STORED' OR "bytes" IS NOT NULL)
);

-- Project integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "WhatsAppPicture_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppPicture" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "WhatsAppPicture_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "WhatsAppPicture" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
