import type { Prisma } from "@prisma/client";
import {
  activeSendSeconds,
  attributeOutbound,
  formatDhakaDateKey,
  getDhakaWeekday,
  HUMAN_SEND_SOURCE_LABELS,
  isOutboundSenderType,
  OUTBOUND_SENDER_TYPE_LABELS,
  OUTBOUND_SENDER_TYPES,
  type OutboundSenderType,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { ReportContext } from "./context";
import { count, dayLabel, duration, hourLabel, when, WEEKDAYS } from "./format";
import type { BuiltReport, ReportTable } from "./types";

/**
 * WhatsApp Chat User Activity (WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md §10 O).
 *
 * "Which software user used which WhatsApp account to send what to which group, and when?" Read from
 * the outbound queue — `OutboundMessage`, the record of every send this software made — where two
 * columns answer two different questions: `createdById`, the authenticated user who pressed send
 * (written server-side from the session), and `accountId`, the number it left from. The sender type
 * comes from `attributeOutbound`, the same function the chat thread uses, so "Sent by Rudra via
 * Primary Account" in a conversation is exactly a row here.
 *
 * This is not the Team Report and not Employee Effectiveness: those measure WhatsApp team members by
 * what they wrote in the groups, from their own phones. This measures software users by what they
 * sent through the software. Duty is deliberately absent — a duty roster belongs to a WhatsApp team
 * member, and a software user has no link to one; matching them by phone number would be a guess.
 */

const MAX_ROWS = 50_000;

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Queued",
  PROCESSING: "Sending",
  RATE_LIMITED: "Held by rate limit",
  SENT: "Sent",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  SKIPPED: "Not sent",
};

const NOT_HUMAN: Prisma.OutboundMessageWhereInput = { actionType: { notIn: ["MANUAL_REPLY", "GROUP_BROADCAST"] } };

/** The sender type as a WHERE clause — the same partition `attributeOutbound` draws, in SQL. */
function senderWhere(type: OutboundSenderType | "ALL"): Prisma.OutboundMessageWhereInput {
  switch (type) {
    case "HUMAN_USER":
      return { actionType: "MANUAL_REPLY" };
    case "BROADCAST":
      return { actionType: "GROUP_BROADCAST" };
    case "AI":
      return { ...NOT_HUMAN, aiFallbackDecision: { isNot: null } };
    case "RULE_AUTOMATION":
      return { ...NOT_HUMAN, aiFallbackDecision: { is: null }, ruleId: { not: null } };
    case "SYSTEM":
      return { ...NOT_HUMAN, aiFallbackDecision: { is: null }, ruleId: null };
    default:
      return {};
  }
}

interface Send {
  id: string;
  at: number;
  userId: string | null;
  userName: string;
  username: string | null;
  accountId: string;
  accountLabel: string;
  groupKey: string;
  groupName: string;
  senderType: OutboundSenderType;
  source: string;
  status: string;
  body: string;
  reference: string;
}

const link = (ctx: ReportContext, set: Record<string, string | null>) => {
  const qs = new URLSearchParams(Object.entries(ctx.params).filter(([, v]) => v !== undefined) as Array<[string, string]>);
  for (const [k, v] of Object.entries(set)) {
    if (v === null) qs.delete(k);
    else qs.set(k, v);
  }
  return `/reports/whatsapp-user-activity?${qs.toString()}`;
};

