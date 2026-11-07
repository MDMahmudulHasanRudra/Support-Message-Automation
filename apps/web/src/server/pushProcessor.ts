import { isPersonalChatId } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { isMainAdmin, runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { tenantOfCustomer } from "@/server/tenant";
import { collapseWaiting, CONVERSATION_COOLDOWN_MS, pushBody, WAITING_GAP_MS, wantsAlert, type PushAlert, type PushPrefs } from "@/lib/pushRules";
import { pushConfigured, sendPush, type PushTarget } from "@/server/push/send";

/**
 * Agent notifications (AGENT_APP.md), in the APP process like the other background work here, and reading
 * only rows the worker has already stored: the WhatsApp message path does not change and knows nothing of
 * this. Best effort by design. A notification is a tap on the shoulder, and the inbox stays the record, so the
 * position is held in memory and a restart simply starts from now rather than replaying a backlog at someone's
 * phone. PUSH_PROCESSOR_DISABLED=true leaves it off.
 */
const TICK_MS = 5000;
const PER_KIND = 300;
/** A message stored now but written long ago is history being recovered, not a customer waiting. */
const MAX_MESSAGE_AGE_MS = 15 * 60_000;
const ACCESS_CACHE_MS = 60_000;

interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
  tenant: string | null;
  disabled: Set<string>;
}

type Device = PushTarget & PushPrefs & { userId: string };
/** One alert, and who it is for: named people, or (null) anybody on this project who wants waiting alerts. */
type Pending = PushAlert & { userId: string | null };

function inboxUrl(project: ProjectInfo): string {
  return project.disabled.has("OMNICHANNEL") ? `/p/${project.slug}/chat` : `/p/${project.slug}/conversations/all`;
}

function conversationUrl(project: ProjectInfo, ref: { accountId?: string | null; groupRowId?: string | null; chatId?: string | null; channelConversationId?: string | null }): string {
  const base = `/p/${project.slug}`;
  if (ref.channelConversationId) return `${base}/conversations/all/c/${ref.channelConversationId}`;
  const inbox = project.disabled.has("OMNICHANNEL") ? `${base}/chat/account/${ref.accountId}` : `${base}/conversations/all/w/${ref.accountId}`;
  if (ref.groupRowId) return `${inbox}/${ref.groupRowId}`;
  if (ref.chatId && isPersonalChatId(ref.chatId)) return `${inbox}/personal/${encodeURIComponent(ref.chatId)}`;
  return inbox;
}

export interface PushRun {
  cursor: Date;
  lastPing: Map<string, number>;
  held: Map<string, { alerts: PushAlert[]; lastSent: number }>;
  access: Map<string, { ok: boolean; at: number }>;
  projects: Map<string, { info: ProjectInfo | null; at: number }>;
}

export function newPushRun(from = new Date()): PushRun {
  return { cursor: from, lastPing: new Map(), held: new Map(), access: new Map(), projects: new Map() };
}

async function projectInfo(run: PushRun, projectId: string, now: number): Promise<ProjectInfo | null> {
  const cached = run.projects.get(projectId);
  if (cached && now - cached.at < ACCESS_CACHE_MS) return cached.info;
  const row = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true, name: true, status: true, billingHoldAt: true, customerId: true } });
  let info: ProjectInfo | null = null;
  if (row && row.status === "ACTIVE" && !row.billingHoldAt) {
    const base = { id: row.id, slug: row.slug, name: row.name, status: "ACTIVE" as const, tenant: await tenantOfCustomer(row.customerId) };
    // Inside the project: outside one, the customer-scoped client looks for a request, and there is none here.
    info = { ...base, disabled: new Set(await runWithProject(base, () => disabledFeaturesFor(row.id))) };
  }
  run.projects.set(projectId, { info, at: now });
  return info;
}

/** The same questions the inbox asks before showing this person anything: their customer, their access, their role. */
async function mayRead(run: PushRun, userId: string, project: ProjectInfo, now: number): Promise<boolean> {
  const key = `${userId}:${project.id}`;
  const cached = run.access.get(key);
  if (cached && now - cached.at < ACCESS_CACHE_MS) return cached.ok;
  let ok = false;
  try {
    const user = await globalPrisma.user.findUnique({ where: { id: userId }, select: { username: true, email: true, name: true, isActive: true, customerId: true } });
    if (user?.isActive && (await tenantOfCustomer(user.customerId)) === project.tenant) {
      ok = await runWithProject(project, async () => {
        const entered = (await isMainAdmin(userId)) || Boolean(await globalPrisma.projectAccess.findFirst({ where: { projectId: project.id, userId }, select: { id: true } }));
        return entered && hasPermission({ userId, username: user.username, email: user.email ?? "", name: user.name, tenant: user.customerId ?? null }, "messages.view");
      });
    }
  } catch (err) {
    console.error("[push] access check failed", (err as Error).name);
  }
  run.access.set(key, { ok, at: now });
  return ok;
}

