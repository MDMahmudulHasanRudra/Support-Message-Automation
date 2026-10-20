import { formatDhakaDateKey } from "../dhakaDay.js";
import {
  createReportClassifier,
  createSenderResolver,
  type ReportIdentity,
  type ReportSenderDecision,
  type RosterIdentity,
  type StoredCopyIdentity,
} from "../whatsappIdentity.js";

/**
 * The read-only impact preview of a team-member identity change (04-identity-and-attribution-spec 4.1).
 *
 * It runs the ONE report classifier twice over the same stored messages (once with the roster as it
 * is, once with the roster as it would be) and counts the messages whose label differs. It decides
 * nothing itself (no second sender-identity algorithm) and carries no message text: only conversation
 * keys, times, counts and labels.
 */
export const IDENTITY_PREVIEW_VERSION = "identity-preview-1";
/** The Team Report's own longest custom range. */
export const PREVIEW_DEFAULT_DAYS = 92;
/** The worker re-attribution's own look-back for Duty History. */
export const PREVIEW_MAX_DAYS = 365;
/** Beyond this many logical messages the result says `truncated: true`. */
export const PREVIEW_MAX_LOGICAL = 20_000;
export const PREVIEW_MAX_SAMPLES = 20;
/** The Team Report's own cap on a group filter (`MAX_FILTER_GROUPS`). */
export const PREVIEW_MAX_KPI_GROUPS = 200;

export interface PreviewRosterEntry extends RosterIdentity {
  /** InternalTeamMember.userId: the login link, for dashboard (OPERATOR) replies. */
  userId: string | null;
}

/** One logical message touched by the identifiers, with every stored copy as a witness. */
export interface PreviewMessage {
  logicalKey: string;
  conversationKind: "GROUP" | "PERSONAL";
  /** whatsappGroupId, or `${accountId}|${chatId}`. */
  conversationKey: string;
  ts: number;
  /** Stored rows behind this logical message. */
  storedCopies: number;
  /** The copy the reports keep (`preferSenderCopySql` order). */
  keptCopy: {
    direction: "INCOMING" | "OUTGOING" | "SYSTEM";
    sender: string;
    senderJid: string | null;
    fromTeam: boolean;
    obMatched: boolean;
    actionType: string | null;
    ruleId: string | null;
    createdById: string | null;
  };
  incomingCopies: StoredCopyIdentity[];
}

export type AttributionLabel = "CUSTOMER" | "STAFF_UNIDENTIFIED" | "BUSINESS" | `MEMBER:${string}`;

export interface IdentityPreviewResult {
  version: typeof IDENTITY_PREVIEW_VERSION;
  window: { from: number; to: number };
  truncated: boolean;
  examined: { logicalMessages: number; storedMessages: number };
  affected: {
    logicalMessages: number;
    storedMessages: number;
    /** Distinct GROUP conversation keys with at least one changed message. */
    groups: number;
    /** Distinct PERSONAL conversation keys with at least one changed message. */
    personalConversations: number;
  };
  /** previous to proposed, counted over changed logical messages, count descending. */
  transitions: Array<{ from: AttributionLabel; to: AttributionLabel; count: number }>;
  /** Per member: messages they would gain / lose credit for. */
  byMember: Array<{ memberId: string; gained: number; lost: number }>;
  /** Dhaka days and months containing changed messages (`YYYY-MM-DD` / `YYYY-MM`). */
  impactedDays: Array<{ day: string; changed: number }>;
  impactedMonths: Array<{ month: string; changed: number }>;
  /** Up to 20 samples: conversation key, time and labels only, never text. */
  samples: Array<{ conversationKind: "GROUP" | "PERSONAL"; conversationKey: string; ts: number; from: AttributionLabel; to: AttributionLabel }>;
  /**
   * For the KPI estimate only (the server strips it before anything reaches the browser): the groups
   * (at most `PREVIEW_MAX_KPI_GROUPS`, most-changed first) and the accounts with a changed personal
   * conversation, both within the most recent impacted month.
   */
  kpiScope: { month: string | null; groupKeys: string[]; personalAccountIds: string[] };
}

/** The classifier for one roster: every member, our own ids, the login links. */
export function identityForRoster(roster: readonly PreviewRosterEntry[], ownIds: ReadonlySet<string>): ReportIdentity {
  const memberByUserId = new Map(
    roster.filter((m) => m.userId).map((m) => [m.userId as string, { id: m.id, attributeFrom: m.attributeFrom ?? null }]),
  );
  return createReportClassifier(createSenderResolver(roster), ownIds, memberByUserId);
}

/** A decision as the label the preview compares and prints. */
export function attributionLabelOf(d: ReportSenderDecision): AttributionLabel {
  if (d.memberId) return `MEMBER:${d.memberId}`;
  if (d.kind === "BUSINESS") return "BUSINESS";
  if (d.kind === "MEMBER") return "STAFF_UNIDENTIFIED";
  return "CUSTOMER";
}

