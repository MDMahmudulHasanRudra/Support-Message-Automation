import type { TeamsClientConfig } from "./types.js";

/**
 * Reads the four Azure App Registration values documented in TEAMS_SETUP.md. Both apps/web (OAuth
 * connect/callback) and apps/worker (background sync/token-refresh) need the exact same config, so
 * it's read once here rather than duplicated — same reasoning as packages/db's encryptSecret
 * reading AI_CREDENTIALS_ENCRYPTION_KEY directly instead of requiring every caller to pass it in.
 */
export function loadTeamsClientConfigFromEnv(): TeamsClientConfig {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (!clientId || !clientSecret || !tenantId || !redirectUri) {
    throw new Error(
      "Microsoft Teams integration is not configured — set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, " +
        "MICROSOFT_TENANT_ID, and MICROSOFT_REDIRECT_URI (see TEAMS_SETUP.md).",
    );
  }
  return { clientId, clientSecret, tenantId, redirectUri };
}

/** True as soon as the four env vars exist — does NOT mean an account has completed OAuth consent
 * yet (see TeamsAccount.status for that). Used to short-circuit background jobs/UI before even
 * attempting a config load, so a not-yet-configured install logs one clear message, not a stack trace. */
export function isTeamsClientConfigured(): boolean {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID &&
      process.env.MICROSOFT_CLIENT_SECRET &&
      process.env.MICROSOFT_TENANT_ID &&
      process.env.MICROSOFT_REDIRECT_URI,
  );
}
