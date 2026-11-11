-- Every module switched on in every project (the owner's decision, 11 Nov 2026). Additive: nothing is
-- deleted and every module's own settings stay as they were, so a module that needs setup shows its setup
-- screen. Each project whose modules change gets a history entry and a new module configuration version,
-- exactly as a Module Builder save would.

CREATE TEMP TABLE _modules_before ON COMMIT DROP AS
SELECT
  p.id,
  p."moduleConfigVersion" AS version,
  p."projectType" AS project_type,
  p."projectBaseType" AS project_base_type,
  COALESCE(
    (
      SELECT array_agg(k ORDER BY k)
      FROM unnest(ARRAY['WHATSAPP_CHAT', 'AI_REPLY', 'AI_LEARNING', 'CONVERSATION_LEARNING', 'TEAM_MANAGEMENT', 'TEAM_REPORTS', 'BULK_MESSAGING', 'ESCALATIONS', 'SUPPORT_ASSIGNMENT', 'SUPPORT_ACTIVITY', 'PRODUCT_KNOWLEDGE_FORGE', 'GOOGLE_SHEETS', 'OMNICHANNEL', 'CLIENT_CENTER', 'CHAT_UI_V2', 'UNIFIED_REPORTING', 'WHATSAPP_AVATARS', 'CLIENT_SMART_IMPORT', 'INBOX_COLLABORATION', 'AI_COPILOT', 'UNIFIED_INBOX_V3', 'CSAT_SURVEYS', 'AUTO_ROUTING', 'PRODUCT_CATALOG', 'ORDERS', 'SALES_PIPELINE', 'COURIER', 'WOOCOMMERCE', 'SHOPIFY', 'API_ACCESS', 'SOCIAL_STUDIO', 'WHATSAPP_OFFICIAL', 'PAYMENT_LINKS', 'MENU_BOTS', 'CONTACTS', 'TICKETS', 'FOLLOW_UPS']::text[]) AS k
      WHERE COALESCE(
        (SELECT f.enabled FROM "ProjectFeature" f WHERE f."projectId" = p.id AND f.key = k),
        k = ANY (ARRAY['WHATSAPP_CHAT', 'AI_REPLY', 'AI_LEARNING', 'CONVERSATION_LEARNING', 'TEAM_MANAGEMENT', 'TEAM_REPORTS', 'BULK_MESSAGING', 'ESCALATIONS', 'SUPPORT_ASSIGNMENT', 'SUPPORT_ACTIVITY', 'PRODUCT_KNOWLEDGE_FORGE', 'UNIFIED_REPORTING', 'MENU_BOTS', 'CONTACTS', 'TICKETS']::text[])
      )
    ),
    '{}'
  ) AS previous
FROM "Project" p;

INSERT INTO "ProjectModuleConfigChange" (id, "projectId", version, "projectType", "projectBaseType", "previousModules", modules, "autoAdded", declined, reason, "actorUsername", "createdAt")
SELECT
  'mc' || replace(gen_random_uuid()::text, '-', ''),
  b.id,
  b.version + 1,
  b.project_type,
  b.project_base_type,
  b.previous,
  (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY['WHATSAPP_CHAT', 'AI_REPLY', 'AI_LEARNING', 'CONVERSATION_LEARNING', 'TEAM_MANAGEMENT', 'TEAM_REPORTS', 'BULK_MESSAGING', 'ESCALATIONS', 'SUPPORT_ASSIGNMENT', 'SUPPORT_ACTIVITY', 'PRODUCT_KNOWLEDGE_FORGE', 'GOOGLE_SHEETS', 'OMNICHANNEL', 'CLIENT_CENTER', 'CHAT_UI_V2', 'UNIFIED_REPORTING', 'WHATSAPP_AVATARS', 'CLIENT_SMART_IMPORT', 'INBOX_COLLABORATION', 'AI_COPILOT', 'UNIFIED_INBOX_V3', 'CSAT_SURVEYS', 'AUTO_ROUTING', 'PRODUCT_CATALOG', 'ORDERS', 'SALES_PIPELINE', 'COURIER', 'WOOCOMMERCE', 'SHOPIFY', 'API_ACCESS', 'SOCIAL_STUDIO', 'WHATSAPP_OFFICIAL', 'PAYMENT_LINKS', 'MENU_BOTS', 'CONTACTS', 'TICKETS', 'FOLLOW_UPS']::text[]) AS k),
  '{}',
  '{}',
  'Every module switched on (owner''s decision, 11 Nov 2026)',
  'system',
  now()
FROM _modules_before b
WHERE cardinality(b.previous) < 37;

UPDATE "Project" p
SET "moduleConfigVersion" = b.version + 1
FROM _modules_before b
WHERE b.id = p.id AND cardinality(b.previous) < 37;

INSERT INTO "ProjectFeature" (id, "projectId", key, enabled, "updatedAt")
SELECT 'pf' || replace(gen_random_uuid()::text, '-', ''), p.id, k, true, now()
FROM "Project" p CROSS JOIN unnest(ARRAY['WHATSAPP_CHAT', 'AI_REPLY', 'AI_LEARNING', 'CONVERSATION_LEARNING', 'TEAM_MANAGEMENT', 'TEAM_REPORTS', 'BULK_MESSAGING', 'ESCALATIONS', 'SUPPORT_ASSIGNMENT', 'SUPPORT_ACTIVITY', 'PRODUCT_KNOWLEDGE_FORGE', 'GOOGLE_SHEETS', 'OMNICHANNEL', 'CLIENT_CENTER', 'CHAT_UI_V2', 'UNIFIED_REPORTING', 'WHATSAPP_AVATARS', 'CLIENT_SMART_IMPORT', 'INBOX_COLLABORATION', 'AI_COPILOT', 'UNIFIED_INBOX_V3', 'CSAT_SURVEYS', 'AUTO_ROUTING', 'PRODUCT_CATALOG', 'ORDERS', 'SALES_PIPELINE', 'COURIER', 'WOOCOMMERCE', 'SHOPIFY', 'API_ACCESS', 'SOCIAL_STUDIO', 'WHATSAPP_OFFICIAL', 'PAYMENT_LINKS', 'MENU_BOTS', 'CONTACTS', 'TICKETS', 'FOLLOW_UPS']::text[]) AS k
ON CONFLICT ("projectId", key) DO UPDATE SET enabled = true, "updatedAt" = now() WHERE "ProjectFeature".enabled = false;
