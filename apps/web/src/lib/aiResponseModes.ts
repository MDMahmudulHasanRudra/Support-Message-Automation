import type { AiResponseMode } from "@prisma/client";

/**
 * The response modes, in the order the settings page lists them: safest first.
 *
 * Kept beside the UI rather than inline in the server action, because the action needs to validate
 * against exactly the same list the dropdown offers. When those two drifted — the dropdown gained
 * two modes and the action still recognised the original pair — choosing either new mode saved
 * silently as STRICT_KNOWLEDGE_ONLY, and the page looked like it had simply ignored the change.
 */
export const AI_RESPONSE_MODES = [
  "STRICT_KNOWLEDGE_ONLY",
  "KNOWLEDGE_PLUS_FORGE",
  "KNOWLEDGE_PLUS_GENERAL",
  "KNOWLEDGE_FORGE_GENERAL",
] as const satisfies readonly AiResponseMode[];

export function isAiResponseMode(value: string): value is AiResponseMode {
  return (AI_RESPONSE_MODES as readonly string[]).includes(value);
}
