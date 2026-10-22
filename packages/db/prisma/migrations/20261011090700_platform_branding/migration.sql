-- White labeling (BRANDING.md). Additive: one new, empty, platform-wide table (no projectId — one
-- installation has one brand). No row means every default, exactly as before this migration, so
-- nothing changes until a Main Admin saves something on Main Admin → Branding.

-- CreateTable
CREATE TABLE "PlatformBranding" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "productName" TEXT,
    "loginHeadline" TEXT,
    "loginSubheading" TEXT,
    "accentColor" TEXT,
    "logo" BYTEA,
    "logoMimeType" TEXT,
    "icon" BYTEA,
    "iconMimeType" TEXT,
    "assetVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedByUsername" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformBranding_pkey" PRIMARY KEY ("id")
);
