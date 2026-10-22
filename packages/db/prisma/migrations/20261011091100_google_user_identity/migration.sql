-- Google Sheets work management, Phase 4 (GOOGLE_SHEETS.md §5): a person's own Google identity.
-- Additive: one new, empty, PLATFORM table (no projectId — a person's Google account is the same in
-- every project). Written only when that person signs in with Google themselves; it is the one bridge
-- from an edit Google reports (`people/<id>`) to a person in the app, and is never guessed from an
-- email or a name.

-- CreateTable
CREATE TABLE "UserGoogleIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGoogleIdentity_pkey" PRIMARY KEY ("id")
);

-- A Google account belongs to one login only.
CREATE UNIQUE INDEX "UserGoogleIdentity_googleSubject_key" ON "UserGoogleIdentity"("googleSubject");

-- CreateIndex
CREATE INDEX "UserGoogleIdentity_userId_idx" ON "UserGoogleIdentity"("userId");

-- AddForeignKey
ALTER TABLE "UserGoogleIdentity" ADD CONSTRAINT "UserGoogleIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