async function collect(run: PushRun, from: Date, to: Date, now: number): Promise<Pending[]> {
  const window = { gt: from, lte: to };
  const out: Pending[] = [];

  // Assigned to somebody, by a colleague or by automatic routing.
  const assigned = await globalPrisma.conversationEvent.findMany({
    where: { kind: "ASSIGNEE", toValue: { not: null }, createdAt: window },
    orderBy: { createdAt: "asc" },
    take: PER_KIND,
    select: { projectId: true, toValue: true, actorId: true, accountId: true, chatId: true, channelConversationId: true, channelConversation: { select: { title: true, customerName: true } } },
  });
  for (const e of assigned) {
    if (!e.toValue || e.toValue === e.actorId) continue;
    const project = await projectInfo(run, e.projectId, now);
    if (!project) continue;
    const group = e.accountId && e.chatId && !isPersonalChatId(e.chatId) ? await globalPrisma.whatsAppGroup.findFirst({ where: { projectId: e.projectId, accountId: e.accountId, whatsappGroupId: e.chatId }, select: { id: true, name: true } }) : null;
    const name = e.channelConversation?.title ?? e.channelConversation?.customerName ?? group?.name ?? "A conversation";
    out.push({ kind: "ASSIGNED", userId: e.toValue, projectId: e.projectId, conversationKey: e.channelConversationId ?? `${e.accountId}:${e.chatId}`, title: name, preview: null, url: conversationUrl(project, { ...e, groupRowId: group?.id }), inboxUrl: inboxUrl(project) });
  }

  // Mentioned in a note.
  const mentions = await globalPrisma.inboxMention.findMany({
    where: { createdAt: window },
    orderBy: { createdAt: "asc" },
    take: PER_KIND,
    select: { projectId: true, userId: true, note: { select: { accountId: true, chatId: true, channelConversationId: true, authorId: true, body: true, deletedAt: true, channelConversation: { select: { title: true, customerName: true } } } } },
  });
  for (const m of mentions) {
    if (m.note.deletedAt || m.note.authorId === m.userId) continue;
    const project = await projectInfo(run, m.projectId, now);
    if (!project) continue;
    const n = m.note;
    const group = n.accountId && n.chatId && !isPersonalChatId(n.chatId) ? await globalPrisma.whatsAppGroup.findFirst({ where: { projectId: m.projectId, accountId: n.accountId, whatsappGroupId: n.chatId }, select: { id: true, name: true } }) : null;
    const name = n.channelConversation?.title ?? n.channelConversation?.customerName ?? group?.name ?? "A conversation";
    out.push({ kind: "MENTION", userId: m.userId, projectId: m.projectId, conversationKey: n.channelConversationId ?? `${n.accountId}:${n.chatId}`, title: name, preview: n.body, url: conversationUrl(project, { ...n, groupRowId: group?.id }), inboxUrl: inboxUrl(project) });
  }

  // A customer wrote on WhatsApp: to whoever holds the conversation, or to the team when nobody does.
  const messages = await globalPrisma.message.findMany({
    where: { direction: "INCOMING", isFromTeamMember: false, createdAt: window, timestampWa: { gte: new Date(now - MAX_MESSAGE_AGE_MS) } },
    orderBy: { createdAt: "asc" },
    take: PER_KIND,
    select: { projectId: true, accountId: true, chatId: true, groupId: true, senderName: true, body: true, group: { select: { name: true, isMonitored: true, isActive: true } } },
  });
  for (const m of messages) {
    const project = await projectInfo(run, m.projectId, now);
    if (!project || project.disabled.has("WHATSAPP_CHAT")) continue;
    if (m.groupId ? !m.group?.isActive || !m.group.isMonitored : !isPersonalChatId(m.chatId)) continue;
    const state = await globalPrisma.whatsAppConversationState.findFirst({ where: { projectId: m.projectId, accountId: m.accountId, chatId: m.chatId }, select: { assignedUserId: true } });
    const holder = state?.assignedUserId ?? null;
    out.push({
      kind: holder ? "CUSTOMER" : "WAITING",
      userId: holder,
      projectId: m.projectId,
      conversationKey: `${m.projectId}:${m.chatId}`,
      title: m.group?.name ?? m.senderName ?? "A customer",
      preview: m.body,
      url: conversationUrl(project, { accountId: m.accountId, groupRowId: m.groupId, chatId: m.chatId }),
      inboxUrl: inboxUrl(project),
    });
  }

  // A customer wrote on Messenger, Instagram, Telegram or website chat.
  const channel = await globalPrisma.channelMessage.findMany({
    where: { direction: "INBOUND", createdAt: window },
    orderBy: { createdAt: "asc" },
    take: PER_KIND,
    select: { projectId: true, conversationId: true, text: true, conversation: { select: { title: true, customerName: true, assignedUserId: true } } },
  });
  for (const m of channel) {
    const project = await projectInfo(run, m.projectId, now);
    if (!project || project.disabled.has("OMNICHANNEL")) continue;
    const holder = m.conversation.assignedUserId;
    out.push({
      kind: holder ? "CUSTOMER" : "WAITING",
      userId: holder,
      projectId: m.projectId,
      conversationKey: m.conversationId,
      title: m.conversation.customerName ?? m.conversation.title ?? "A customer",
      preview: m.text,
      url: conversationUrl(project, { channelConversationId: m.conversationId }),
      inboxUrl: inboxUrl(project),
    });
  }
  return out;
}

