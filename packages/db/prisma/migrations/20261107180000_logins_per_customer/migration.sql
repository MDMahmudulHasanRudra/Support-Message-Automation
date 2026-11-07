-- Each customer has its own logins: "admin" at one customer says nothing about "admin" at another. No row changes.
-- Sign-in is decided by the customer's address (login/actions.ts).
DROP INDEX "User_username_key";
DROP INDEX "User_email_key";
-- COALESCE: NULL is the original installation, and NULLs would otherwise never clash with each other.
CREATE UNIQUE INDEX "User_customer_username_key" ON "User" (COALESCE("customerId", ''), "username");
CREATE UNIQUE INDEX "User_customer_email_key" ON "User" (COALESCE("customerId", ''), "email") WHERE "email" IS NOT NULL;
CREATE INDEX "User_username_idx" ON "User" ("username");
CREATE INDEX "User_email_idx" ON "User" ("email");

-- How long a new password must be: a customer's own, and a project Lead's for that project. Existing passwords keep working.
ALTER TABLE "SecuritySettings" ADD COLUMN "minPasswordLength" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "SecuritySettings" ADD CONSTRAINT "SecuritySettings_minPasswordLength_range" CHECK ("minPasswordLength" BETWEEN 6 AND 128);
ALTER TABLE "Project" ADD COLUMN "minPasswordLength" INTEGER;
ALTER TABLE "Project" ADD CONSTRAINT "Project_minPasswordLength_range" CHECK ("minPasswordLength" IS NULL OR "minPasswordLength" BETWEEN 6 AND 128);
