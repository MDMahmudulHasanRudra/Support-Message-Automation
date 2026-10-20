import { DEFAULT_CASE_GAP_MS, type IntelActor } from "../intelligence/model.js";
import { median } from "../supportReports.js";

/**
 * Customer-specific reply attribution for GROUPS (06-algorithms §3). The legacy Team Report wait is per
 * group ("somebody replied in the group"); this answers, BESIDE it, "which customer did that reply
 * answer?" — and only from evidence a person could check:
 *
 *   TIER1_QUOTE      the reply quotes that customer's own line (WhatsApp's own link, not a guess)
 *   TIER2_MENTION    the reply @-mentions that customer, and exactly one open ask is theirs
 *   TIER2_SEQUENCE   exactly one customer is waiting in the group, they spoke within the window, and nobody
 *                    else spoke since they asked — nothing contradicts the link
 *
 * A reply no rule can place is TIER4_UNRESOLVED and closes nothing: "no reply could be linked to this customer"
 * is not evidence that the customer was ignored. TIER3_PROBABLE is RESERVED and never produced; no inferred,
 * fuzzy or AI-suggested link is ever made or counted here (see enrichment.ts), and every figure is a count.
 *
 * Pure: input order is the Team Report's own order (ts, then storage time, then the loader's stable order); no
 * clock, no map-iteration order in any output. A customer is a cluster of ids — a LID and a phone number that
 * ONE message was stored under are the same person — and an id is only ever compared by its user part, never
 * shown here (the page shows a customer through `describeSenderId`; a LID is never printed as a number).
 */

export const REPLY_LINK_TIERS = ["TIER1_QUOTE", "TIER2_MENTION", "TIER2_SEQUENCE", "TIER3_PROBABLE", "TIER4_UNRESOLVED"] as const;
export type ReplyLinkTier = (typeof REPLY_LINK_TIERS)[number];
/** The tiers whose link rests on evidence in the conversation itself. TIER3_PROBABLE is deliberately absent. */
export const VERIFIED_LINK_TIERS: ReadonlySet<ReplyLinkTier> = new Set<ReplyLinkTier>(["TIER1_QUOTE", "TIER2_MENTION", "TIER2_SEQUENCE"]);
export const REPLY_ATTRIBUTION_VERSION = "reply-attribution-1";

export const REPLY_TIER_LABELS: Record<ReplyLinkTier, string> = {
  TIER1_QUOTE: "Quoted the customer's message",
  TIER2_MENTION: "Mentioned the customer",
  TIER2_SEQUENCE: "Only customer waiting",
  TIER3_PROBABLE: "Probable (not produced)",
  TIER4_UNRESOLVED: "Could not be linked",
};

/** Why a reply could not be linked, in words a person can act on. */
export const UNRESOLVED_REASON_LABELS: Record<string, string> = {
  NO_OPEN_ASK: "Nobody was waiting",
  MULTIPLE_OPEN_ASKS: "Several customers were waiting",
  MULTIPLE_MENTIONED: "Mentioned several waiting customers",
  MENTIONED_OTHER_CUSTOMER: "Mentioned a customer who was not waiting",
  OTHER_CUSTOMER_SPOKE: "Another customer wrote in between",
  OUTSIDE_WINDOW: "The customer's last message was too long before",
};

export interface ReplyEvidenceMessage {
  /** `logicalMessageKey(wgid, wamid)` */
  key: string;
  /** The WhatsApp group id. */
  groupKey: string;
  ts: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;
  memberId: string | null;
  /** CUSTOMER only: the user parts of every incoming copy's sender id, sorted and unique. */
  customerIds: string[];
  /** The logical key of the message this one quotes (same group), or null. */
  quotedKey: string | null;
  /** `Message.mentionedPhones` of the kept copy, user parts. */
  mentionedIds: string[];
  /** Inside [rangeStart, rangeEnd); false for context and look-ahead rows. */
  inPeriod: boolean;
}