async function loadSends(ctx: ReportContext, senderType: OutboundSenderType | "ALL", userId: string | null) {
  const rows = await prisma.outboundMessage.findMany({
    where: {
      createdAt: { gte: new Date(ctx.rangeStart), lt: new Date(ctx.rangeEnd) },
      ...(ctx.filters.accountId ? { accountId: ctx.filters.accountId } : {}),
      ...(ctx.filters.groupKeys?.length ? { chatId: { in: ctx.filters.groupKeys } } : {}),
      ...(userId ? { createdById: userId } : {}),
      ...senderWhere(senderType),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS + 1,
    select: {
      id: true,
      body: true,
      status: true,
      createdAt: true,
      providerMessageId: true,
      actionType: true,
      ruleId: true,
      idempotencyKey: true,
      accountId: true,
      chatId: true,
      groupNameSnapshot: true,
      aiFallbackDecision: { select: { id: true } },
      account: { select: { label: true } },
      createdBy: { select: { id: true, name: true, username: true } },
    },
  });
  const truncated = rows.length > MAX_ROWS;
  const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;

  // "Sent" is the queue's word; WhatsApp echoing the message back as a stored Message is its
  // confirmation. Looked up in batches by the exact provider id, per account.
  const echoed = new Set<string>();
  const sentIds = kept.filter((r) => r.status === "SENT" && r.providerMessageId).map((r) => `${r.accountId}|${r.providerMessageId}`);
  for (let i = 0; i < sentIds.length; i += 1000) {
    const chunk = sentIds.slice(i, i + 1000).map((k) => {
      const [accountId, whatsappMessageId] = k.split("|") as [string, string];
      return { accountId, whatsappMessageId };
    });
    const found = await prisma.message.findMany({ where: { OR: chunk }, select: { accountId: true, whatsappMessageId: true } });
    for (const f of found) echoed.add(`${f.accountId}|${f.whatsappMessageId}`);
  }

  const sends: Send[] = kept.map((r) => {
    const { senderType, source } = attributeOutbound({
      actionType: r.actionType,
      ruleId: r.ruleId,
      hasAiDecision: r.aiFallbackDecision !== null,
      idempotencyKey: r.idempotencyKey,
    });
    const person = senderType === "HUMAN_USER" || senderType === "BROADCAST" ? r.createdBy : null;
    const confirmed = r.status === "SENT" && echoed.has(`${r.accountId}|${r.providerMessageId}`);
    return {
      id: r.id,
      at: r.createdAt.getTime(),
      userId: person?.id ?? null,
      userName: person?.name ?? (senderType === "HUMAN_USER" || senderType === "BROADCAST" ? "Unknown user" : "—"),
      username: person?.username ?? null,
      accountId: r.accountId,
      accountLabel: r.account.label,
      groupKey: r.chatId,
      groupName: r.groupNameSnapshot ?? ctx.groupName(r.chatId),
      senderType,
      source: source ? HUMAN_SEND_SOURCE_LABELS[source] : OUTBOUND_SENDER_TYPE_LABELS[senderType],
      status: confirmed ? "Sent · confirmed by WhatsApp" : (STATUS_LABELS[r.status] ?? r.status),
      body: r.body,
      reference: r.providerMessageId ?? `queue:${r.id}`,
    };
  });
  return { sends, truncated };
}

const dayKey = (ms: number) => formatDhakaDateKey(new Date(ms));
const daysOf = (sends: Send[]) => new Set(sends.map((s) => dayKey(s.at)));

function messagesTable(ctx: ReportContext, sends: Send[]): ReportTable {
  return {
    id: "messages",
    sheet: "Detailed",
    title: `Messages (${count(sends.length)})`,
    description: "Every send in the filters, newest first — who pressed send, from which WhatsApp account, to which group, and what became of it.",
    noun: { singular: "message", plural: "messages" },
    columns: [
      { label: "Time", muted: true },
      { label: "User" },
      { label: "WhatsApp account" },
      { label: "Group" },
      { label: "Sender type" },
      { label: "Source" },
      { label: "Status" },
      { label: "Message" },
      { label: "Message ID", muted: true },
    ],
    rows: sends.map((s) => ({
      key: s.id,
      href: s.userId ? link(ctx, { user: s.userId }) : null,
      cells: [when(s.at), s.userName, s.accountLabel, s.groupName, OUTBOUND_SENDER_TYPE_LABELS[s.senderType], s.source, s.status, s.body, s.reference],
      sort: [s.at, s.userName.toLowerCase(), s.accountLabel.toLowerCase(), s.groupName.toLowerCase(), s.senderType, s.source, s.status, s.body.toLowerCase(), s.reference],
      sub: [null, s.username ? `@${s.username}` : null, null, s.groupKey, null, null, null, null, null],
    })),
  };
}

function accountTable(sends: Send[]): ReportTable {
  const by = new Map<string, Send[]>();
  for (const s of sends) by.set(s.accountId, [...(by.get(s.accountId) ?? []), s]);
  return {
    id: "accounts",
    sheet: "Breakdown",
    title: "By WhatsApp account",
    description: "Which numbers the messages left from.",
    noun: { singular: "account", plural: "accounts" },
    columns: [{ label: "WhatsApp account" }, { label: "Messages", numeric: true }, { label: "Users", numeric: true }, { label: "Groups", numeric: true }, { label: "Active days", numeric: true }],
    rows: [...by.values()]
      .sort((a, b) => b.length - a.length)
      .map((list) => {
        const users = new Set(list.map((s) => s.userId).filter(Boolean)).size;
        const groups = new Set(list.map((s) => s.groupKey)).size;
        const days = daysOf(list).size;
        return { key: list[0]!.accountId, cells: [list[0]!.accountLabel, list.length, users, groups, days], sort: [list[0]!.accountLabel.toLowerCase(), list.length, users, groups, days] };
      }),
  };
}

function groupTable(ctx: ReportContext, sends: Send[], userId: string | null): ReportTable {
  const by = new Map<string, Send[]>();
  for (const s of sends) by.set(s.groupKey, [...(by.get(s.groupKey) ?? []), s]);
  return {
    id: "groups",
    sheet: "Breakdown",
    title: "By group",
    description: userId ? "Select a group for its messages." : "Select a group to narrow the report to it.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "Messages", numeric: true },
      { label: "Users", numeric: true },
      { label: "Accounts", numeric: true },
      { label: "First", muted: true },
      { label: "Last", muted: true },
    ],
    rows: [...by.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([groupKey, list]) => {
        const users = new Set(list.map((s) => s.userId).filter(Boolean)).size;
        const accounts = new Set(list.map((s) => s.accountId)).size;
        const first = Math.min(...list.map((s) => s.at));
        const last = Math.max(...list.map((s) => s.at));
        return {
          key: groupKey,
          href: link(ctx, { groups: groupKey }),
          cells: [list[0]!.groupName, list.length, users, accounts, when(first), when(last)],
          sort: [list[0]!.groupName.toLowerCase(), list.length, users, accounts, first, last],
          sub: [groupKey, null, null, null, null, null],
        };
      }),
  };
}

