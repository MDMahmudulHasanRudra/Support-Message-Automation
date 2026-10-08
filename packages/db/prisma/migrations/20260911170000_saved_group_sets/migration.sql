-- A saved selection of groups, for the hundred you pick every time there is maintenance.
--
-- A snapshot of ids rather than a live rule. ChatCategory is the living version — put a group in
-- "Premium" and it joins every future Premium send by itself. A saved set is the frozen version,
-- for a selection that was a judgement rather than a property: "the ones affected by the Dhaka
-- outage" is not a category anybody maintains.
--
-- groupIds is a plain array, not a join table: a set has to survive a group being deleted or
-- resynced away, and report the gap when it is loaded rather than quietly shrinking through a
-- cascade until the name no longer describes what it sends to.
CREATE TABLE "SavedGroupSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupIds" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedGroupSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedGroupSet_name_key" ON "SavedGroupSet"("name");

ALTER TABLE "SavedGroupSet" ADD CONSTRAINT "SavedGroupSet_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