function classifyAs(identity: ReportIdentity, m: PreviewMessage): AttributionLabel {
  const k = m.keptCopy;
  return attributionLabelOf(
    identity.classify(
      {
        direction: k.direction,
        sender: k.sender,
        senderJid: k.senderJid,
        fromTeam: k.fromTeam,
        parsedCopies: m.incomingCopies,
        obMatched: k.obMatched,
        actionType: k.actionType,
        ruleId: k.ruleId,
        createdById: k.createdById,
      },
      m.ts,
    ),
  );
}

export function previewIdentityChange(input: {
  rosterBefore: readonly PreviewRosterEntry[];
  rosterAfter: readonly PreviewRosterEntry[];
  ownIds: ReadonlySet<string>;
  messages: readonly PreviewMessage[];
  window: { from: number; to: number };
  truncated: boolean;
}): IdentityPreviewResult {
  const before = identityForRoster(input.rosterBefore, input.ownIds);
  const after = identityForRoster(input.rosterAfter, input.ownIds);

  const transitions = new Map<string, { from: AttributionLabel; to: AttributionLabel; count: number }>();
  const members = new Map<string, { gained: number; lost: number }>();
  const days = new Map<string, number>();
  const groups = new Set<string>();
  const personal = new Set<string>();
  const changed: Array<{ m: PreviewMessage; from: AttributionLabel; to: AttributionLabel }> = [];
  let storedMessages = 0;
  let affectedStored = 0;

  for (const m of input.messages) {
    storedMessages += m.storedCopies;
    const from = classifyAs(before, m);
    const to = classifyAs(after, m);
    if (from === to) continue;
    changed.push({ m, from, to });
    affectedStored += m.storedCopies;
    (m.conversationKind === "GROUP" ? groups : personal).add(m.conversationKey);
    const key = `${from}|${to}`;
    const t = transitions.get(key);
    if (t) t.count++;
    else transitions.set(key, { from, to, count: 1 });
    const bump = (label: AttributionLabel, field: "gained" | "lost") => {
      if (!label.startsWith("MEMBER:")) return;
      const id = label.slice("MEMBER:".length);
      const row = members.get(id) ?? { gained: 0, lost: 0 };
      row[field]++;
      members.set(id, row);
    };
    bump(from, "lost");
    bump(to, "gained");
    const day = formatDhakaDateKey(new Date(m.ts));
    days.set(day, (days.get(day) ?? 0) + 1);
  }

  const months = new Map<string, number>();
  for (const [day, count] of days) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + count);

  // The scope of the KPI estimate: the latest month with a change, its most-changed groups, its personal accounts.
  const latestMonth = [...months.keys()].sort().at(-1) ?? null;
  const groupCounts = new Map<string, number>();
  const personalAccounts = new Set<string>();
  for (const { m } of changed) {
    if (latestMonth === null || formatDhakaDateKey(new Date(m.ts)).slice(0, 7) !== latestMonth) continue;
    if (m.conversationKind === "GROUP") groupCounts.set(m.conversationKey, (groupCounts.get(m.conversationKey) ?? 0) + 1);
    else personalAccounts.add(m.conversationKey.split("|")[0]!);
  }
  const kpiGroupKeys = [...groupCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PREVIEW_MAX_KPI_GROUPS)
    .map(([key]) => key);

  return {
    version: IDENTITY_PREVIEW_VERSION,
    window: input.window,
    truncated: input.truncated,
    examined: { logicalMessages: input.messages.length, storedMessages },
    affected: { logicalMessages: changed.length, storedMessages: affectedStored, groups: groups.size, personalConversations: personal.size },
    transitions: [...transitions.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    byMember: [...members.entries()]
      .map(([memberId, v]) => ({ memberId, ...v }))
      .sort((a, b) => b.gained + b.lost - (a.gained + a.lost) || a.memberId.localeCompare(b.memberId)),
    impactedDays: [...days.entries()].map(([day, c]) => ({ day, changed: c })).sort((a, b) => a.day.localeCompare(b.day)),
    impactedMonths: [...months.entries()].map(([month, c]) => ({ month, changed: c })).sort((a, b) => a.month.localeCompare(b.month)),
    samples: [...changed]
      .sort((a, b) => b.m.ts - a.m.ts || a.m.conversationKey.localeCompare(b.m.conversationKey))
      .slice(0, PREVIEW_MAX_SAMPLES)
      .map(({ m, from, to }) => ({ conversationKind: m.conversationKind, conversationKey: m.conversationKey, ts: m.ts, from, to })),
    kpiScope: { month: latestMonth, groupKeys: kpiGroupKeys, personalAccountIds: [...personalAccounts].sort() },
  };
}

/** What the digest covers: what the user saw, nothing else. The caller canonicalises it. */
export function previewDigestSource(p: IdentityPreviewResult): unknown {
  return { version: p.version, window: p.window, affected: p.affected, transitions: p.transitions, byMember: p.byMember };
}
