import type { ForgeClientConfig } from "./types.js";

/**
 * Reads the two Forge values from the environment once, here, rather than duplicated in every
 * caller.
 *
 * `.env` on Windows is routinely saved with CRLF, and a trailing `\r` on a URL produces a request
 * to a host that does not exist and an error that names neither the file nor the cause. Trimming
 * is cheap insurance against an afternoon of confusion — this exact thing happened while building
 * the integration.
 */
export function loadForgeConfigFromEnv(): ForgeClientConfig {
  const apiKey = process.env.FORGE_API_KEY?.trim();
  const apiUrl = process.env.FORGE_API_URL?.trim();
  if (!apiKey || !apiUrl) {
    throw new Error(
      "Forge is not configured — set FORGE_API_KEY and FORGE_API_URL (see FORGE_SETUP.md).",
    );
  }
  return { apiKey, apiUrl: apiUrl.replace(/\/+$/, "") };
}

/**
 * True as soon as both env vars exist. Does NOT mean the key is valid or in scope for any
 * project — call `getIdentity()` for that. Used to short-circuit background jobs and UI so an
 * install that never configured Forge logs one clear line instead of failing per tick.
 */
export function isForgeConfigured(): boolean {
  return Boolean(process.env.FORGE_API_KEY?.trim() && process.env.FORGE_API_URL?.trim());
}
