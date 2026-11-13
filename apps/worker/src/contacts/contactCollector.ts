import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { collectContactFromChat } from "@support-automation/db";
import {
  buildContactAiPrompt,
  channelContactValue,
  channelContactSource,
  collectedChatKind,
  CONTACT_AI_SYSTEM_PROMPT,
  extractContactIdentifiers,
  normalizePhoneNumber,
  phoneFromChatId,
  readContactAiAnswer,
  type ContactIdentifierReading,
} from "@support-automation/shared";
import { getAiSettings } from "../ai/settings.js";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { currentProjectId, forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";

/**
 * Collects contacts from what customers write (CONTACTS.md). Its own loop, reading stored messages after a cursor, so the
 * message path never waits for it and nothing about how a message is handled changes. On by default, and it reads every
 * conversation from the oldest stored message onwards, past ones included. It never sends anything.
 *
 *   - Every message is read for numbers, emails and links without AI. A personal chat with no contact gets one, with what
 *     the platform itself proves.
 *   - "AI": while calls are left in the pass, a message holding a value goes to the model instead, which can only point at
 *     the values already found in the text (and may give a name). With AI off or its calls spent, the plain reading is used,
 *     so the cursor never waits for AI.
 * The same number is never stored twice: the unique index on (project, kind, value) decides.
 */

const LOOP_NAME = "contact-collector";
/** Messages read per pass. Reading without AI is cheap, so a long history is caught up in a reasonable number of passes. */
const BATCH = 1000;
/** Customer messages read per channel conversation: its latest, so the whole conversation is seen, not only what is new. */
const CHANNEL_MESSAGES = 200;
/** At most this many AI calls per project per pass. What is left is read without AI. */
const AI_CALLS_PER_PASS = 5;
/** An @mention names a participant by a number or a LID, and a LID is never a phone number: never read as a value. */
const MENTION = /@\d{5,}/g;

export function startContactCollector(intervalMs = 30_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runContactCollectorTick()
      .catch((err) => console.error("[contacts] collection pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runContactCollectorTick(): Promise<void> {
  await forEachProject(LOOP_NAME, () => collectContactsForProject());
}

interface Pass {
  client: AiClient | null;
  callsLeft: number;
  autoCreate: boolean;
  ours: Set<string>;
}

interface Reading {
  name: string | null;
  values: ContactIdentifierReading[];
  usedAi: boolean;
}

/** A project with no settings row yet collects from the start (the schema's default), without anyone opening the page. */
async function loadSettings(now: Date) {
  const settings = await prisma.contactSettings.findFirst();
  if (settings) {
    if (settings.collectionStartedAt || !(settings.aiCollectionEnabled || settings.autoCreateFromChats)) return settings;
    return prisma.contactSettings.update({ where: { id: settings.id }, data: { collectionStartedAt: now } });
  }
  try {
    return await prisma.contactSettings.create({ data: { collectionStartedAt: now } as never });
  } catch (err) {
    // Somebody saved the settings, or reserved a serial, in the same moment: theirs stands.
    if ((err as { code?: string }).code !== "P2002") throw err;
    return prisma.contactSettings.findFirst();
  }
}

export async function collectContactsForProject(deps: { aiClient?: AiClient | null; now?: Date } = {}): Promise<void> {
  if (!(await projectHasFeature("CONTACTS"))) return;
  const now = deps.now ?? new Date();
  const settings = await loadSettings(now);
  if (!settings || !(settings.aiCollectionEnabled || settings.autoCreateFromChats)) return;
  const useAi = settings.aiCollectionEnabled && (await getAiSettings()).aiEngineEnabled;
  if (!useAi && !settings.autoCreateFromChats) return;
  const client = useAi ? (deps.aiClient !== undefined ? deps.aiClient : await resolveAiClient("RESPONSE", prisma)) : null;
  if (!client && !settings.autoCreateFromChats) return;

  // Our own numbers and the team's are never a customer's.
  const [accounts, members] = await Promise.all([
    prisma.whatsAppAccount.findMany({ where: { phoneNumber: { not: null } }, select: { phoneNumber: true } }),
    prisma.internalTeamMember.findMany({ select: { phoneNumber: true } }),
  ]);
  const ours = new Set([...accounts.map((a) => a.phoneNumber!), ...members.map((m) => m.phoneNumber)].flatMap((p) => normalizePhoneNumber(p) ?? []));
  const pass: Pass = { client, callsLeft: AI_CALLS_PER_PASS, autoCreate: settings.autoCreateFromChats, ours };

  // No cursor means nothing has been read yet: start from the oldest stored message.
  await collectFromWhatsApp(pass, settings.whatsappCursorAt, settings.whatsappCursorId);
  await collectFromChannels(pass, settings.channelCursorAt ?? new Date(0), now);
}

/** What one message holds. Read without AI, unless AI is on and the pass still has a call to spend on it. */
async function readMessage(pass: Pass, body: string, allowAi = true): Promise<Reading> {
  const none: Reading = { name: null, values: [], usedAi: false };
  if (!body.trim()) return none;
  const candidates = extractContactIdentifiers(body.replace(MENTION, " ")).filter((c) => !(c.kind === "PHONE" && pass.ours.has(c.normalized)));
  if (candidates.length === 0) return none;
  // A bare @handle names no app, so without the model it is left alone.
  const plain: Reading = { name: null, values: candidates.filter((c) => c.kind !== "OTHER"), usedAi: false };
  if (!pass.client || !allowAi || pass.callsLeft <= 0) return plain;
  pass.callsLeft -= 1;
  try {
    const result = await pass.client.complete({ systemPrompt: CONTACT_AI_SYSTEM_PROMPT, userPrompt: buildContactAiPrompt(body, candidates), maxTokens: 200, temperature: 0 });
    const reading = readContactAiAnswer(result.text, body, candidates);
    return reading ? { name: reading.name, values: reading.identifiers, usedAi: true } : plain;
  } catch (err) {
    console.error("[contacts] AI reading failed", (err as Error).message);
    return plain;
  }
}

function addValues(into: Map<string, ContactIdentifierReading>, values: readonly ContactIdentifierReading[]) {
  for (const v of values) {
    const key = `${v.kind}:${v.normalized}`;
    if (!into.has(key)) into.set(key, v);
  }
}

async function save(input: Parameters<typeof collectContactFromChat>[1]): Promise<void> {
  try {
    await collectContactFromChat(prisma, input);
  } catch (err) {
    // A person saved the same chat or value in the same moment: theirs stands.
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
}

async function collectFromWhatsApp(pass: Pass, cursorAt: Date | null, cursorId: string | null): Promise<void> {
  const rows = await prisma.message.findMany({
    where: {
      direction: "INCOMING",
      isFromTeamMember: false,
      ...(cursorAt ? { createdAt: { gte: cursorAt }, ...(cursorId ? { NOT: { createdAt: cursorAt, id: { lte: cursorId } } } : {}) } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH,
    select: { id: true, createdAt: true, accountId: true, chatId: true, senderName: true, body: true, group: { select: { name: true, isMonitored: true } } },
  });
  if (rows.length === 0) return;
  const linked = new Set((await prisma.contactConversationLink.findMany({ where: { chatId: { in: [...new Set(rows.map((r) => r.chatId))] } }, select: { chatId: true } })).map((l) => l.chatId));
  const projectId = currentProjectId();

  // One save per chat per pass, however many of its messages are in the batch.
  const chats = new Map<string, { accountId: string; kind: "PERSONAL" | "GROUP"; title: string | null; name: string | null; values: Map<string, ContactIdentifierReading>; usedAi: boolean }>();
  for (const row of rows) {
    const kind = collectedChatKind(row.chatId);
    // A group counts only when it is one the business monitors: a number's other groups are not its customers.
    if (!(kind === "PERSONAL" || (kind === "GROUP" && row.group?.isMonitored))) continue;
    const read = await readMessage(pass, row.body ?? "");
    let chat = chats.get(row.chatId);
    if (!chat) {
      const title = kind === "GROUP" ? (row.group?.name ?? null) : row.senderName?.trim() || null;
      chat = { accountId: row.accountId, kind, title, name: null, values: new Map(), usedAi: false };
      chats.set(row.chatId, chat);
    }
    chat.name = chat.name ?? read.name;
    chat.usedAi = chat.usedAi || read.usedAi;
    addValues(chat.values, read.values);
  }

  for (const [chatId, chat] of chats) {
    const phone = chat.kind === "PERSONAL" ? phoneFromChatId(chatId) : null;
    const verified = phone && !pass.ours.has(phone.normalized) ? [{ ...phone, isWhatsApp: true }] : [];
    const isNewPersonal = pass.autoCreate && chat.kind === "PERSONAL" && !linked.has(chatId) && (verified.length > 0 || chatId.endsWith("@lid"));
    if (chat.values.size === 0 && !isNewPersonal) continue;
    await save({
      projectId,
      chat: { accountId: chat.accountId, chatId },
      chatTitle: chat.title,
      source: "WHATSAPP",
      sourceDetail: chat.title ? `From the chat with ${chat.title}` : "From a WhatsApp chat",
      name: chat.name ?? chat.title,
      values: [...verified, ...chat.values.values()],
      collectedByAi: chat.usedAi,
      actor: { userId: null, name: chat.usedAi ? "AI" : "Automatic" },
    });
  }
  const last = rows[rows.length - 1]!;
  await prisma.contactSettings.updateMany({ data: { whatsappCursorAt: last.createdAt, whatsappCursorId: last.id } });
}

async function collectFromChannels(pass: Pass, cursorAt: Date, now: Date): Promise<void> {
  // A moment behind the clock, so a conversation being written right now is not stepped past.
  const until = new Date(now.getTime() - 2_000);
  if (until <= cursorAt) return;
  const conversations = await prisma.channelConversation.findMany({
    where: { updatedAt: { gt: cursorAt, lte: until }, kind: { not: "GROUP" } },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: { id: true, type: true, title: true, customerName: true, customerUsername: true, updatedAt: true },
  });
  const linked = new Set((await prisma.contactConversationLink.findMany({ where: { channelConversationId: { in: conversations.map((c) => c.id) } }, select: { channelConversationId: true } })).map((l) => l.channelConversationId));
  const projectId = currentProjectId();

  for (const conversation of conversations) {
    // The conversation's latest customer messages, older ones included. Only what is new since the cursor may cost an AI call.
    const messages = await prisma.channelMessage.findMany({
      where: { conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER" },
      orderBy: { createdAt: "desc" },
      take: CHANNEL_MESSAGES,
      select: { text: true, createdAt: true },
    });
    let name: string | null = null;
    let usedAi = false;
    const values = new Map<string, ContactIdentifierReading>();
    for (const message of messages) {
      const read = await readMessage(pass, message.text ?? "", message.createdAt > cursorAt);
      name = name ?? read.name;
      usedAi = usedAi || read.usedAi;
      addValues(values, read.values);
    }
    const isNew = pass.autoCreate && !linked.has(conversation.id) && messages.length > 0;
    if (values.size > 0 || isNew) {
      const title = conversation.customerName?.trim() || conversation.title || null;
      const proven = channelContactValue(conversation.type, conversation.customerUsername);
      await save({
        projectId,
        chat: { channelConversationId: conversation.id },
        chatTitle: title,
        source: channelContactSource(conversation.type),
        sourceDetail: title ? `From the chat with ${title}` : "From a chat",
        name: name ?? conversation.customerName?.trim() ?? null,
        values: [...(proven ? [{ ...proven, isWhatsApp: proven.kind === "PHONE" }] : []), ...values.values()],
        collectedByAi: usedAi,
        actor: { userId: null, name: usedAi ? "AI" : "Automatic" },
      });
    }
  }
  // A full page stops at its last conversation, so the next pass reads on from there.
  const reached = conversations.length === 100 ? conversations[conversations.length - 1]!.updatedAt : until;
  if (reached > cursorAt) await prisma.contactSettings.updateMany({ data: { channelCursorAt: reached } });
}