function perDayVisual(ctx: ReportContext, sends: Send[]) {
  const counts = new Map<string, number>();
  for (const s of sends) counts.set(dayKey(s.at), (counts.get(dayKey(s.at)) ?? 0) + 1);
  const data: Array<{ label: string; value: number }> = [];
  for (let t = ctx.rangeStart; t < ctx.rangeEnd; t += 86_400_000) {
    const key = dayKey(t);
    if (!data.length || data[data.length - 1]!.label !== dayLabel(key)) data.push({ label: dayLabel(key), value: counts.get(key) ?? 0 });
  }
  return { kind: "columns" as const, title: "Messages per day", description: "Asia/Dhaka days.", unit: "messages", data };
}

function heatmap(sends: Send[]) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const s of sends) grid[getDhakaWeekday(new Date(s.at))]![new Date(s.at + 6 * 3_600_000).getUTCHours()]! += 1;
  return grid;
}

function busiest(grid: number[][]): { day: string; hour: string } {
  const byDay = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h]!, 0));
  const day = byDay.indexOf(Math.max(...byDay));
  const hour = byHour.indexOf(Math.max(...byHour));
  return { day: Math.max(...byDay) > 0 ? WEEKDAYS[day]! : "—", hour: Math.max(...byHour) > 0 ? `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}` : "—" };
}

const FORMULAS = [
  { title: "Where this comes from", text: "The outbound queue: one row for every message this software sent or tried to send. The software user is the authenticated person who pressed send, recorded on the server from their session; the WhatsApp account is the number it left from. They are two different things — several people can send from one number." },
  { title: "Sender type", text: "Human user: typed in WhatsApp Chat (or a notification template test). Broadcast: a person's confirmed bulk send. AI: the AI fallback's reply. Rule automation: an automation rule's reply. System: any other automated send, such as the AI handover mention. The chat thread labels messages with exactly the same rule." },
  { title: "Status", text: "The queue's state. \"Sent · confirmed by WhatsApp\" means WhatsApp echoed the message back and it is stored in the conversation; \"Sent\" alone means the send completed and the echo has not been stored. WhatsApp delivery and read receipts are not recorded." },
  { title: "Active days and time", text: "An active day is an Asia/Dhaka day with at least one message. Estimated active time joins one person's sends into stretches, split wherever they were quiet longer than the Team Report's idle gap or crossed midnight, each measured first send to last; a single send is zero." },
  { title: "What is not here", text: "Messages typed on the phone itself, or by a team member on their own WhatsApp, never pass through this software and are not in this report — the Team Report covers those. Duty is not shown: a duty roster belongs to a WhatsApp team member, and a software user has no link to one." },
];

