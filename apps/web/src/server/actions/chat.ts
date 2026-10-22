"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";

import { checkPermission, requireAccess } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isPersonalChatId, personalChatFallbackName } from "@/lib/chatConversationType";
import { isValidReactionEmoji, validateMentions } from "@support-automation/shared";
import { isChatUiV2Enabled, mentionCandidatesFor } from "@/server/chatThreadV2";

export interface ChatSendState {
  error?: string;
  sentAt?: number;
}

/** WhatsApp's own single-message ceiling; refuse past it rather than let the provider truncate. */
const MAX_BODY_LENGTH = 4096;

/**
 * Collapses an accidental double-submit of identical text into one send, while still
 * allowing a genuine repeat ("ok", "thanks") a few seconds later. Ten seconds is long
 * enough to cover a double-click or a resubmitted form, short enough that no one notices
 * the limit exists.
 */
const IDEMPOTENCY_WINDOW_MS = 10_000;

function buildManualReplyIdempotencyKey(groupId: string, body: string, extras?: { replyTo: string | null; mentions: string[] }): string {
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  // A quote or tags make it a different message: the same words quoting another message must not be
  // collapsed into the first. Without either, the key is exactly what it always was.
  const material = extras && (extras.replyTo || extras.mentions.length) ? [body, extras.replyTo ?? "", extras.mentions.join(",")].join("\u0000") : body;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `manual-reply:${groupId}:${bucket}:${digest}`;
}

/**
 * Chat v2 (CHAT_UI_V2.md): what this send quotes and who it tags, from the form, checked against the
 * conversation the server already resolved. Refused, never trimmed: a reply that silently lost its
 * quote or a tag is a different message from the one the operator wrote.
 *
 * Without either field the send is exactly what it always was. With either, the CHAT_UI_V2 feature
 * must be on for the project, so nothing new can happen in a project that has not switched it on.
 */
async function readReplyExtras(
  formData: FormData,
  conversation: { accountId: string; groupRowId: string; chatId: string } | { accountId: string; personalChatId: string },
  body: string,
): Promise<{ ok: true; replyTo: string | null; mentions: string[] } | { ok: false; error: string }> {
  const replyTo = String(formData.get("replyTo") ?? "").trim() || null;
  const rawMentions = String(formData.get("mentions") ?? "").trim();
  if (!replyTo && !rawMentions) return { ok: true, replyTo: null, mentions: [] };
  if (!(await isChatUiV2Enabled())) return { ok: false, error: "Replies and tags need the new conversation view, which is off for this project. Nothing was sent." };

  let mentions: string[] = [];
  if (rawMentions && rawMentions !== "[]") {
    if ("personalChatId" in conversation) return { ok: false, error: "Tags work only in groups. Nothing was sent." };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMentions);
    } catch {
      return { ok: false, error: "The tag list was not readable. Nothing was sent." };
    }
    const { candidates } = await mentionCandidatesFor({ kind: "GROUP", ...conversation });
    const check = validateMentions(parsed, new Set(candidates.map((c) => c.jid)), body);
    if (!check.ok) return { ok: false, error: check.error };
    mentions = check.mentions;
  }

  if (replyTo) {
    if (replyTo.length > 64) return { ok: false, error: "The message being replied to could not be found. Nothing was sent." };
    if (mentions.length) {
      return { ok: false, error: "A quoted reply cannot also tag people on this WhatsApp connection. Remove the quote or the tags. Nothing was sent." };
    }
    // The scoped client: a message of another project is "not found". Then it must be this
    // conversation's own stored message on this account — a queued bubble has no WhatsApp id to quote.
    const target = await prisma.message.findUnique({ where: { id: replyTo }, select: { accountId: true, groupId: true, chatId: true } });
    const inConversation =
      target !== null &&
      target.accountId === conversation.accountId &&
      ("groupRowId" in conversation ? target.groupId === conversation.groupRowId : target.groupId === null && target.chatId === conversation.personalChatId);
    if (!inConversation) return { ok: false, error: "The message being replied to is not in this conversation. Nothing was sent." };
  }
  return { ok: true, replyTo, mentions };
}

