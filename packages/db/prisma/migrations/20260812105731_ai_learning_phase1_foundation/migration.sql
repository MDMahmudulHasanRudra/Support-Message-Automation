-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AiProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AiModelJob" AS ENUM ('LEARNING', 'RESPONSE', 'VISION', 'DOCUMENT', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "AiKnowledgeCategory" AS ENUM ('SOFTWARE', 'WORKFLOW', 'FAQ', 'TROUBLESHOOTING', 'CUSTOMER_RESPONSE', 'SOP', 'REQUIREMENT', 'FEATURE', 'POLICY', 'ANNOUNCEMENT', 'SCREENSHOT');

-- CreateEnum
CREATE TYPE "AiKnowledgeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "aiEngineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "learningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoResponseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "screenshotResponseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chatLearningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "softwareLearningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requirementLearningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "announcementAiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "duplicateSimilarityThreshold" INTEGER NOT NULL DEFAULT 95,
    "learningConfidenceThreshold" INTEGER NOT NULL DEFAULT 90,
    "autoApprovalThreshold" INTEGER NOT NULL DEFAULT 95,
    "humanReviewThreshold" INTEGER NOT NULL DEFAULT 70,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "apiUrl" TEXT,
    "apiKeyCiphertext" TEXT NOT NULL,
    "status" "AiProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelConfig" (
    "id" TEXT NOT NULL,
    "job" "AiModelJob" NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiKnowledgeItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "AiKnowledgeCategory" NOT NULL,
    "question" TEXT,
    "answer" TEXT NOT NULL,
    "procedure" TEXT,
    "software" TEXT,
    "module" TEXT,
    "softwareVersion" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "confidence" INTEGER,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "humanVerified" BOOLEAN NOT NULL DEFAULT true,
    "status" "AiKnowledgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiKnowledgeVersion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" "AiKnowledgeCategory" NOT NULL,
    "question" TEXT,
    "answer" TEXT NOT NULL,
    "procedure" TEXT,
    "software" TEXT,
    "module" TEXT,
    "softwareVersion" TEXT,
    "changeSummary" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiKnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiModelConfig_job_key" ON "AiModelConfig"("job");

-- CreateIndex
CREATE INDEX "AiKnowledgeItem_category_idx" ON "AiKnowledgeItem"("category");

-- CreateIndex
CREATE INDEX "AiKnowledgeItem_status_idx" ON "AiKnowledgeItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AiKnowledgeVersion_itemId_version_key" ON "AiKnowledgeVersion"("itemId", "version");

-- AddForeignKey
ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiKnowledgeVersion" ADD CONSTRAINT "AiKnowledgeVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "AiKnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiKnowledgeVersion" ADD CONSTRAINT "AiKnowledgeVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
