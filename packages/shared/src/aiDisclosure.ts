/**
 * Saying that an AI reply is automated: Facebook Messenger and Instagram DM ONLY
 * (docs/meta-integration/08-ai-disclosure.md).
 *
 * Meta's Messenger Platform policy: where required by law (it names California and Germany),
 * automated chats must disclose that they are automated at the start of a conversation, after a
 * significant lapse of time, and when a person hands the conversation back to automation. Meta gives
 * no number for "a significant lapse of time"; `idleHours` is the connection's own choice (default 24,
 * 0 for never), not a Meta requirement. This is the one rule for WHEN a reply carries the disclosure;
 * only the worker's Meta channel AI path calls it.
 *
 * Pure and side-effect free: nothing here can reach WhatsApp, Telegram or any other AI module.
 */

/** Built-in wording, used while a connection has none of its own. */
export const DEFAULT_AI_DISCLOSURE_TEXT = "This is an automated reply. Someone from our team can join the conversation at any time.";

/** The default quiet spell after which the next AI reply discloses again. A product default, not Meta's. */
export const DEFAULT_AI_DISCLOSURE_IDLE_HOURS = 24;
/** The longest quiet spell a connection may choose (30 days). 0 turns the quiet-spell rule off. */
export const MAX_AI_DISCLOSURE_IDLE_HOURS = 720;

/** The only channels the disclosure applies to: Meta's Messenger Platform. */
export function isAiDisclosureChannel(type: string): type is "MESSENGER" | "INSTAGRAM" {
  return type === "MESSENGER" || type === "INSTAGRAM";
}

export const AI_DISCLOSURE_TEXT_MAX = 300;

export type AiDisclosureReason =
  /** No AI reply in this conversation has disclosed yet. */
  | "FIRST"
  /** A person replied after the last disclosure; automation is taking over again. */
  | "AFTER_HUMAN"
  /** The conversation was quiet for the connection's `idleHours` or more before this message. */
  | "AFTER_IDLE";

export interface AiDisclosureInput {
  enabled: boolean;
  /** When the last disclosing AI reply in this conversation was written (one that was not FAILED), or null. */
  lastDisclosedAt: Date | null;
  /** Whether a person (an agent here, or the business in Meta Business Suite) replied after that disclosure. */
  humanRepliedSince: boolean;
  /** The conversation's previous message before the one being answered, or null when there is none. */
  previousMessageAt: Date | null;
  /** When the message being answered arrived. */
  answeringAt: Date;
  /** The connection's quiet-spell setting, in hours; 0 means the quiet-spell rule is off. */
  idleHours: number;
}

export function decideAiDisclosure(input: AiDisclosureInput): AiDisclosureReason | null {
  if (!input.enabled) return null;
  if (!input.lastDisclosedAt) return "FIRST";
  if (input.humanRepliedSince) return "AFTER_HUMAN";
  if (input.idleHours > 0 && input.previousMessageAt && input.answeringAt.getTime() - input.previousMessageAt.getTime() >= input.idleHours * 3_600_000) return "AFTER_IDLE";
  return null;
}

/** The connection's own wording, or the built-in one. */
export function aiDisclosureText(custom: string | null | undefined): string {
  const text = custom?.trim();
  return text ? text : DEFAULT_AI_DISCLOSURE_TEXT;
}

/** The reply as sent: the disclosure on its own line above the answer. */
export function withAiDisclosure(disclosure: string, reply: string): string {
  return `${disclosure}\n\n${reply}`;
}

/** Why a quiet-spell setting cannot be saved, or null. */
export function validateAiDisclosureIdleHours(hours: number): string | null {
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_AI_DISCLOSURE_IDLE_HOURS) return `Choose a whole number of hours from 0 (never) to ${MAX_AI_DISCLOSURE_IDLE_HOURS}.`;
  return null;
}

/** Why a custom disclosure cannot be saved, or null. Empty means "use the built-in wording". */
export function validateAiDisclosureText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > AI_DISCLOSURE_TEXT_MAX) return `Keep the disclosure under ${AI_DISCLOSURE_TEXT_MAX} characters.`;
  return null;
}