export async function buildUserActivity(ctx: ReportContext): Promise<BuiltReport> {
  const senderParam = ctx.params.sender;
  const senderType: OutboundSenderType | "ALL" = senderParam === "ALL" ? "ALL" : isOutboundSenderType(senderParam) ? senderParam : "HUMAN_USER";
  const userId = ctx.params.user?.trim() || null;

  const [{ sends, truncated }, userOptions] = await Promise.all([
    loadSends(ctx, senderType, userId),
    // Everyone who sent something in the period (whatever the user filter), so the picker can widen
    // back out; the user lookup is the platform user table, joined only through this project's rows.
    prisma.outboundMessage.findMany({
      where: { createdAt: { gte: new Date(ctx.rangeStart), lt: new Date(ctx.rangeEnd) }, createdById: { not: null } },
      distinct: ["createdById"],
      select: { createdBy: { select: { id: true, name: true, username: true } } },
    }),
  ]);
  const users = userOptions.map((r) => r.createdBy).filter((u): u is NonNullable<typeof u> => u !== null).sort((a, b) => a.name.localeCompare(b.name));
  const selectedUser = userId ? (users.find((u) => u.id === userId) ?? null) : null;

  const selects = [
    {
      name: "user",
      label: "Software user",
      value: userId ?? "",
      options: [{ value: "", label: "All users" }, ...users.map((u) => ({ value: u.id, label: `${u.name} (@${u.username})` }))],
    },
    {
      name: "sender",
      label: "Sender type",
      value: senderType,
      options: [...OUTBOUND_SENDER_TYPES.map((t) => ({ value: t, label: OUTBOUND_SENDER_TYPE_LABELS[t] })), { value: "ALL", label: "All sender types" }],
    },
  ];

  const notes: BuiltReport["notes"] = [
    { tone: "info", text: "Read from the messages this software sent. Collection gaps in incoming WhatsApp messages do not affect these figures." },
  ];
  if (truncated) notes.push({ tone: "warning", text: `More than ${count(MAX_ROWS)} messages match; the newest ${count(MAX_ROWS)} are counted. Narrow the period or filters.` });

  const humanSide = senderType === "HUMAN_USER" || senderType === "BROADCAST" || senderType === "ALL";
  const grid = heatmap(sends);
  const peak = busiest(grid);
  const first = sends.length ? Math.min(...sends.map((s) => s.at)) : null;
  const last = sends.length ? Math.max(...sends.map((s) => s.at)) : null;
  const activeDays = daysOf(sends).size;
  const base: Pick<BuiltReport, "id" | "formulas" | "selects" | "usesGranularity" | "usesMemberFilters" | "sourceHelp"> = {
    id: "whatsapp-user-activity",
    formulas: FORMULAS,
    selects,
    usesGranularity: false,
    usesMemberFilters: false,
    sourceHelp: "Every figure here is read from the outbound queue — the messages this software sent — for the period, WhatsApp account and groups chosen above. Days and hours are Asia/Dhaka.",
  };

  if (userId) {
    const who = selectedUser ? `${selectedUser.name}` : "Unknown user";
    const accounts = new Set(sends.map((s) => s.accountId)).size;
    const groups = new Set(sends.map((s) => s.groupKey)).size;
    return {
      ...base,
      title: `WhatsApp Chat User Activity — ${who}`,
      question: `What did ${who} send through this software, from which WhatsApp accounts, to which groups, and when?`,
      tiles: [
        { label: "Messages", value: count(sends.length) },
        { label: "WhatsApp accounts used", value: count(accounts) },
        { label: "Groups", value: count(groups) },
        { label: "Active days", value: count(activeDays) },
        { label: "First message", value: when(first) },
        { label: "Last message", value: when(last) },
        { label: "Estimated active time", value: duration(activeSendSeconds(sends.map((s) => s.at), ctx.idleGapMs)), hint: "stretches split at the idle gap" },
        { label: "Busiest hour", value: peak.hour, hint: peak.day !== "—" ? `busiest day: ${peak.day}` : undefined },
      ],
      visuals: sends.length ? [perDayVisual(ctx, sends)] : [],
      tables: [accountTable(sends), { ...groupTable(ctx, sends, userId), title: `Groups ${who} sent to` }, messagesTable(ctx, sends)],
      notes: [...notes, { tone: "info", text: `${who}${selectedUser ? ` (@${selectedUser.username})` : ""}. Back to everyone: clear "Software user" above.` }],
      emptyMessage: sends.length ? null : `${who} sent nothing through this software in ${ctx.data.range.label} for these filters.`,
    };
  }

  const byUser = new Map<string, Send[]>();
  for (const s of sends) if (s.userId) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  const userTable: ReportTable = {
    id: "users",
    sheet: "Breakdown",
    title: "By software user",
    description: "Select a person for their accounts, groups and every message.",
    noun: { singular: "user", plural: "users" },
    columns: [
      { label: "User" },
      { label: "Messages", numeric: true },
      { label: "Accounts", numeric: true },
      { label: "Groups", numeric: true },
      { label: "Active days", numeric: true },
      { label: "Per active day", numeric: true },
      { label: "Estimated active time" },
      { label: "First activity", muted: true },
      { label: "Last activity", muted: true },
    ],
    rows: [...byUser.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, list]) => {
        const days = daysOf(list).size;
        const accounts = new Set(list.map((s) => s.accountId)).size;
        const groups = new Set(list.map((s) => s.groupKey)).size;
        const active = activeSendSeconds(list.map((s) => s.at), ctx.idleGapMs);
        const firstAt = Math.min(...list.map((s) => s.at));
        const lastAt = Math.max(...list.map((s) => s.at));
        const perDay = Math.round((list.length / days) * 10) / 10;
        return {
          key: id,
          href: link(ctx, { user: id }),
          cells: [list[0]!.userName, list.length, accounts, groups, days, perDay, duration(active), when(firstAt), when(lastAt)],
          sort: [list[0]!.userName.toLowerCase(), list.length, accounts, groups, days, perDay, active, firstAt, lastAt],
          sub: [list[0]!.username ? `@${list[0]!.username}` : null, null, null, null, null, null, null, null, null],
        };
      }),
  };

  return {
    ...base,
    title: "WhatsApp Chat User Activity",
    question: "Which software user sent which WhatsApp messages, through which account, to which groups — and when?",
    tiles: [
      { label: "Messages", value: count(sends.length), hint: senderType === "ALL" ? "all sender types" : OUTBOUND_SENDER_TYPE_LABELS[senderType].toLowerCase() },
      { label: "Active users", value: humanSide ? count(byUser.size) : "—", hint: humanSide ? undefined : "automation has no user" },
      { label: "WhatsApp accounts used", value: count(new Set(sends.map((s) => s.accountId)).size) },
      { label: "Groups", value: count(new Set(sends.map((s) => s.groupKey)).size) },
      { label: "Active days", value: count(activeDays) },
      { label: "Per active day", value: activeDays ? String(Math.round((sends.length / activeDays) * 10) / 10) : "—" },
      { label: "First message", value: when(first) },
      { label: "Last message", value: when(last) },
      { label: "Busiest hour", value: peak.hour, hint: peak.day !== "—" ? `busiest day: ${peak.day}` : undefined },
    ],
    visuals: sends.length
      ? [perDayVisual(ctx, sends), { kind: "heatmap" as const, title: "When messages were sent", description: "By weekday and hour, Asia/Dhaka. Darker is more.", unit: "messages", grid }]
      : [],
    tables: [...(humanSide ? [userTable] : []), accountTable(sends), groupTable(ctx, sends, null), messagesTable(ctx, sends)],
    notes,
    emptyMessage: sends.length ? null : `Nothing was sent through this software in ${ctx.data.range.label} for these filters.`,
  };
}
