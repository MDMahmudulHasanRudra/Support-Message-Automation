import { Prisma } from "@prisma/client";
import {
  CHANNELS,
  clampCsatCooldownDays,
  CSAT_CHANNEL_LABELS,
  CSAT_CHANNELS,
  CSAT_QUESTION_MAX_LENGTH,
  csatChannelEnabled,
  csatChannelForConversation,
  csatChannelForWhatsApp,
  csatCustomerKey,
  DEFAULT_CSAT_SWITCHES,
  summarizeCsat,
  type ChannelType,
  type ConversationRef,
  type CsatChannel,
  type CsatChannelSwitches,
  type CsatSummary,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";

/**
 * Post-conversation CSAT in the dashboard (CSAT.md, feature CSAT_SURVEYS, off by default): the project's
 * settings, the survey a resolution records, the conversation panel's history and the CSAT report. Nothing here
 * sends anything — the worker asks a PENDING survey through the channel's one send queue — and every query goes
 * through the project-scoped client, so another project's survey is simply not found.
 */

export interface CsatSettingsView extends CsatChannelSwitches {
  /** Null = the built-in Bangla/English question. */
  questionText: string | null;
  cooldownDays: number;
}

export async function loadCsatSettings(): Promise<CsatSettingsView> {
  const row = await prisma.csatSettings.findFirst({
    select: { whatsappPersonalEnabled: true, webchatEnabled: true, messengerEnabled: true, instagramEnabled: true, telegramEnabled: true, questionText: true, cooldownDays: true },
  });
  return row ?? { ...DEFAULT_CSAT_SWITCHES, questionText: null, cooldownDays: 7 };
}

/** Saves the settings, clamped on the server whatever the form sent. An empty question means the built-in one. */
export async function saveCsatSettings(input: Partial<Record<keyof CsatChannelSwitches, unknown>> & { questionText?: unknown; cooldownDays?: unknown }, actorId: string): Promise<void> {
  const projectId = await activeProjectId();
  const question = typeof input.questionText === "string" ? input.questionText.trim().slice(0, CSAT_QUESTION_MAX_LENGTH) : "";
  const data = {
    whatsappPersonalEnabled: input.whatsappPersonalEnabled === true,
    webchatEnabled: input.webchatEnabled === true,
    messengerEnabled: input.messengerEnabled === true,
    instagramEnabled: input.instagramEnabled === true,
    telegramEnabled: input.telegramEnabled === true,
    questionText: question || null,
    cooldownDays: clampCsatCooldownDays(input.cooldownDays),
    updatedById: actorId,
  };
  await prisma.csatSettings.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
}

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * A person just resolved a conversation (changeConversationStatus, after its RESOLVE event committed): record one
 * PENDING survey for that resolution when the project asks on this channel. Keyed on the RESOLVE event, so a
 * replay records nothing twice. Never a WhatsApp group or a channel group thread. Best effort and never throws:
 * the resolution has already happened, and a survey that cannot be recorded is simply not asked.
 */
export async function recordCsatSurveyForResolution(ref: ConversationRef, input: { eventId: string; resolvedAt: Date; actorId: string }): Promise<void> {
  try {
    if ((await activeDisabledFeatures()).has("CSAT_SURVEYS")) return;
    const settings = await loadCsatSettings();
    const projectId = await activeProjectId();
    const base = { projectId, resolutionEventId: input.eventId, resolvedAt: input.resolvedAt, resolvedById: input.actorId };
    if (ref.kind === "whatsapp") {
      const channel = csatChannelForWhatsApp(ref.chatId);
      if (!channel || !csatChannelEnabled(settings, channel)) return;
      const state = await prisma.whatsAppConversationState.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId }, select: { assignedTeamId: true } });
      await prisma.csatSurvey.create({
        data: { ...base, channel, accountId: ref.accountId, chatId: ref.chatId, customerKey: csatCustomerKey({ kind: "whatsapp", chatId: ref.chatId }), teamId: state?.assignedTeamId ?? null },
      });
      return;
    }
    const conversation = await prisma.channelConversation.findFirst({
      where: { id: ref.conversationId },
      select: { type: true, kind: true, connectionId: true, externalThreadId: true, assignedTeamId: true },
    });
    if (!conversation) return;
    const channel = csatChannelForConversation(conversation.type, conversation.kind);
    if (!channel || !csatChannelEnabled(settings, channel)) return;
    await prisma.csatSurvey.create({
      data: {
        ...base,
        channel,
        channelConversationId: ref.conversationId,
        customerKey: csatCustomerKey({ kind: "channel", connectionId: conversation.connectionId, externalThreadId: conversation.externalThreadId }),
        teamId: conversation.assignedTeamId,
      },
    });
  } catch (err) {
    if (isUnique(err)) return;
    console.error("[csat] could not record a survey for a resolution", err);
  }
}

export interface ConversationCsatView {
  id: string;
  status: "PENDING" | "SENT" | "SKIPPED";
  skipReason: string | null;
  resolvedAt: string;
  sentAt: string | null;
  rating: number | null;
  answeredAt: string | null;
  /** Only for a viewer who may read messages (the customer's own words). */
  comment: string | null;
  /** Asked, and the customer's next message was not a rating (or 24 hours passed). */
  closedUnanswered: boolean;
}

