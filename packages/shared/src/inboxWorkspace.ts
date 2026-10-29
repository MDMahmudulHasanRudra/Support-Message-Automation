/**
 * Inbox workspace rules shared by the web app and the worker (INBOX_WORKSPACE.md): which
 * conversation a note / label / Copilot request is about, tag normalisation, mentions, and the
 * Copilot's rewrite instructions and assist-response format.
 */

/**
 * One conversation, whichever channel it is on. A WhatsApp chat is the (account, chat id) pair every
 * Message row carries — a group copy and a personal chat alike; a Messenger / Instagram / Telegram
 * conversation is its ChannelConversation row.
 */
export type ConversationRef =
  | { kind: "whatsapp"; accountId: string; chatId: string }
  | { kind: "channel"; conversationId: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A WhatsApp chat id with its domain. Status, newsletters and broadcast lists are never a conversation. */
const WHATSAPP_CHAT = /^[0-9A-Za-z._-]{3,64}@(g\.us|c\.us|lid)$/;

/** Validates a ref that arrived from the browser. Null when it is anything but a well-formed ref. */
export function parseConversationRef(value: unknown): ConversationRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "whatsapp" && typeof v.accountId === "string" && typeof v.chatId === "string") {
    if (!ID.test(v.accountId) || !WHATSAPP_CHAT.test(v.chatId)) return null;
    return { kind: "whatsapp", accountId: v.accountId, chatId: v.chatId };
  }
  if (v.kind === "channel" && typeof v.conversationId === "string") {
    if (!ID.test(v.conversationId)) return null;
    return { kind: "channel", conversationId: v.conversationId };
  }
  return null;
}

/** The columns a ref fills on ConversationLabel / ConversationNote / AiDraft (exactly one side). */
export function conversationRefColumns(ref: ConversationRef): {
  accountId: string | null;
  chatId: string | null;
  channelConversationId: string | null;
} {
  return ref.kind === "whatsapp"
    ? { accountId: ref.accountId, chatId: ref.chatId, channelConversationId: null }
    : { accountId: null, chatId: null, channelConversationId: ref.conversationId };
}

export const CONVERSATION_PRIORITIES = ["NONE", "LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type ConversationPriorityValue = (typeof CONVERSATION_PRIORITIES)[number];

export const CONVERSATION_PRIORITY_LABEL: Record<ConversationPriorityValue, string> = {
  NONE: "No priority",
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

export function isConversationPriority(value: unknown): value is ConversationPriorityValue {
  return typeof value === "string" && (CONVERSATION_PRIORITIES as readonly string[]).includes(value);
}

export const MAX_CONVERSATION_TAGS = 12;
export const MAX_TAG_LENGTH = 32;
export const MAX_NOTE_LENGTH = 4000;

/**
 * Tags as stored: lowercase, words joined by "-", letters (any script) / digits / "-" / "_" only,
 * unique, at most 12 of at most 32 characters. Order of first appearance is kept. A tag that is
 * empty after cleaning is dropped rather than stored as "".
 */
export function normaliseConversationTags(input: readonly string[] | string): string[] {
  const raw = typeof input === "string" ? input.split(",") : input;
  const out: string[] = [];
  for (const item of raw) {
    const tag = item
      .normalize("NFC")
      .toLowerCase()
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{M}\p{N}_-]/gu, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, MAX_TAG_LENGTH);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === MAX_CONVERSATION_TAGS) break;
  }
  return out;
}

/**
 * The users a note @mentions: `@username` tokens matched case-insensitively against the people who
 * may see the conversation. Anything else that starts with "@" (an email, a WhatsApp handle) is
 * just text.
 */
export function extractNoteMentions(body: string, users: readonly { id: string; username: string }[]): string[] {
  const byName = new Map(users.map((u) => [u.username.toLowerCase(), u.id]));
  const ids: string[] = [];
  for (const match of body.matchAll(/(^|[\s(])@([A-Za-z0-9._-]{2,64})/g)) {
    const id = byName.get(match[2]!.toLowerCase().replace(/[.]+$/, ""));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** What the agent can ask the Copilot to do with text they wrote or a draft it gave them. */
export const COPILOT_REWRITE_INSTRUCTIONS = {
  SHORTER: { label: "Shorter", prompt: "Make it shorter and more direct. Keep every fact and step." },
  LONGER: { label: "More detail", prompt: "Make it a little more complete and explanatory, without adding any fact that is not already in it." },
  FRIENDLIER: { label: "Friendlier", prompt: "Make it warmer and friendlier, still professional." },
  FORMAL: { label: "More formal", prompt: "Make it more formal and professional." },
  GRAMMAR: { label: "Fix grammar", prompt: "Correct spelling, grammar and punctuation only. Change nothing else." },
  TRANSLATE_EN: { label: "English", prompt: "Translate it into clear, natural English." },
  TRANSLATE_BN: { label: "বাংলা", prompt: "Translate it into natural Bengali written in Bengali script." },
  BANGLISH: { label: "Banglish", prompt: "Rewrite it in Banglish: Bengali language written in Latin letters." },
} as const;
export type CopilotRewriteInstruction = keyof typeof COPILOT_REWRITE_INSTRUCTIONS;

export function isCopilotRewriteInstruction(value: unknown): value is CopilotRewriteInstruction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COPILOT_REWRITE_INSTRUCTIONS, value);
}

export interface CopilotAssistResult {
  summary: string | null;
  intent: string | null;
  nextSteps: string[];
}

/**
 * Parses the Assist response format:
 *   SUMMARY: …            (one or more lines, until the next label)
 *   INTENT: …
 *   NEXT_STEPS:
 *   - …
 * Tolerant of bold markers and numbering; never throws. At most five steps of 200 characters.
 */
export function parseCopilotAssist(text: string): CopilotAssistResult {
  const result: CopilotAssistResult = { summary: null, intent: null, nextSteps: [] };
  type Section = "SUMMARY" | "INTENT" | "NEXT_STEPS";
  let section: Section | null = null;
  const summary: string[] = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.replace(/\*\*/g, "").trim();
    const label = /^(SUMMARY|INTENT|NEXT[_ ]STEPS)\s*:\s*(.*)$/i.exec(line);
    if (label) {
      section = label[1]!.toUpperCase().replace(" ", "_") as Section;
      const rest = label[2]!.trim();
      if (section === "SUMMARY" && rest) summary.push(rest);
      if (section === "INTENT" && rest) result.intent = rest.slice(0, 120);
      if (section === "NEXT_STEPS" && rest) addStep(result.nextSteps, rest);
      continue;
    }
    if (!line) continue;
    if (section === "SUMMARY") summary.push(line);
    else if (section === "NEXT_STEPS") addStep(result.nextSteps, line);
  }
  result.summary = summary.join(" ").slice(0, 1200) || null;
  return result;
}

function addStep(steps: string[], line: string): void {
  const step = line.replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim().slice(0, 200);
  if (step && steps.length < 5) steps.push(step);
}
