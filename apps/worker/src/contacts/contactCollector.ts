import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { collectContactFromChat } from "@support-automation/db";
import {
  buildContactAiPrompt,
  channelContactHandleKind,
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
 * message path never waits for it and nothing about how a message is handled changes. Off unless a project switches it
 * on, and it starts at the moment it was switched on: history is never read. It never sends anything.
 *
 *   - "New personal chats": a chat with no contact gets one, from what the platform itself proves. No AI.
 *   - "AI": a message that holds a number, address or link goes to the model, which can only point at the values already
 *     found in the text. A message with none costs nothing.
 * The same number is never stored twice: the unique index on (project, kind, value) decides.
 */

const LOOP_NAME = "contact-collector";
const BATCH = 200;
/** At most this many AI calls per project per pass. What is left waits for the next pass; the cursor stops before it. */
const AI_CALLS_PER_PASS = 5;

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

export async function collectContactsForProject(deps: { aiClient?: AiClient | null; now?: Date } = {}): Promise<void> {
  if (!(await projectHasFeature("CONTACTS"))) return;
  const settings = await prisma.contactSettings.findFirst();
  if (!settings || !settings.collectionStartedAt || !(settings.aiCollectionEnabled || settings.autoCreateFromChats)) return;
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

  await collectFromWhatsApp(pass, settings.whatsappCursorAt ?? settings.collectionStartedAt, settings.whatsappCursorId);
  await collectFromChannels(pass, settings.channelCursorAt ?? settings.collectionStartedAt, deps.now ?? new Date());
}

/** What the model kept from one message. Null when the pass has spent its calls: the caller stops before this message. */
async function readMessage(pass: Pass, body: string): Promise<{ name: string | null; values: ContactIdentifierReading[]; usedAi: boolean } | null> {
  const none = { name: null, values: [], usedAi: false };
  if (!pass.client || !body.trim()) return none;
  const candidates = extractContactIdentifiers(body).filter((c) => !(c.kind === "PHONE" && pass.ours.has(c.normalized)));
  if (candidates.length === 0) return none;
  if (pass.callsLeft <= 0) return null;
  pass.callsLeft -= 1;
  try {
    const result = await pass.client.complete({ systemPrompt: CONTACT_AI_SYSTEM_PROMPT, userPrompt: buildContactAiPrompt(body, candidates), maxTokens: 200, temperature: 0 });
    const reading = readContactAiAnswer(result.text, body, candidates);
    return reading ? { name: reading.name, values: reading.identifiers, usedAi: true } : none;
  } catch (err) {
    console.error("[contacts] AI reading failed", (err as Error).message);
    return none;
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

async function collectFromWhatsApp(pass: Pass, cursorAt: Date, cursorId: string | null): Promise<void> {
  const rows = await prisma.message.findMany({
    where: {
      direction: "INCOMING",
      isFromTeamMember: false,
      createdAt: { gte: cursorAt },
      ...(cursorId ? { NOT: { createdAt: cursorAt, id: { lte: cursorId } } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH,
    select: { id: true, createdAt: true, accountId: true, chatId: true, senderName: true, body: true, group: { select: { name: true, isMonitored: true } } },
  });
  if (rows.length === 0) return;
  const linked = new Set((await prisma.contactConversationLink.findMany({ where: { chatId: { in: [...new Set(rows.map((r) => r.chatId))] } }, select: { chatId: true } })).map((l) => l.chatId));
  const projectId = currentProjectId();

  let last: { createdAt: Date; id: string } | null = null;
  for (const row of rows) {
    const kind = collectedChatKind(row.chatId);
    // A group counts only when it is one the business monitors: a number's other groups are not its customers.
    if (kind === "PERSONAL" || (kind === "GROUP" && row.group?.isMonitored)) {
      const read = await readMessage(pass, row.body ?? "");
      if (!read) break;
      const phone = kind === "PERSONAL" ? phoneFromChatId(row.chatId) : null;
      const verified = phone && !pass.ours.has(phone.normalized) ? [{ ...phone, isWhatsApp: true }] : [];
      const isNewPersonal = pass.autoCreate && kind === "PERSONAL" && !linked.has(row.chatId) && (verified.length > 0 || row.chatId.endsWith("@lid"));
      if (read.values.length > 0 || isNewPersonal) {
        const title = kind === "GROUP" ? (row.group?.name ?? null) : row.senderName?.trim() || null;
        await save({
          projectId,
          chat: { accountId: row.accountId, chatId: row.chatId },
          chatTitle: title,
          source: "WHATSAPP",
          sourceDetail: title ? `From the chat with ${title}` : "From a WhatsApp chat",
          name: read.name ?? title,
          values: [...verified, ...read.values],
          collectedByAi: read.usedAi,
          actor: { userId: null, name: read.usedAi ? "AI" : "Automatic" },
        });
        linked.add(row.chatId);
      }
    }
    last = { createdAt: row.createdAt, id: row.id };
  }
  if (last) await prisma.contactSettings.updateMany({ data: { whatsappCursorAt: last.createdAt, whatsappCursorId: last.id } });
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

  let reached = conversations.length === 100 ? cursorAt : until;
  for (const conversation of conversations) {
    const messages = await prisma.channelMessage.findMany({
      where: { conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER", createdAt: { gt: cursorAt } },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { text: true },
    });
    let stopped = false;
    let found: { name: string | null; values: ContactIdentifierReading[]; usedAi: boolean } = { name: null, values: [], usedAi: false };
    for (const message of messages) {
      const read = await readMessage(pass, message.text ?? "");
      if (!read) {
        stopped = true;
        break;
      }
      found = { name: found.name ?? read.name, values: [...found.values, ...read.values], usedAi: found.usedAi || read.usedAi };
    }
    if (stopped) {
      reached = cursorAt;
      break;
    }
    const isNew = pass.autoCreate && !linked.has(conversation.id) && messages.length > 0;
    if (found.values.length > 0 || isNew) {
      const title = conversation.customerName?.trim() || conversation.title || null;
      const handle = conversation.customerUsername?.replace(/^@/, "").trim();
      const handleKind = channelContactHandleKind(conversation.type);
      await save({
        projectId,
        chat: { channelConversationId: conversation.id },
        chatTitle: title,
        source: channelContactSource(conversation.type),
        sourceDetail: title ? `From the chat with ${title}` : "From a chat",
        name: found.name ?? conversation.customerName?.trim() ?? null,
        values: [...(handle && handleKind ? [{ kind: handleKind, value: handle, normalized: handle.toLowerCase() }] : []), ...found.values],
        collectedByAi: found.usedAi,
        actor: { userId: null, name: found.usedAi ? "AI" : "Automatic" },
      });
    }
    if (conversations.length === 100) reached = conversation.updatedAt;
  }
  if (reached > cursorAt) await prisma.contactSettings.updateMany({ data: { channelCursorAt: reached } });
}