/** The newest surveys of one conversation, for the workspace panel. Empty while CSAT_SURVEYS is off. */
export async function loadConversationCsat(ref: ConversationRef, canReadMessages: boolean, take = 5): Promise<ConversationCsatView[]> {
  if ((await activeDisabledFeatures()).has("CSAT_SURVEYS")) return [];
  const rows = await prisma.csatSurvey.findMany({
    where: ref.kind === "whatsapp" ? { accountId: ref.accountId, chatId: ref.chatId } : { channelConversationId: ref.conversationId },
    orderBy: { resolvedAt: "desc" },
    take,
    select: { id: true, status: true, skipReason: true, resolvedAt: true, sentAt: true, rating: true, answeredAt: true, comment: true, answerClosedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    skipReason: r.skipReason,
    resolvedAt: r.resolvedAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    rating: r.rating,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    comment: canReadMessages ? r.comment : null,
    closedUnanswered: r.status === "SENT" && r.rating === null && r.answerClosedAt !== null,
  }));
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────────

export interface CsatReportRow {
  id: string;
  channel: CsatChannel;
  channelLabel: string;
  sentAt: string;
  customer: string;
  agentName: string;
  teamName: string | null;
  rating: number | null;
  comment: string | null;
  /** Project-relative link to the conversation. */
  href: string;
}

export interface CsatReportGroup {
  key: string;
  label: string;
  summary: CsatSummary;
}

export interface CsatReport {
  summary: CsatSummary;
  /** Surveys of resolutions in the period that were not asked, by reason (the cooldown, a closed window…). */
  skipped: Array<{ reason: string; count: number }>;
  byAgent: CsatReportGroup[];
  byChannel: CsatReportGroup[];
  rows: CsatReportRow[];
  /** More surveys matched than the list shows. */
  truncated: boolean;
}

const LIST_LIMIT = 500;

/**
 * The CSAT report for [start, end): surveys ASKED in the period (sentAt), and the ones not asked among the
 * resolutions of the period. Every figure comes from `summarizeCsat` (packages/shared), so the tiles, the agent
 * rows and the channel rows use one formula. Comments only for a viewer who may read messages.
 */
export async function loadCsatReport(range: { start: Date; end: Date }, options: { canReadMessages: boolean }): Promise<CsatReport> {
  const asked = await prisma.csatSurvey.findMany({
    where: { status: "SENT", sentAt: { gte: range.start, lt: range.end } },
    orderBy: { sentAt: "desc" },
    select: {
      id: true,
      channel: true,
      sentAt: true,
      rating: true,
      comment: true,
      resolvedById: true,
      teamId: true,
      accountId: true,
      chatId: true,
      channelConversationId: true,
      channelConversation: { select: { type: true, customerName: true, customerUsername: true, title: true } },
    },
  });
  const skippedRows = await prisma.csatSurvey.groupBy({
    by: ["skipReason"],
    where: { status: "SKIPPED", resolvedAt: { gte: range.start, lt: range.end } },
    _count: { _all: true },
  });

  const userIds = [...new Set(asked.map((r) => r.resolvedById).filter((id): id is string => Boolean(id)))];
  const teamIds = [...new Set(asked.map((r) => r.teamId).filter((id): id is string => Boolean(id)))];
  const [users, teams] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    teamIds.length ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : [],
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const agentOf = (id: string | null) => (id ? (userName.get(id) ?? "Former user") : "Unknown");

  const group = (keyOf: (r: (typeof asked)[number]) => string, labelOf: (key: string) => string): CsatReportGroup[] => {
    const buckets = new Map<string, Array<{ asked: boolean; rating: number | null }>>();
    for (const r of asked) {
      const key = keyOf(r);
      const list = buckets.get(key) ?? [];
      list.push({ asked: true, rating: r.rating });
      buckets.set(key, list);
    }
    return [...buckets.entries()]
      .map(([key, rows]) => ({ key, label: labelOf(key), summary: summarizeCsat(rows) }))
      .sort((a, b) => b.summary.asked - a.summary.asked || a.label.localeCompare(b.label));
  };

  const rows: CsatReportRow[] = asked.slice(0, LIST_LIMIT).map((r) => {
    const c = r.channelConversation;
    const customer = c ? (c.customerName ?? (c.customerUsername ? `@${c.customerUsername}` : (c.title ?? "Customer"))) : describeChat(r.chatId ?? "");
    const href =
      r.channelConversationId && c
        ? `/conversations/${CHANNELS[c.type as ChannelType]?.slug ?? "all"}/c/${r.channelConversationId}`
        : `/chat/account/${r.accountId}/personal/${encodeURIComponent(r.chatId ?? "")}`;
    return {
      id: r.id,
      channel: r.channel,
      channelLabel: CSAT_CHANNEL_LABELS[r.channel],
      sentAt: r.sentAt!.toISOString(),
      customer,
      agentName: agentOf(r.resolvedById),
      teamName: r.teamId ? (teamName.get(r.teamId) ?? null) : null,
      rating: r.rating,
      comment: options.canReadMessages ? r.comment : null,
      href,
    };
  });

  return {
    summary: summarizeCsat(asked.map((r) => ({ asked: true, rating: r.rating }))),
    skipped: skippedRows
      .map((s) => ({ reason: s.skipReason ?? "Not asked", count: s._count._all }))
      .sort((a, b) => b.count - a.count),
    byAgent: group((r) => r.resolvedById ?? "", (key) => agentOf(key || null)),
    byChannel: group((r) => r.channel, (key) => CSAT_CHANNEL_LABELS[key as CsatChannel] ?? key),
    rows,
    truncated: asked.length > LIST_LIMIT,
  };
}

/** A WhatsApp personal chat in words: a phone number from a @c.us id, never a LID shown as a number. */
function describeChat(chatId: string): string {
  if (chatId.endsWith("@c.us")) return `+${chatId.slice(0, -5)}`;
  return "WhatsApp contact";
}

export const CSAT_CHANNEL_OPTIONS = CSAT_CHANNELS.map((c) => ({ value: c, label: CSAT_CHANNEL_LABELS[c] }));
