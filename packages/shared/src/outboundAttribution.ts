import { formatDhakaDateKey } from "./dhakaDay.js";

/**
 * Who an outgoing WhatsApp message came from (WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md §10 N).
 *
 * Two different questions, answered by two different columns of `OutboundMessage`, and both are kept:
 *   - WHICH NUMBER sent it — `accountId`, the WhatsApp account;
 *   - WHO pressed send — `createdById`, the authenticated software user, written server-side from
 *     the session (never from the browser) by the chat composer, the template test and broadcasts.
 *
 * The sender type is DERIVED from what the row already records, never stored a second time, and this
 * is the one function that derives it — the conversation's attribution line and the User Activity
 * report both call it, so the screen and the report cannot disagree.
 */
export const OUTBOUND_SENDER_TYPES = ["HUMAN_USER", "BROADCAST", "AI", "RULE_AUTOMATION", "SYSTEM"] as const;
export type OutboundSenderType = (typeof OUTBOUND_SENDER_TYPES)[number];

export const OUTBOUND_SENDER_TYPE_LABELS: Record<OutboundSenderType, string> = {
  HUMAN_USER: "Human user",
  BROADCAST: "Broadcast",
  AI: "AI",
  RULE_AUTOMATION: "Rule automation",
  SYSTEM: "System",
};

/** Where a HUMAN_USER message was written. */
export type HumanSendSource = "CHAT" | "TEMPLATE_TEST";

export const HUMAN_SEND_SOURCE_LABELS: Record<HumanSendSource, string> = {
  CHAT: "Chat reply",
  TEMPLATE_TEST: "Template test",
};

/** The idempotency-key prefix the template test send writes (server/actions/notificationTemplates.ts). */
export const TEMPLATE_TEST_KEY_PREFIX = "template-test:";

export interface OutboundAttributionInput {
  actionType: string;
  ruleId: string | null;
  /** True when an AI fallback decision owns this send — the AI's own reply. */
  hasAiDecision: boolean;
  idempotencyKey?: string | null;
}

export interface OutboundAttribution {
  senderType: OutboundSenderType;
  /** Only for HUMAN_USER. */
  source: HumanSendSource | null;
}

/**
 * - MANUAL_REPLY is only ever written by an authenticated person pressing send (the chat composer or
 *   a template test) → HUMAN_USER.
 * - GROUP_BROADCAST is a person's confirmed bulk job → BROADCAST: a person started it, but it is not
 *   a reply in a conversation, so it never counts as one.
 * - An AI fallback decision → AI; a rule → RULE_AUTOMATION.
 * - Anything else automated (the AI handover mention, the "could not understand" holding reply) →
 *   SYSTEM. These used to show as a person's message in the thread for want of a label.
 */
export function attributeOutbound(row: OutboundAttributionInput): OutboundAttribution {
  if (row.actionType === "MANUAL_REPLY") {
    return { senderType: "HUMAN_USER", source: row.idempotencyKey?.startsWith(TEMPLATE_TEST_KEY_PREFIX) ? "TEMPLATE_TEST" : "CHAT" };
  }
  if (row.actionType === "GROUP_BROADCAST") return { senderType: "BROADCAST", source: null };
  if (row.hasAiDecision) return { senderType: "AI", source: null };
  if (row.ruleId) return { senderType: "RULE_AUTOMATION", source: null };
  return { senderType: "SYSTEM", source: null };
}

export function isOutboundSenderType(value: string | null | undefined): value is OutboundSenderType {
  return (OUTBOUND_SENDER_TYPES as readonly string[]).includes(value ?? "");
}

/**
 * Estimated active time of one person from the moments they sent something: their sends, split
 * wherever they went quiet longer than `gapMs` or crossed Dhaka midnight, each stretch measured first
 * send to last. The same idle-gap rule Team Performance and the Team Report use for presence. One
 * send is zero seconds — honest rather than flattering; the count beside it says they worked.
 */
export function activeSendSeconds(timestamps: readonly number[], gapMs: number): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - prev > gapMs || formatDhakaDateKey(new Date(t)) !== formatDhakaDateKey(new Date(prev))) {
      total += prev - start;
      start = t;
    }
    prev = t;
  }
  total += prev - start;
  return Math.round(total / 1000);
}