export interface ReplyAttributionOptions {
  rangeStart: number;
  rangeEnd: number;
  measuredTo: number;
  /** The group's "missed" threshold when the customer asked (the Team Report's own). */
  thresholdMs: (groupKey: string, at: number) => number;
  /** How long after a customer's last line a lone-customer reply may still be linked by sequence. Default 4 h. */
  sequenceWindowMs?: number;
  /** Fill `asksDetail` for this one group (the drill-down). */
  detailGroupKey?: string;
}

export interface ReplyAttributionResult {
  version: typeof REPLY_ATTRIBUTION_VERSION;
  asks: {
    total: number;
    answeredTier1: number;
    answeredTier2Mention: number;
    answeredTier2Sequence: number;
    unanswered: number;
    pending: number;
    /** Customer lines with no sender id: left out of every ask, counted here. */
    noCustomerId: number;
  };
  replies: {
    total: number;
    byTier: Record<ReplyLinkTier, number>;
    unresolvedReasons: Record<string, number>;
    /** Broadcasts: sent to everyone, so they answer nobody. */
    notAReply: number;
  };
  /** Median / 90th percentile over asks answered by a linking tier. */
  customerSpecificWait: { medianSeconds: number | null; p90Seconds: number | null; samples: number };
  byGroup: Array<{ groupKey: string; asks: number; answeredVerified: number; unanswered: number; repliesUnresolved: number }>;
  byMember: Array<{ memberId: string; asksAnswered: number; medianSeconds: number | null }>;
  asksDetail?: Array<{
    groupKey: string;
    customerKey: string;
    askedAt: number;
    answeredAt: number | null;
    tier: ReplyLinkTier | null;
    answeredBy: { actor: IntelActor; memberId: string | null } | null;
  }>;
}

interface Ask {
  customerKey: string;
  groupKey: string;
  askedAt: number;
  keys: Set<string>;
  lastAt: number;
  counted: boolean;
  answeredAt: number | null;
  tier: ReplyLinkTier | null;
  answeredBy: { actor: IntelActor; memberId: string | null } | null;
}

/**
 * An id as compared: exactly as WhatsApp wrote its user part. Never digit-normalised (06 §3.3 compares digits, but
 * `normalizePhoneNumber` rewrites an id that looks like a local "01…" number, and a LID is not a phone number — it
 * must never be rewritten into one). WhatsApp's own ids are already in one form, so equality is exact.
 */
const comparable = (id: string): string => id.trim();

const emptyByTier = (): Record<ReplyLinkTier, number> => ({ TIER1_QUOTE: 0, TIER2_MENTION: 0, TIER2_SEQUENCE: 0, TIER3_PROBABLE: 0, TIER4_UNRESOLVED: 0 });

function percentile90(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}