/**
 * Queues one operator-typed reply to a WhatsApp group, from the SELECTED account.
 *
 * Writes a single `OutboundMessage` row and stops there — it never talks to the worker
 * and never sends anything itself, which keeps the promise that all outbound WhatsApp traffic
 * leaves through exactly one queue. Deliberately not `enqueueOutboundMessage()`, which is
 * shaped for the incoming-message pipeline's non-null `incomingMessageId` and rule-cooldown
 * contract; neither applies to a human replying in a group.
 *
 * The account is the one the operator chose in the workspace (it is in the URL, bound into this
 * action), and nothing from the browser is trusted: the server re-derives every link —
 *   project (the scoped client) → account (must be this project's) → group (must be THAT account's
 *   own copy, still a member) → the session's user (`createdById`, never a form field).
 * A message is never sent through a different account than the one shown as "Sending from"; the old
 * cross-account "Reply as" is gone, and a request still carrying one is refused rather than honoured.
 */
export async function sendChatMessage(
  accountId: string,
  groupId: string,
  _prevState: ChatSendState,
  formData: FormData,
): Promise<ChatSendState> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Type a message before sending." };
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `That message is ${body.length} characters. WhatsApp accepts at most ${MAX_BODY_LENGTH}.` };
  }

  // The scoped client only finds this project's account; another project's id is "not found".
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { id: true, label: true, status: true } });
  if (!account) return { error: "That WhatsApp account is not in this project. Choose an account at the top of WhatsApp Chat." };

  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: { id: true, name: true, whatsappGroupId: true, accountId: true, isActive: true },
  });
  if (!group) return { error: "That conversation no longer exists." };
  if (group.accountId !== account.id) {
    return { error: `This conversation belongs to a different WhatsApp account than ${account.label}. Nothing was sent. Reopen it from the account selector.` };
  }
  const sendAs = String(formData.get("sendAs") ?? "").trim();
  if (sendAs && sendAs !== group.id) {
    return { error: `Replies go out only from the selected account (${account.label}). Nothing was sent.` };
  }

  // Checked here so the operator is told immediately, in the composer, instead of watching
  // the message sit queued until the worker discovers the same thing and marks it SKIPPED.
  if (!group.isActive) {
    return {
      error: `This account is no longer a member of ${group.name}, so messages cannot be sent to it. Resync groups if you have since been re-added.`,
    };
  }
  if (account.status !== "CONNECTED") {
    return {
      error: `${account.label} is ${account.status.toLowerCase()}, so nothing was sent. Reconnect it on WhatsApp Accounts, or switch to another account that is in this group.`,
    };
  }

  const extras = await readReplyExtras(formData, { accountId: account.id, groupRowId: group.id, chatId: group.whatsappGroupId }, body);
  if (!extras.ok) return { error: extras.error };

  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: account.id,
        chatId: group.whatsappGroupId,
        // A group has no single recipient number; the broadcast path sets the chat id here
        // for the same reason, and the queue's per-client rate limiter keys off this value.
        toPhone: group.whatsappGroupId,
        body,
        actionType: "MANUAL_REPLY",
        idempotencyKey: buildManualReplyIdempotencyKey(groupId, body, extras),
        groupId: group.id,
        replyToMessageId: extras.replyTo,
        mentions: extras.mentions,
        groupNameSnapshot: group.name,
        // WHO pressed send, from the server-side session — the attribution the conversation and the
        // User Activity report both read. The account above is WHICH NUMBER sent it.
        createdById: session.userId,
      },
    });
  } catch (err) {
    // A P2002 here is the idempotency window doing its job on a double-submit: the first
    // write already queued this exact text, so report success rather than a scary error.
    if ((err as { code?: string }).code === "P2002") {
      revalidatePath(await projectPath("/chat"), "layout");
      return { sentAt: Date.now() };
    }

    // Anything else — the group deleted between the lookup above and this insert, a dropped
    // connection — has to come back through the same error channel every other failure here uses.
    // Rethrowing replaced the composer with a generic error boundary, so the operator's typed
    // message vanished with nothing said about it.
    await logSystemEvent("ERROR", "chat-inbox", "Failed to queue a manual reply", {
      error: (err as Error).message,
      groupId: group.id,
      accountId: account.id,
      userId: session.userId,
    });
    return {
      error: `Your message to ${group.name} could not be queued because of a server error, and was not sent. Try again — if it keeps failing, check System Logs.`,
    };
  }

  // When another of our accounts is in the same WhatsApp group, this reply reaches ITS copy as an
  // ordinary incoming message from a participant it cannot recognise as ours — WhatsApp identifies
  // group members by opaque ids, not by our other number. If that account answers customers with AI,
  // it could then answer our own operator. An operator writing in the group is exactly what human
  // takeover means, so the AI pauses on the other accounts' copies for the configured cooldown — the
  // same pause a colleague replying from their phone causes.
  try {
    const ai = await prisma.aiSettings.findFirst({ select: { humanTakeoverCooldownMinutes: true } });
    // No settings row yet means the schema default applies, as it does for the worker.
    const minutes = ai?.humanTakeoverCooldownMinutes ?? 30;
    if (minutes > 0) {
      const until = new Date(Date.now() + minutes * 60_000);
      await prisma.whatsAppGroup.updateMany({
        where: {
          whatsappGroupId: group.whatsappGroupId,
          accountId: { not: account.id },
          OR: [{ aiSuppressedUntil: null }, { aiSuppressedUntil: { lt: until } }],
        },
        data: { aiSuppressedUntil: until },
      });
    }
  } catch (err) {
    // The reply is already queued; failing to pause AI must not report the send as failed.
    await logSystemEvent("WARN", "chat-inbox", "Could not pause AI on the other accounts in this group", {
      error: (err as Error).message,
      groupId: group.id,
    });
  }

  await logSystemEvent("INFO", "chat-inbox", `Queued a manual reply to ${group.name}`, {
    groupId: group.id,
    accountId: account.id,
    userId: session.userId,
    length: body.length,
  });

  revalidatePath(await projectPath("/chat"), "layout");
  return { sentAt: Date.now() };
}

