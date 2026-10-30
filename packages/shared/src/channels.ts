/**
 * Messaging channels beyond WhatsApp — Facebook Messenger, Instagram DM and Telegram (OMNICHANNEL.md).
 *
 * Everything here is pure: the catalogue, what each provider allows, how a provider's webhook body
 * becomes events, and how a provider's error is read. The web (webhook ingest, sending checks, the
 * inbox) and the worker (event processing, the send queue, AI replies) both call these, so the two
 * apps can never disagree about what a Messenger echo is or when Instagram's reply window closes.
 *
 * WhatsApp is deliberately NOT a member of `ChannelType`. Its messages live in `Message` /
 * `WhatsAppGroup` and its sending in `OutboundMessage`, with forty-odd readers that assume WhatsApp
 * semantics; the unified inbox reads it from there instead of copying it (see OMNICHANNEL.md §4).
 */

export const CHANNEL_TYPES = ["MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBCHAT"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value);
}

/** Which webhook dialect a channel speaks. Messenger and Instagram share Meta's. */
export type ChannelWebhookKind = "META" | "TELEGRAM" | "WEBCHAT";

export interface ChannelDefinition {
  type: ChannelType;
  label: string;
  /** The URL segment of its inbox (`/conversations/<slug>`). */
  slug: string;
  webhookKind: ChannelWebhookKind;
  /** The provider's limit on one text message. Instagram counts BYTES, the others characters. */
  maxText: number;
  maxTextUnit: "characters" | "bytes";
  /** Whether the provider reports delivery / read at all. Telegram reports neither for bots. */
  deliveryReceipts: boolean;
  readReceipts: boolean;
  /** Meta's messaging window. Telegram has none: a bot may answer anyone who wrote to it. */
  replyWindow: { standardHours: number; humanAgentDays: number } | null;
  /** What the provider calls the account a connection is for. */
  accountNoun: string;
  /** Plain-language limits, shown on the settings page so nobody expects what cannot work. */
  limitations: readonly string[];
}

export const CHANNELS: Record<ChannelType, ChannelDefinition> = {
  MESSENGER: {
    type: "MESSENGER",
    label: "Facebook Messenger",
    slug: "messenger",
    webhookKind: "META",
    maxText: 2000,
    maxTextUnit: "characters",
    deliveryReceipts: true,
    readReceipts: true,
    replyWindow: { standardHours: 24, humanAgentDays: 7 },
    accountNoun: "Facebook Page",
    limitations: [
      "A conversation can only be started by the customer. The Page cannot message someone who never wrote to it.",
      "Replies are allowed for 24 hours after the customer's last message. A person (never AI) may reply for up to 7 days only when the Human Agent permission is approved for your Meta app and switched on here.",
      "Messages from before the connection are not imported.",
      "Attachments sent by customers are shown as links. Sending attachments is not supported yet.",
    ],
  },
  INSTAGRAM: {
    type: "INSTAGRAM",
    label: "Instagram DM",
    slug: "instagram",
    webhookKind: "META",
    maxText: 1000,
    maxTextUnit: "bytes",
    deliveryReceipts: false,
    readReceipts: true,
    replyWindow: { standardHours: 24, humanAgentDays: 7 },
    accountNoun: "Instagram professional account (linked to a Facebook Page)",
    limitations: [
      "Only Instagram professional (Business or Creator) accounts linked to a Facebook Page are supported. Personal accounts cannot be connected.",
      "\"Allow access to messages\" must be on in the Instagram app (Settings → Messages and story replies → Message controls → Connected tools).",
      "A conversation can only be started by the customer. Replies are allowed for 24 hours after their last message; a person may reply for up to 7 days only with the Human Agent permission.",
      "Messages from before the connection are not imported. Attachments are shown as links.",
    ],
  },
  TELEGRAM: {
    type: "TELEGRAM",
    label: "Telegram",
    slug: "telegram",
    webhookKind: "TELEGRAM",
    maxText: 4096,
    maxTextUnit: "characters",
    deliveryReceipts: false,
    readReceipts: false,
    replyWindow: null,
    accountNoun: "Telegram bot",
    limitations: [
      "This is a Telegram BOT, not a personal Telegram account. Customers message the bot; it cannot read anybody's private chats.",
      "A bot can only message people who started a chat with it first.",
      "In groups, a bot sees every message only when its privacy mode is off (BotFather → /setprivacy); otherwise only commands and replies to it.",
      "Telegram tells bots nothing about delivery or reading, so a reply shows as Sent, never Delivered or Read.",
    ],
  },
  WEBCHAT: {
    type: "WEBCHAT",
    label: "Website chat",
    slug: "website",
    webhookKind: "WEBCHAT",
    maxText: 2000,
    maxTextUnit: "characters",
    deliveryReceipts: false,
    readReceipts: false,
    replyWindow: null,
    accountNoun: "chat widget on your website",
    limitations: [
      "The widget works only on the websites you list (a domain like example.com is enough). Every other site is refused.",
      "Visitors are anonymous unless your site signs their user id with this widget's identity secret; a name or email they type is shown as unverified.",
      "A reply shows as Sent once it is stored; the visitor sees it the next time their widget checks (every few seconds while it is open).",
      "Visitors and your team can send photos (JPEG, PNG, WebP, up to 10 MB). Videos and other files are not accepted.",
      "AI answers only when you switch it on for the widget, and hands every photo to a person.",
    ],
  },
};