export function computeReplyAttribution(messages: readonly ReplyEvidenceMessage[], opts: ReplyAttributionOptions): ReplyAttributionResult {
  const window = opts.sequenceWindowMs ?? DEFAULT_CASE_GAP_MS;
  const inRange = (ts: number) => ts >= opts.rangeStart && ts < opts.rangeEnd;

  // ---- Step 0: customer identity clusters (union-find over the ids ONE message was stored under) ----
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps the tree flat; the root is unaffected, so the output is unchanged.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    // The lexicographically smallest id is always the root, so the cluster's key never depends on input order.
    if (ra < rb) parent.set(rb, ra);
    else if (rb < ra) parent.set(ra, rb);
  };
  for (const m of messages) {
    if (m.kind !== "CUSTOMER") continue;
    for (const id of m.customerIds) if (!parent.has(id)) parent.set(id, id);
    for (let i = 1; i < m.customerIds.length; i++) union(m.customerIds[0]!, m.customerIds[i]!);
  }
  const customerKey = (ids: readonly string[]) => find(ids[0]!);
  // Every id of each cluster, in comparable form, for mention matching.
  // Indexed by the comparable id, so a mention is looked up rather than scanned against every customer of the
  // report (a reply-by-customer scan cost seconds on a month of a large roster). One comparable id can belong to
  // several clusters only if two ids compare equal, so each maps to the set of roots it names.
  const rootsOfId = new Map<string, Set<string>>();
  for (const id of [...parent.keys()].sort()) {
    const key = comparable(id);
    const roots = rootsOfId.get(key) ?? new Set<string>();
    roots.add(find(id));
    rootsOfId.set(key, roots);
  }

  // ---- Step 1: walk each group in order ----
  const byGroup = new Map<string, ReplyEvidenceMessage[]>();
  for (const m of messages) {
    const list = byGroup.get(m.groupKey) ?? [];
    list.push(m);
    byGroup.set(m.groupKey, list);
  }

  const asksResult = { total: 0, answeredTier1: 0, answeredTier2Mention: 0, answeredTier2Sequence: 0, unanswered: 0, pending: 0, noCustomerId: 0 };
  const repliesResult = { total: 0, byTier: emptyByTier(), unresolvedReasons: {} as Record<string, number>, notAReply: 0 };
  const groupRows = new Map<string, { asks: number; answeredVerified: number; unanswered: number; repliesUnresolved: number }>();
  const groupRow = (groupKey: string) => {
    let row = groupRows.get(groupKey);
    if (!row) {
      row = { asks: 0, answeredVerified: 0, unanswered: 0, repliesUnresolved: 0 };
      groupRows.set(groupKey, row);
    }
    return row;
  };
  const waitTimes: number[] = [];
  const allAsks: Ask[] = [];

  for (const groupKey of [...byGroup.keys()].sort()) {
    const open = new Map<string, Ask>();
    const askOfKey = new Map<string, Ask>();
    /** Every customer line so far: who spoke and when. `null` = a line with no sender id, an unknown speaker. */
    const spoke: Array<{ ts: number; customer: string | null }> = [];
    /** The customers who have written in THIS group: a mention only means a customer here. */
    const customersHere = new Set<string>();

    for (const m of byGroup.get(groupKey)!) {
      if (m.kind === "CUSTOMER") {
        if (m.customerIds.length === 0) {
          // An unknown speaker: never an ask of its own, but it contradicts a lone-customer link, so it is recorded.
          spoke.push({ ts: m.ts, customer: null });
          if (m.inPeriod) asksResult.noCustomerId += 1;
          continue;
        }
        const key = customerKey(m.customerIds);
        spoke.push({ ts: m.ts, customer: key });
        customersHere.add(key);
        const existing = open.get(key);
        if (existing) {
          existing.keys.add(m.key);
          existing.lastAt = m.ts;
          askOfKey.set(m.key, existing);
        } else {
          const ask: Ask = { customerKey: key, groupKey, askedAt: m.ts, keys: new Set([m.key]), lastAt: m.ts, counted: inRange(m.ts), answeredAt: null, tier: null, answeredBy: null };
          open.set(key, ask);
          askOfKey.set(m.key, ask);
          allAsks.push(ask);
        }
        continue;
      }

      // ---- A reply ----
      if (m.actor === "BROADCAST") {
        if (m.inPeriod) repliesResult.notAReply += 1;
        continue;
      }
      let tier: ReplyLinkTier = "TIER4_UNRESOLVED";
      let reason: string | null = null;
      let target: Ask | null = null;
      let closes = false;

      const quoted = m.quotedKey ? askOfKey.get(m.quotedKey) : undefined;
      if (quoted) {
        // The customer's own line, quoted: the one link that needs no judgement. An ask already answered is
        // not reopened — this is a follow-up to it, and nobody else's ask is credited.
        tier = "TIER1_QUOTE";
        target = quoted;
        closes = open.get(quoted.customerKey) === quoted;
      } else {
        // Open asks whose customer the reply @-mentions.
        const mentionedRoots = new Set<string>();
        for (const id of m.mentionedIds) for (const root of rootsOfId.get(comparable(id)) ?? []) if (customersHere.has(root)) mentionedRoots.add(root);
        const mentionedClusters = [...mentionedRoots].sort();
        const mentionedOpen = mentionedClusters.filter((root) => open.has(root));
        if (mentionedOpen.length === 1) {
          tier = "TIER2_MENTION";
          target = open.get(mentionedOpen[0]!)!;
          closes = true;
        } else if (mentionedOpen.length > 1) {
          reason = "MULTIPLE_MENTIONED";
        } else if (mentionedClusters.length > 0) {
          // It names a customer who is not waiting. That is evidence about WHO it is for, so it is never
          // credited to a different customer by sequence.
          reason = "MENTIONED_OTHER_CUSTOMER";
        } else if (open.size === 0) {
          reason = "NO_OPEN_ASK";
        } else if (open.size > 1) {
          reason = "MULTIPLE_OPEN_ASKS";
        } else {
          const only = [...open.values()][0]!;
          if (m.ts - only.lastAt > window) reason = "OUTSIDE_WINDOW";
          else if (spoke.some((s) => s.ts > only.askedAt && s.ts < m.ts && s.customer !== only.customerKey)) reason = "OTHER_CUSTOMER_SPOKE";
          else {
            tier = "TIER2_SEQUENCE";
            target = only;
            closes = true;
          }
        }
      }

      let closedCounted = false;
      if (target && closes) {
        target.answeredAt = m.ts;
        target.tier = tier;
        target.answeredBy = { actor: m.actor, memberId: m.memberId };
        open.delete(target.customerKey);
        closedCounted = target.counted;
      }
      // A reply is counted when it is in the period, or when it answered an ask that is (the look-ahead).
      if (m.inPeriod || closedCounted) {
        repliesResult.total += 1;
        repliesResult.byTier[tier] += 1;
        if (tier === "TIER4_UNRESOLVED") {
          repliesResult.unresolvedReasons[reason ?? "NO_OPEN_ASK"] = (repliesResult.unresolvedReasons[reason ?? "NO_OPEN_ASK"] ?? 0) + 1;
          groupRow(groupKey).repliesUnresolved += 1;
        }
      }
    }
  }

  // ---- Step 2: the asks of the period, and how each ended ----
  const members = new Map<string, number[]>();
  for (const ask of allAsks) {
    if (!ask.counted) continue;
    asksResult.total += 1;
    const row = groupRow(ask.groupKey);
    row.asks += 1;
    if (ask.answeredAt !== null && ask.tier && VERIFIED_LINK_TIERS.has(ask.tier)) {
      if (ask.tier === "TIER1_QUOTE") asksResult.answeredTier1 += 1;
      else if (ask.tier === "TIER2_MENTION") asksResult.answeredTier2Mention += 1;
      else asksResult.answeredTier2Sequence += 1;
      row.answeredVerified += 1;
      const seconds = Math.max(0, Math.round((ask.answeredAt - ask.askedAt) / 1000));
      waitTimes.push(seconds);
      const memberId = ask.answeredBy?.memberId ?? null;
      if (memberId) {
        const list = members.get(memberId) ?? [];
        list.push(seconds);
        members.set(memberId, list);
      }
    } else if (opts.measuredTo - ask.askedAt > opts.thresholdMs(ask.groupKey, ask.askedAt)) {
      asksResult.unanswered += 1;
      row.unanswered += 1;
    } else {
      asksResult.pending += 1;
    }
  }

  const sortedWaits = [...waitTimes].sort((a, b) => a - b);
  const byMember = [...members]
    .map(([memberId, times]) => ({ memberId, asksAnswered: times.length, medianSeconds: median([...times].sort((a, b) => a - b)) }))
    .sort((a, b) => b.asksAnswered - a.asksAnswered || a.memberId.localeCompare(b.memberId));

  const result: ReplyAttributionResult = {
    version: REPLY_ATTRIBUTION_VERSION,
    asks: asksResult,
    replies: repliesResult,
    customerSpecificWait: { medianSeconds: median(sortedWaits), p90Seconds: percentile90(sortedWaits), samples: sortedWaits.length },
    byGroup: [...groupRows].map(([groupKey, row]) => ({ groupKey, ...row })).sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
    byMember,
  };
  if (opts.detailGroupKey !== undefined) {
    result.asksDetail = allAsks
      .filter((a) => a.counted && a.groupKey === opts.detailGroupKey)
      .map((a) => ({ groupKey: a.groupKey, customerKey: a.customerKey, askedAt: a.askedAt, answeredAt: a.answeredAt, tier: a.tier, answeredBy: a.answeredBy }))
      .sort((a, b) => a.askedAt - b.askedAt || a.customerKey.localeCompare(b.customerKey));
  }
  return result;
}