/**
 * Queues one operator-typed reply to a PERSONAL (one-to-one) chat, from the selected account.
 *
 * The same single hand-off as a group reply — one `OutboundMessage` row, `MANUAL_REPLY`, sent by the
 * worker through the one outbound queue, under the same account rate limits — with the checks a
 * personal chat needs instead of a group's:
 *   - the chat id is an individual one (`@c.us` / `@lid`), never a group, broadcast or channel;
 *   - the account already HAS this conversation (a stored message in it). This is a reply, never a
 *     first message to a number nobody wrote to us from — the product does not cold-message;
 *   - the worker checks again, live, that the chat exists on the account before sending
 *     (`verifyPersonalChat`).
 * The account comes from the URL and is re-derived on the server, exactly as for a group.
 */
export async function sendPersonalChatMessage(
  accountId: string,
  chatId: string,
  _prevState: ChatSendState,
  formData: FormData,
): Promise<ChatSendState> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Type a message before sending." };
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `That message is ${body.length} characters. WhatsApp accepts at most ${MAX_BODY_LENGTH}.` };
  }
  if (!isPersonalChatId(chatId)) return { error: "That is not a personal chat. Nothing was sent." };

  // The scoped client only finds this project's account; another project's id is "not found".
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { id: true, label: true, status: true } });
  if (!account) return { error: "That WhatsApp account is not in this project. Choose an account at the top of WhatsApp Chat." };

  const [existing, named] = await Promise.all([
    prisma.message.findFirst({ where: { accountId: account.id, chatId, groupId: null }, select: { id: true } }),
    prisma.message.findFirst({
      where: { accountId: account.id, chatId, groupId: null, direction: "INCOMING", AND: [{ senderName: { not: null } }, { senderName: { not: "" } }] },
      orderBy: { timestampWa: "desc" },
      select: { senderName: true },
    }),
  ]);
  if (!existing) {
    return { error: `${account.label} has no conversation with this number, so nothing was sent. Replies continue an existing chat; they never start one.` };
  }
  const name = named?.senderName || personalChatFallbackName(chatId);

  if (account.status !== "CONNECTED") {
    return { error: `${account.label} is ${account.status.toLowerCase()}, so nothing was sent. Reconnect it on WhatsApp Accounts.` };
  }

  const extras = await readReplyExtras(formData, { accountId: account.id, personalChatId: chatId }, body);
  if (!extras.ok) return { error: extras.error };

  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: account.id,
        chatId,
        // The per-client rate limit keys off this, as it does for a group's chat id.
        toPhone: chatId,
        body,
        actionType: "MANUAL_REPLY",
        // Keyed by account AND chat: unlike a group row id, a chat id is the same on every account.
        idempotencyKey: buildManualReplyIdempotencyKey(`personal:${account.id}:${chatId}`, body, extras),
        groupNameSnapshot: name,
        replyToMessageId: extras.replyTo,
        createdById: session.userId,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      revalidatePath(await projectPath("/chat"), "layout");
      return { sentAt: Date.now() };
    }
    await logSystemEvent("ERROR", "chat-inbox", "Failed to queue a manual reply to a personal chat", {
      error: (err as Error).message,
      chatId,
      accountId: account.id,
      userId: session.userId,
    });
    return { error: `Your message to ${name} could not be queued because of a server error, and was not sent. Try again — if it keeps failing, check System Logs.` };
  }

  await logSystemEvent("INFO", "chat-inbox", `Queued a manual reply to ${name} (personal chat)`, {
    chatId,
    accountId: account.id,
    userId: session.userId,
    length: body.length,
  });
  revalidatePath(await projectPath("/chat"), "layout");
  return { sentAt: Date.now() };
}

