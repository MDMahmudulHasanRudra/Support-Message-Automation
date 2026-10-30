-- Social Studio RSS import (SOCIAL_STUDIO.md §Automation): feeds and the items seen. New, empty, project-owned tables.

-- CreateTable
CREATE TABLE "SocialRssFeed" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prefix" TEXT,
    "includeSummary" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "importFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "draftsCreated" INTEGER NOT NULL DEFAULT 0,
    "createdByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialRssFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialRssItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "feedId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT,
    "postId" TEXT,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialRssItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialRssFeed_projectId_enabled_idx" ON "SocialRssFeed"("projectId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SocialRssItem_feedId_guid_key" ON "SocialRssItem"("feedId", "guid");

-- AddForeignKey
ALTER TABLE "SocialRssFeed" ADD CONSTRAINT "SocialRssFeed_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialRssItem" ADD CONSTRAINT "SocialRssItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialRssItem" ADD CONSTRAINT "SocialRssItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "SocialRssFeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Project integrity: a row never changes project, and an item never points at another project's feed.
CREATE TRIGGER "SocialRssFeed_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialRssFeed" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialRssItem_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialRssItem" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "SocialRssItem_feedId_same_project" AFTER INSERT OR UPDATE OF "feedId", "projectId" ON "SocialRssItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialRssFeed', 'feedId');