async function deliver(devices: Device[], alert: PushAlert): Promise<void> {
  for (const device of devices) {
    if (!wantsAlert(alert.kind, device)) continue;
    await sendPush(device, { title: alert.title, body: pushBody(alert, device.showPreview), url: alert.url, tag: alert.conversationKey });
  }
}

/** One pass. Never throws. */
export async function pushTick(run: PushRun, nowDate = new Date()): Promise<void> {
  if (!pushConfigured()) return;
  const now = nowDate.getTime();
  // A second behind: a row committed in this same moment is read on the next pass, not skipped.
  const to = new Date(now - 1000);
  if (to <= run.cursor) return;
  const from = run.cursor;
  try {
    const rows = await globalPrisma.pushDevice.findMany({
      where: { user: { isActive: true }, session: { revokedAt: null, expiresAt: { gt: nowDate }, supportAccessSessionId: null } },
      select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true, notifyAssigned: true, notifyCustomerMessages: true, notifyMentions: true, notifyWaiting: true, showPreview: true },
    });
    const byUser = new Map<string, Device[]>();
    for (const d of rows) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);

    if (byUser.size > 0) {
      const pending = await collect(run, from, to, now);
      for (const alert of pending) {
        const project = await projectInfo(run, alert.projectId, now);
        if (!project) continue;
        const recipients = alert.userId ? (byUser.has(alert.userId) ? [alert.userId] : []) : [...byUser.keys()].filter((id) => byUser.get(id)!.some((d) => d.notifyWaiting));
        for (const userId of recipients) {
          if (!(await mayRead(run, userId, project, now))) continue;
          if (alert.kind === "WAITING") {
            const held = run.held.get(userId) ?? { alerts: [], lastSent: 0 };
            held.alerts.push(alert);
            run.held.set(userId, held);
            continue;
          }
          if (alert.kind === "CUSTOMER") {
            const ping = `${userId}:${alert.conversationKey}`;
            if (now - (run.lastPing.get(ping) ?? 0) < CONVERSATION_COOLDOWN_MS) continue;
            run.lastPing.set(ping, now);
          }
          await deliver(byUser.get(userId)!, alert);
        }
      }
    }

    for (const [userId, held] of run.held) {
      if (now - held.lastSent < WAITING_GAP_MS) continue;
      const fresh = held.alerts.filter((a) => now - (run.lastPing.get(`${userId}:${a.conversationKey}`) ?? 0) >= CONVERSATION_COOLDOWN_MS);
      held.alerts = [];
      const alert = collapseWaiting(fresh);
      const devices = byUser.get(userId);
      if (!alert || !devices) continue;
      for (const a of fresh) run.lastPing.set(`${userId}:${a.conversationKey}`, now);
      held.lastSent = now;
      await deliver(devices, alert);
    }
    for (const [key, at] of run.lastPing) if (now - at > CONVERSATION_COOLDOWN_MS) run.lastPing.delete(key);
    run.cursor = to;
  } catch (err) {
    console.error("[push] tick failed", (err as Error).name);
  }
}

export function startPushProcessor(): void {
  const run = newPushRun();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void pushTick(run).finally(() => {
      busy = false;
    });
  }, TICK_MS);
  timer.unref?.();
}