export function channelDefinition(type: ChannelType): ChannelDefinition {
  return CHANNELS[type];
}

export function channelBySlug(slug: string): ChannelType | null {
  return CHANNEL_TYPES.find((t) => CHANNELS[t].slug === slug) ?? null;
}

/**
 * Channels considered and not built, with the reason in the user's terms. Shown on the channel
 * settings page as unavailable — never as a working inbox.
 */
export const UNAVAILABLE_CHANNELS = [
  {
    key: "TIKTOK",
    label: "TikTok",
    reason:
      "TikTok's Business Messaging API is in limited beta: it needs approval from TikTok, is not offered in every region (several providers report the United States, the EEA, Switzerland and the UK excluded), and conversations must be started by the customer. It can be added once a TikTok Business account here has API access.",
  },
] as const;

// ─── Inbox scopes ──────────────────────────────────────────────────────────────────────────────

/** The inbox views: every channel together, WhatsApp, or one of the channels above. */
export const INBOX_SCOPES = ["all", "whatsapp", ...CHANNEL_TYPES.map((t) => CHANNELS[t].slug)] as const;
export type InboxScope = "all" | "whatsapp" | "messenger" | "instagram" | "telegram" | "website";

export function isInboxScope(value: unknown): value is InboxScope {
  return typeof value === "string" && (INBOX_SCOPES as readonly string[]).includes(value);
}

export function inboxScopeLabel(scope: InboxScope): string {
  if (scope === "all") return "All conversations";
  if (scope === "whatsapp") return "WhatsApp";
  return CHANNELS[channelBySlug(scope)!].label;
}

// ─── Text and the reply window ─────────────────────────────────────────────────────────────────

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Why this text cannot be sent on this channel, or null when it can. */
export function validateChannelText(type: ChannelType, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Type a message first.";
  const def = CHANNELS[type];
  const size = def.maxTextUnit === "bytes" ? utf8Length(trimmed) : [...trimmed].length;
  if (size > def.maxText) {
    return def.maxTextUnit === "bytes"
      ? `${def.label} accepts at most ${def.maxText} bytes in one message (Bangla letters take about 3 bytes each). This one is ${size}. Split it into shorter messages.`
      : `${def.label} accepts at most ${def.maxText} characters in one message. This one is ${size}. Split it into shorter messages.`;
  }
  return null;
}

export type ReplyWindowDecision =
  | { allowed: true; messagingType: "RESPONSE" | "MESSAGE_TAG" | null; tag: "HUMAN_AGENT" | null }
  | { allowed: false; code: "NO_CUSTOMER_MESSAGE" | "WINDOW_CLOSED" | "HUMAN_AGENT_OFF" | "AUTOMATED_OUTSIDE_WINDOW"; reason: string };

const HOUR_MS = 60 * 60_000;

/**
 * Whether a reply may be sent now, and how Meta must be told it is being sent.
 *
 * Meta: within 24 hours of the customer's last message any reply is a RESPONSE. Between 24 hours and
 * 7 days only a PERSON may reply, tagged HUMAN_AGENT, and only when the app has that permission
 * (the connection's switch records that the admin says it has). Automated replies — AI — never use
 * the tag: Meta's policy reserves it for people. Past 7 days nothing may be sent.
 *
 * Telegram has no window; the only rule is that the customer wrote first, which every conversation
 * here satisfies because conversations are only ever created from an incoming message.
 */