/**
 * Cancels a queued reply that has not left yet. Only ever touches a MANUAL_REPLY row that is
 * still PENDING — an automation-generated send or one already in flight is never cancellable
 * from here.
 */
export async function cancelQueuedChatMessage(outboundId: string): Promise<void> {
  await requireAccess("messages.reply");
  await prisma.outboundMessage.updateMany({
    where: { id: outboundId, actionType: "MANUAL_REPLY", status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled from the chat inbox before sending." },
  });
  revalidatePath(await projectPath("/chat"), "layout");
}

export interface MessageActionResult {
  error?: string;
}

/**
 * Reacts to a stored message with one emoji -- ours or a customer's, since WhatsApp allows
 * reacting to either. `messageId` is our own row's id rather than the WhatsApp message id, so the
 * account it belongs to can be resolved server-side instead of trusted from the client.
 *
 * This is a live browser action -- a WorkerCommand, not an OutboundMessage -- because a reaction
 * has nothing to retry, rate-limit or queue: it either lands on the next tick or it does not.
 */
export async function reactToChatMessage(messageId: string, emoji: string): Promise<MessageActionResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  // Exactly one emoji: the worker refuses an empty one, and removing a reaction is not a contract this
  // connection has been verified to honour (CHAT_UI_V2.md §2), so it is not offered.
  if (!isValidReactionEmoji(emoji)) return { error: "Choose one emoji to react with." };
  if (typeof messageId !== "string" || messageId.length > 64) return { error: "That message could not be found." };

  // The scoped client: another project's message is "not found".
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, accountId: true, whatsappMessageId: true, groupId: true, account: { select: { label: true, status: true } } },
  });
  if (!message) return { error: "That message could not be found." };
  if (message.account.status !== "CONNECTED") {
    return { error: `${message.account.label} is ${message.account.status.toLowerCase()}, so the reaction was not sent.` };
  }

  // A second press while the first is still with the worker is the same request, not a new one.
  const inFlight = await prisma.workerCommand.findFirst({
    where: {
      type: "REACT_TO_MESSAGE",
      accountId: message.accountId,
      status: { in: ["PENDING", "PROCESSING"] },
      payload: { path: ["messageId"], equals: message.id },
    },
    select: { payload: true },
  });
  if (inFlight && (inFlight.payload as { emoji?: unknown } | null)?.emoji === emoji) return {};

  await prisma.workerCommand.create({
    data: {
      type: "REACT_TO_MESSAGE",
      accountId: message.accountId,
      // `messageId` and `requestedById` are for showing the result on the message; the worker reads
      // only the first two fields.
      payload: { whatsappMessageId: message.whatsappMessageId, emoji, messageId: message.id, requestedById: granted.session.userId },
    },
  });
  if (message.groupId) revalidatePath(await projectPath("/chat"), "layout");
  return {};
}

/**
 * Edits the text of a message this account sent. WhatsApp's own edit feature is marked
 * experimental by the underlying library and most accounts do not have it -- a reported failure
 * here is the ordinary outcome on many accounts, not evidence of a defect, and is surfaced as
 * plainly as any other "could not send" error.
 *
 * Deliberately does NOT rewrite `Message.body`: that column is the record of what was actually
 * sent, and WhatsApp's own edit indicator on the customer's device is the real record that a
 * message changed. Silently rewriting history here would make our own record disagree with what a
 * customer scrolling back actually sees.
 */
export async function editChatMessage(messageId: string, newBody: string): Promise<MessageActionResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };

  const trimmed = newBody.trim();
  if (!trimmed) return { error: "The edited message cannot be empty." };
  if (trimmed.length > MAX_BODY_LENGTH) return { error: `Keep it under ${MAX_BODY_LENGTH} characters.` };

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { accountId: true, whatsappMessageId: true, groupId: true, direction: true },
  });
  if (!message) return { error: "That message could not be found." };
  if (message.direction !== "OUTGOING") return { error: "Only a message this account sent can be edited." };

  await prisma.workerCommand.create({
    data: {
      type: "EDIT_MESSAGE",
      accountId: message.accountId,
      payload: { whatsappMessageId: message.whatsappMessageId, newBody: trimmed },
    },
  });
  if (message.groupId) revalidatePath(await projectPath("/chat"), "layout");
  return {};
}
