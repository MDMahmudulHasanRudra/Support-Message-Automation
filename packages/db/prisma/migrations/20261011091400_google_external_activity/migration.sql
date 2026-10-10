-- Google Sheets work management, Phase 8 (GOOGLE_SHEETS.md §3): changes made in Google directly.
-- Additive: nullable columns and one setting. Nothing existing changes.
--
-- The worker reads Drive Activity for MONITORED sheets. Google names an actor as `people/<id>`, and
-- an edit is credited to a person only through the Google identity they linked themselves — and only
-- once Google has been SEEN to use the same id as sign-in (an account's own edit, `isCurrentUser`,
-- whose id equals its `googleSubject`). Google does not document that the two are the same, so it is
-- checked, not assumed.

-- AlterTable
ALTER TABLE "GoogleIntegrationAccount" ADD COLUMN "activityIdentityMismatchAt" TIMESTAMP(3),
ADD COLUMN "activityIdentityVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GoogleSpreadsheet" ADD COLUMN "externalActivityCheckedAt" TIMESTAMP(3),
ADD COLUMN "externalActivityCheckedThrough" TIMESTAMP(3),
ADD COLUMN "externalActivityError" TEXT;

-- AlterTable
ALTER TABLE "GoogleSheetsSettings" ADD COLUMN "externalActivityEnabled" BOOLEAN NOT NULL DEFAULT true;
