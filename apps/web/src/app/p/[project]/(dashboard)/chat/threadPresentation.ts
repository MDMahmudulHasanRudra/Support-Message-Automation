import { Bot, ListChecks, Megaphone, Settings2 } from "lucide-react";
import type { OutboundSenderType } from "@support-automation/shared";
import type { ThreadEntry } from "@/server/chatInbox";

/**
 * The presentation rules both conversation views share (MessageThread v1, v2/ in CHAT_UI_V2.md) — one
 * definition, so the two cannot disagree about what a queued state means, who wrote a reply, or where
 * one speaker's run of messages ends. Pure: usable from server and client components alike.
 */

export const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Dhaka",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Copy for each not-yet-settled outbound state, in the operator's terms rather than the enum's. */
export const QUEUED_LABEL: Record<string, { text: string; tone: "wait" | "bad" }> = {
  PENDING: { text: "Queued — waiting for the worker", tone: "wait" },
  PROCESSING: { text: "Sending…", tone: "wait" },
  RATE_LIMITED: { text: "Held back by the account rate limit", tone: "bad" },
  FAILED: { text: "Failed to send", tone: "bad" },
  CANCELLED: { text: "Cancelled", tone: "bad" },
  SKIPPED: { text: "Not sent", tone: "bad" },
  SENT: { text: "Sent — waiting for WhatsApp to confirm", tone: "wait" },
};

/**
 * Automated authorship, in the operator's terms. A person's send is named instead (the software user
 * who pressed send), so it has no badge here.
 */
export const AUTHOR_BADGE: Partial<Record<OutboundSenderType, { text: string; icon: typeof Bot }>> = {
  AI: { text: "AI", icon: Bot },
  RULE_AUTOMATION: { text: "Rule", icon: ListChecks },
  BROADCAST: { text: "Broadcast", icon: Megaphone },
  SYSTEM: { text: "Automated", icon: Settings2 },
};

/** Longer and the next message reads as a new thought rather than the same one continued. */
export const RUN_GAP_MS = 5 * 60_000;

/** Whether `next` continues `current` — same speaker, same side, close in time. */
export function continues(current: ThreadEntry, next: ThreadEntry): boolean {
  if (current.kind === "SYSTEM" || next.kind === "SYSTEM") return false;

  const currentOutbound = current.kind === "OUTGOING" || current.kind === "QUEUED";
  const nextOutbound = next.kind === "OUTGOING" || next.kind === "QUEUED";
  if (currentOutbound !== nextOutbound) return false;

  // Inbound runs also need the same person: a group has many speakers, and merging two of them
  // into one run would attribute somebody's message to whoever spoke above them.
  if (!nextOutbound && (current.senderPhone ?? null) !== (next.senderPhone ?? null)) return false;

  // Outbound runs need the same author — and, for people, the same person — so an AI reply never
  // merges into a person's, and Hasan's reply never appears under Rudra's name.
  if (nextOutbound && (current.authoredBy ?? null) !== (next.authoredBy ?? null)) return false;
  if (nextOutbound && (current.sentBy?.id ?? null) !== (next.sentBy?.id ?? null)) return false;

  return next.at.getTime() - current.at.getTime() <= RUN_GAP_MS;
}
