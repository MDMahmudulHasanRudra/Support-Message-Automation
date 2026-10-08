-- Per-group testing mode: exempts an approved test group from the anti-spam throttles (cooldowns,
-- per-client limits, global rate limits, reply delay) so every message and rule type can be
-- exercised back-to-back. Never bypasses the kill switch, monitored-group requirement, membership
-- verification, queue, idempotency or loop prevention.
ALTER TABLE "WhatsAppGroup" ADD COLUMN IF NOT EXISTS "testModeEnabled" BOOLEAN NOT NULL DEFAULT false;