export function decideReplyWindow(input: {
  type: ChannelType;
  lastInboundAt: Date | null;
  now: Date;
  humanAgentEnabled: boolean;
  automated: boolean;
}): ReplyWindowDecision {
  const def = CHANNELS[input.type];
  if (!input.lastInboundAt) {
    return { allowed: false, code: "NO_CUSTOMER_MESSAGE", reason: `${def.label} only allows replies to somebody who has messaged you. This customer has not written yet.` };
  }
  if (!def.replyWindow) return { allowed: true, messagingType: null, tag: null };
  const age = input.now.getTime() - input.lastInboundAt.getTime();
  if (age <= def.replyWindow.standardHours * HOUR_MS) return { allowed: true, messagingType: "RESPONSE", tag: null };
  const humanLimit = def.replyWindow.humanAgentDays * 24 * HOUR_MS;
  if (input.automated) {
    return { allowed: false, code: "AUTOMATED_OUTSIDE_WINDOW", reason: `The customer's last message is more than ${def.replyWindow.standardHours} hours old, so ${def.label} does not allow an automated reply.` };
  }
  if (age > humanLimit) {
    return { allowed: false, code: "WINDOW_CLOSED", reason: `The customer's last message is more than ${def.replyWindow.humanAgentDays} days old, so ${def.label} no longer allows a reply. They need to message you again first.` };
  }
  if (!input.humanAgentEnabled) {
    return {
      allowed: false,
      code: "HUMAN_AGENT_OFF",
      reason: `The customer's last message is more than ${def.replyWindow.standardHours} hours old. ${def.label} allows a person to reply for up to ${def.replyWindow.humanAgentDays} days only with Meta's Human Agent permission — switch it on for this connection under Settings → Messaging Channels once Meta has approved it.`,
    };
  }
  return { allowed: true, messagingType: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
}

// ─── Normalized events ─────────────────────────────────────────────────────────────────────────

export const CHANNEL_CONTENT_TYPES = ["TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE", "STICKER", "LOCATION", "CONTACT", "SHARE", "UNSUPPORTED"] as const;
export type ChannelContentType = (typeof CHANNEL_CONTENT_TYPES)[number];

/** What is kept about an attachment: its kind and the provider's own reference. Never the bytes. */
export interface ChannelAttachment {
  type: ChannelContentType;
  /** An http(s) link the provider gave (Meta's CDN links expire). */
  url?: string;
  /** Telegram's file id — fetchable through the Bot API with the bot's token, never a public link. */
  fileId?: string;
  name?: string;
  /** Website chat: the file a visitor uploaded, on the media volume (served only to the project's agents). */
  storageKey?: string;
  mimeType?: string;
  size?: number;
}

export type NormalizedChannelEvent =
  | {
      type: "MESSAGE";
      /** INBOUND from a customer, OUTBOUND an echo of something the business account sent. */
      direction: "INBOUND" | "OUTBOUND";
      externalMessageId: string;
      /** The conversation key: the customer's scoped id (Meta) or the chat id (Telegram). */
      threadId: string;
      threadKind: "DIRECT" | "GROUP";
      threadTitle: string | null;
      senderExternalId: string;
      senderName: string | null;
      senderUsername: string | null;
      /** A bot or automated sender — never answered by AI, whatever else is true. */
      senderIsBot: boolean;
      occurredAt: Date;
      text: string | null;
      contentType: ChannelContentType;
      attachments: ChannelAttachment[];
      /** Meta echoes: the app that sent it (absent when a person used the Page inbox or the app). */
      appId: string | null;
      /** Meta echoes: what we put in `message.metadata` when sending (our own message id). */
      metadata: string | null;
      /** The message this one replies to, as the provider gave it. */
      replyToExternalId: string | null;
    }
  | { type: "DELIVERY"; threadId: string; externalMessageIds: string[]; watermark: Date | null }
  | { type: "READ"; threadId: string; watermark: Date | null; externalMessageId: string | null }
  | { type: "IGNORED"; reason: string };

/** One event cut out of a webhook body, with the key that makes a provider's retry harmless. */
export interface SplitWebhookEvent {
  /** The business account the event is for (Meta `entry.id`; the bot for Telegram — filled by the caller). */
  accountId: string | null;
  dedupKey: string;
  occurredAt: Date;
  item: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function safeHttpUrl(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Meta timestamps are milliseconds; a missing or absurd one falls back to the receive time. */
function metaTime(value: unknown, fallback: Date): Date {
  const n = num(value);
  if (n === null || n <= 0) return fallback;
  return new Date(n < 1e12 ? n * 1000 : n);
}

const META_OBJECT: Record<"MESSENGER" | "INSTAGRAM", string> = { MESSENGER: "page", INSTAGRAM: "instagram" };

/**
 * A Meta webhook body (Messenger or Instagram) cut into one event per `messaging` item, each with a
 * dedup key: the message id for a message or echo, the watermark for a delivery or read. Meta
 * retries a body it did not see acknowledged, and batches several events into one body, so dedup is
 * per event, not per body. Null when the body is not for this channel at all.
 */
export function splitMetaWebhook(body: unknown, type: "MESSENGER" | "INSTAGRAM", receivedAt: Date): SplitWebhookEvent[] | null {
  if (!isObj(body) || body.object !== META_OBJECT[type] || !Array.isArray(body.entry)) return null;
  const out: SplitWebhookEvent[] = [];
  for (const entry of body.entry) {
    if (!isObj(entry)) continue;
    const accountId = str(entry.id);
    const items = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const item of items) {
      if (!isObj(item)) continue;
      const occurredAt = metaTime(item.timestamp, receivedAt);
      out.push({ accountId, dedupKey: metaDedupKey(item, occurredAt), occurredAt, item });
    }
  }
  return out;
}

function metaDedupKey(item: Obj, occurredAt: Date): string {
  const sender = isObj(item.sender) ? str(item.sender.id) : null;
  const recipient = isObj(item.recipient) ? str(item.recipient.id) : null;
  if (isObj(item.message) && str(item.message.mid)) return `msg:${str(item.message.mid)}`;
  if (isObj(item.delivery)) {
    const mids = Array.isArray(item.delivery.mids) ? item.delivery.mids.filter((m) => typeof m === "string").sort().join(",") : "";
    return `delivery:${sender}:${num(item.delivery.watermark) ?? ""}:${mids}`.slice(0, 500);
  }
  if (isObj(item.read)) return `read:${sender}:${num(item.read.watermark) ?? str(item.read.mid) ?? ""}`;
  // Anything else (a postback, a reaction, an edit): keyed on who, to whom, when and what kind, so a
  // retry of the same body is still recognised. These are recorded and ignored.
  const kind = Object.keys(item).filter((k) => !["sender", "recipient", "timestamp"].includes(k)).sort().join("+") || "unknown";
  return `other:${kind}:${sender}:${recipient}:${occurredAt.getTime()}`.slice(0, 500);
}

const META_ATTACHMENT_TYPE: Record<string, ChannelContentType> = {
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
  file: "FILE",
  location: "LOCATION",
  share: "SHARE",
  story_mention: "SHARE",
  ig_reel: "SHARE",
  reel: "SHARE",
  ig_post: "SHARE",
  template: "SHARE",
  fallback: "SHARE",
};

/**
 * One Meta `messaging` item, read. `businessAccountId` is the Page (Messenger) or the Instagram
 * account (Instagram) the connection is for — it decides which side of a message is the customer,
 * because an echo's sender is the business and its recipient is the customer.
 */
export function normalizeMetaEvent(item: unknown, businessAccountId: string, receivedAt: Date): NormalizedChannelEvent {
  if (!isObj(item)) return { type: "IGNORED", reason: "not an object" };
  const sender = isObj(item.sender) ? str(item.sender.id) : null;
  const recipient = isObj(item.recipient) ? str(item.recipient.id) : null;
  const occurredAt = metaTime(item.timestamp, receivedAt);

  if (isObj(item.message)) {
    const message = item.message;
    const mid = str(message.mid);
    if (!mid) return { type: "IGNORED", reason: "message without an id" };
    if (message.is_deleted === true) return { type: "IGNORED", reason: "the customer unsent a message" };
    const isEcho = message.is_echo === true || (sender !== null && sender === businessAccountId);
    const threadId = isEcho ? recipient : sender;
    if (!threadId || !sender) return { type: "IGNORED", reason: "message without a sender or recipient" };

    const attachments: ChannelAttachment[] = [];
    if (Array.isArray(message.attachments)) {
      for (const a of message.attachments) {
        if (!isObj(a)) continue;
        const payload = isObj(a.payload) ? a.payload : {};
        const t = str(a.type) ?? "";
        const isSticker = payload.sticker_id !== undefined;
        attachments.push({
          type: isSticker ? "STICKER" : (META_ATTACHMENT_TYPE[t] ?? "UNSUPPORTED"),
          url: safeHttpUrl(payload.url),
          name: str(payload.title) ?? str(a.title) ?? undefined,
        });
      }
    }
    const text = str(message.text);
    const contentType: ChannelContentType =
      message.is_unsupported === true ? "UNSUPPORTED" : text ? "TEXT" : (attachments[0]?.type ?? "UNSUPPORTED");
    const replyTo = isObj(message.reply_to) ? str(message.reply_to.mid) : null;

    return {
      type: "MESSAGE",
      direction: isEcho ? "OUTBOUND" : "INBOUND",
      externalMessageId: mid,
      threadId,
      threadKind: "DIRECT",
      threadTitle: null,
      senderExternalId: sender,
      senderName: null,
      senderUsername: null,
      senderIsBot: false,
      occurredAt,
      text,
      contentType,
      attachments,
      appId: str(message.app_id),
      metadata: str(message.metadata),
      replyToExternalId: replyTo,
    };
  }

  if (isObj(item.delivery)) {
    if (!sender) return { type: "IGNORED", reason: "delivery without a sender" };
    const mids = Array.isArray(item.delivery.mids) ? item.delivery.mids.filter((m): m is string => typeof m === "string") : [];
    const watermark = num(item.delivery.watermark);
    return { type: "DELIVERY", threadId: sender, externalMessageIds: mids, watermark: watermark ? metaTime(watermark, receivedAt) : null };
  }

  if (isObj(item.read)) {
    if (!sender) return { type: "IGNORED", reason: "read receipt without a sender" };
    const watermark = num(item.read.watermark);
    return { type: "READ", threadId: sender, watermark: watermark ? metaTime(watermark, receivedAt) : null, externalMessageId: str(item.read.mid) };
  }

  if (isObj(item.postback)) return { type: "IGNORED", reason: "a button press (postback) — this inbox sends no buttons" };
  if (isObj(item.reaction)) return { type: "IGNORED", reason: "a reaction" };
  if (isObj(item.message_edit)) return { type: "IGNORED", reason: "an edited message" };
  return { type: "IGNORED", reason: "an event this inbox does not use" };
}

// ─── Telegram ──────────────────────────────────────────────────────────────────────────────────

/** Telegram numbers every update; the number is unique per bot, so it is the dedup key. */
export function telegramDedupKey(update: unknown): string | null {
  if (!isObj(update)) return null;
  const id = num(update.update_id);
  return id === null ? null : `update:${id}`;
}

function telegramName(user: Obj | null): string | null {
  if (!user) return null;
  const parts = [str(user.first_name), str(user.last_name)].filter(Boolean);
  return parts.length ? parts.join(" ") : str(user.username);
}

/** One Telegram update, read. Only new messages are used; edits, channel posts and the rest are recorded and ignored. */
export function normalizeTelegramUpdate(update: unknown, receivedAt: Date): NormalizedChannelEvent {
  if (!isObj(update)) return { type: "IGNORED", reason: "not an object" };
  if (!isObj(update.message)) {
    const kind = Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
    return { type: "IGNORED", reason: kind === "edited_message" ? "an edited message" : `a Telegram ${kind.replace(/_/g, " ")} update` };
  }
  const message = update.message;
  const chat = isObj(message.chat) ? message.chat : null;
  const from = isObj(message.from) ? message.from : null;
  const chatId = chat ? str(chat.id) : null;
  const messageId = num(message.message_id);
  if (!chat || !chatId || messageId === null) return { type: "IGNORED", reason: "message without a chat or id" };

  const chatType = str(chat.type) ?? "private";
  if (chatType === "channel") return { type: "IGNORED", reason: "a channel post" };
  const direct = chatType === "private";
  const occurredAt = num(message.date) ? new Date(num(message.date)! * 1000) : receivedAt;

  const attachments: ChannelAttachment[] = [];
  let contentType: ChannelContentType = "UNSUPPORTED";
  const fileOf = (o: unknown): string | undefined => (isObj(o) ? (str(o.file_id) ?? undefined) : undefined);
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    attachments.push({ type: "IMAGE", fileId: fileOf(message.photo[message.photo.length - 1]) });
    contentType = "IMAGE";
  } else if (isObj(message.video) || isObj(message.video_note) || isObj(message.animation)) {
    attachments.push({ type: "VIDEO", fileId: fileOf(message.video ?? message.video_note ?? message.animation) });
    contentType = "VIDEO";
  } else if (isObj(message.voice) || isObj(message.audio)) {
    attachments.push({ type: "AUDIO", fileId: fileOf(message.voice ?? message.audio), name: isObj(message.audio) ? (str(message.audio.title) ?? undefined) : undefined });
    contentType = "AUDIO";
  } else if (isObj(message.document)) {
    attachments.push({ type: "FILE", fileId: fileOf(message.document), name: str(message.document.file_name) ?? undefined });
    contentType = "FILE";
  } else if (isObj(message.sticker)) {
    attachments.push({ type: "STICKER", fileId: fileOf(message.sticker), name: str(message.sticker.emoji) ?? undefined });
    contentType = "STICKER";
  } else if (isObj(message.location)) {
    attachments.push({ type: "LOCATION" });
    contentType = "LOCATION";
  } else if (isObj(message.contact)) {
    attachments.push({ type: "CONTACT", name: telegramName(message.contact) ?? undefined });
    contentType = "CONTACT";
  }
  const text = str(message.text) ?? str(message.caption);
  if (str(message.text)) contentType = "TEXT";
  if (!text && attachments.length === 0) {
    return { type: "IGNORED", reason: "a service message (someone joined, left, a title change…)" };
  }

  const title = direct ? telegramName(chat) ?? telegramName(from) : (str(chat.title) ?? "Telegram group");
  const replyTo = isObj(message.reply_to_message) ? num(message.reply_to_message.message_id) : null;

  return {
    type: "MESSAGE",
    direction: "INBOUND",
    externalMessageId: `${chatId}:${messageId}`,
    threadId: chatId,
    threadKind: direct ? "DIRECT" : "GROUP",
    threadTitle: title,
    senderExternalId: from ? (str(from.id) ?? chatId) : chatId,
    senderName: telegramName(from),
    senderUsername: from ? str(from.username) : null,
    senderIsBot: from?.is_bot === true,
    occurredAt,
    text,
    contentType,
    attachments,
    appId: null,
    metadata: null,
    replyToExternalId: replyTo === null ? null : `${chatId}:${replyTo}`,
  };
}

// ─── Previews, statuses ────────────────────────────────────────────────────────────────────────

const CONTENT_LABEL: Record<ChannelContentType, string> = {
  TEXT: "Message",
  IMAGE: "Photo",
  VIDEO: "Video",
  AUDIO: "Voice or audio",
  FILE: "File",
  STICKER: "Sticker",
  LOCATION: "Location",
  CONTACT: "Contact",
  SHARE: "Shared post",
  UNSUPPORTED: "Unsupported message",
};

export function channelContentLabel(type: ChannelContentType): string {
  return CONTENT_LABEL[type];
}

/** The one-line preview the conversation list shows. */
export function channelMessagePreview(text: string | null, contentType: ChannelContentType): string {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (clean) return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
  return `[${CONTENT_LABEL[contentType]}]`;
}

export const CHANNEL_DELIVERY_STATUSES = ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED", "UNKNOWN"] as const;
export type ChannelDeliveryStatus = (typeof CHANNEL_DELIVERY_STATUSES)[number];

const RECEIPT_RANK: Partial<Record<ChannelDeliveryStatus, number>> = { UNKNOWN: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/**
 * A receipt only ever moves a message forward: SENT → DELIVERED → READ. A late delivery receipt
 * never turns READ back into DELIVERED. UNKNOWN (the send's outcome could not be confirmed) is
 * resolved by any receipt, because a receipt proves it arrived. QUEUED / SENDING / FAILED are the
 * send queue's states and a receipt does not touch them (a receipt cannot be for a message that has
 * no provider id yet).
 */
export function advanceDeliveryStatus(current: ChannelDeliveryStatus, receipt: "DELIVERED" | "READ"): ChannelDeliveryStatus {
  const now = RECEIPT_RANK[current];
  if (now === undefined) return current;
  return RECEIPT_RANK[receipt]! > now ? receipt : current;
}

/** What a person sees for each status. Telegram never claims Delivered or Read because it cannot know. */
export const DELIVERY_STATUS_LABEL: Record<ChannelDeliveryStatus, string> = {
  QUEUED: "Queued",
  SENDING: "Sending…",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Not sent",
  UNKNOWN: "Unconfirmed",
};

// ─── Provider errors ───────────────────────────────────────────────────────────────────────────

export interface ProviderErrorReading {
  /** Worth trying again later (rate limit, a provider outage, a network failure). */
  retryable: boolean;
  /** The stored credential no longer works — the connection needs new credentials. */
  needsReauth: boolean;
  /** For the person: what happened and what to do. Never the provider's raw text alone, never a token. */
  message: string;
  /** Telegram's own retry hint, in seconds. */
  retryAfterSeconds?: number;
}

/** A Graph API error (`{ error: { message, code, error_subcode } }`) for a send or a check. */
export function readMetaError(status: number, body: unknown): ProviderErrorReading {
  const error = isObj(body) && isObj(body.error) ? body.error : {};
  const code = num(error.code);
  const subcode = num(error.error_subcode);
  const raw = (str(error.message) ?? "").replace(/access_token=[^&\s]+/gi, "access_token=[hidden]").slice(0, 300);
  if (code === 190 || code === 102 || subcode === 463 || subcode === 467) {
    return { retryable: false, needsReauth: true, message: "Meta no longer accepts this connection's access token (it expired or was revoked). Enter a new Page access token under Settings → Messaging Channels." };
  }
  if (code === 10 && (subcode === 2018278 || subcode === 2018065)) {
    return { retryable: false, needsReauth: false, message: "Meta refused: this message was sent outside the allowed reply window. The customer has to message you again first." };
  }
  if (code === 551 || subcode === 1545041) {
    return { retryable: false, needsReauth: false, message: "Meta refused: this person isn't available right now (they may have blocked the Page or deactivated their account)." };
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || subcode === 2446079) {
    return { retryable: true, needsReauth: false, message: "Meta is limiting how fast this account can send. It will be retried." };
  }
  if (code === 200 || code === 10 || code === 3) {
    return { retryable: false, needsReauth: false, message: `Meta refused because the app is missing a permission for this: ${raw || "permission error"}. Check the app's permissions (pages_messaging / instagram_manage_messages) and App Review status.` };
  }
  if (status >= 500 || code === 1 || code === 2) {
    return { retryable: true, needsReauth: false, message: "Meta had a temporary problem. It will be retried." };
  }
  return { retryable: false, needsReauth: false, message: raw ? `Meta refused the message: ${raw}` : `Meta refused the message (HTTP ${status}).` };
}

/** A Bot API error (`{ ok: false, error_code, description, parameters: { retry_after } }`). */
export function readTelegramError(status: number, body: unknown): ProviderErrorReading {
  const b = isObj(body) ? body : {};
  const code = num(b.error_code) ?? status;
  const description = (str(b.description) ?? "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[hidden]").slice(0, 300);
  const retryAfter = isObj(b.parameters) ? num(b.parameters.retry_after) : null;
  if (code === 401 || code === 404) {
    return { retryable: false, needsReauth: true, message: "Telegram no longer accepts this bot token (it was revoked or regenerated in BotFather). Enter the new token under Settings → Messaging Channels." };
  }
  if (code === 403) {
    return { retryable: false, needsReauth: false, message: `Telegram refused: ${description || "the bot cannot message this chat"} (the person may have blocked the bot, or the bot was removed from the group).` };
  }
  if (code === 429) {
    return { retryable: true, needsReauth: false, message: "Telegram is limiting how fast this bot can send. It will be retried.", retryAfterSeconds: retryAfter ?? undefined };
  }
  if (code >= 500) return { retryable: true, needsReauth: false, message: "Telegram had a temporary problem. It will be retried." };
  return { retryable: false, needsReauth: false, message: description ? `Telegram refused the message: ${description}` : `Telegram refused the message (HTTP ${status}).` };
}

/** How long to wait before the Nth retry of a retryable send (1-based). Null: stop trying. */
export const CHANNEL_SEND_MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [15, 60, 300, 900];

export function channelRetryDelayMs(attempt: number, retryAfterSeconds?: number): number | null {
  if (attempt >= CHANNEL_SEND_MAX_ATTEMPTS) return null;
  const base = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]! * 1000;
  return Math.max(base, (retryAfterSeconds ?? 0) * 1000);
}
