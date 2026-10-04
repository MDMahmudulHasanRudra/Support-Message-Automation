import type { ReportWait } from "./teamReport.js";

/**
 * Executive Support Health (REPORTS.md): the exception list management acts on. Pure, so the rules
 * the report page and its export show are the rules the tests pin.
 *
 * It is not a ranking of groups or of people. A group appears only when something about it needs
 * somebody: a customer still waiting, answers that came late, a group gone silent, or a group whose
 * activity has fallen sharply against the previous period. Each group appears ONCE, under its most
 * urgent issue, with any others named beside it.
 */

export const ATTENTION_ISSUES = ["PROLONGED_UNANSWERED", "UNANSWERED", "SLA_BREACH", "NO_COMMUNICATION", "DECLINING"] as const;
export type AttentionIssue = (typeof ATTENTION_ISSUES)[number];

export const ATTENTION_ISSUE_LABELS: Record<AttentionIssue, string> = {
  PROLONGED_UNANSWERED: "Prolonged unanswered",
  UNANSWERED: "Unanswered",
  SLA_BREACH: "SLA breach",
  NO_COMMUNICATION: "No communication",
  DECLINING: "Declining activity",
};

/** A group's activity has "fallen sharply" when it is at most this share of the previous period… */
export const DECLINE_MAX_RATIO = 0.5;
/** …and the previous period had at least this many messages, so a drop from 2 to 1 is not a "decline". */
export const DECLINE_MIN_PREVIOUS = 10;

/**
 * Change from a previous figure to a current one, as a ratio (−0.744 = down 74.4%). Null when there
 * was nothing before: a change from zero has no honest percentage, and "+∞%" is not one.
 */
export function changeRatio(previous: number, current: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export interface AttentionGroupInput {
  groupKey: string;
  /** Stored messages of any kind in the period. */
  messagesInPeriod: number;
  /** The same count for the previous period of equal length. */
  messagesPreviousPeriod: number;
  /** The latest stored message before the period end, or null when there is none. */
  lastActivityAt: number | null;
}

export interface AttentionItem {
  groupKey: string;
  issue: AttentionIssue;
  /** The other issues this group also has, most urgent first. */
  alsoIssues: AttentionIssue[];
  /** The detail behind the main issue, in words. */
  detail: string;
  /** How long the oldest unanswered customer has waited, or the worst late answer — null when not a wait. */
  waitingSeconds: number | null;
  lastActivityAt: number | null;
}

const severity = (issue: AttentionIssue) => ATTENTION_ISSUES.indexOf(issue);

/** "2h 14m", "48m", "3d 4h". */
export function shortDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * The attention list for a period.
 *
 * - Unanswered: a wait in the period with no reply yet (still waiting or missed). Its waiting time
 *   runs from the customer's message to `measuredTo` (the period end, or now if it has not ended).
 *   At `prolongedSeconds` or more it is Prolonged unanswered.
 * - SLA breach: waits answered, but after their threshold. The waiting figure is the worst of them.
 * - No communication: not one stored message in the period.
 * - Declining: at most DECLINE_MAX_RATIO of the previous period's messages, from at least
 *   DECLINE_MIN_PREVIOUS — and not silent (that is No communication).
 *
 * Ordered by issue, then by the longest wait or silence.
 */
export function attentionItems(input: {
  groups: readonly AttentionGroupInput[];
  waits: readonly ReportWait[];
  measuredTo: number;
  prolongedSeconds: number;
}): AttentionItem[] {
  const waitsByGroup = new Map<string, ReportWait[]>();
  for (const w of input.waits) {
    const list = waitsByGroup.get(w.groupKey);
    if (list) list.push(w);
    else waitsByGroup.set(w.groupKey, [w]);
  }

  const items: Array<{ item: AttentionItem; order: number }> = [];
  for (const g of input.groups) {
    const waits = waitsByGroup.get(g.groupKey) ?? [];
    const found: Array<{ issue: AttentionIssue; detail: string; waitingSeconds: number | null; order: number }> = [];

    const unanswered = waits.filter((w) => w.repliedAt === null);
    if (unanswered.length) {
      const oldest = Math.min(...unanswered.map((w) => w.askedAt));
      const waiting = Math.max(0, Math.round((input.measuredTo - oldest) / 1000));
      const issue: AttentionIssue = waiting >= input.prolongedSeconds ? "PROLONGED_UNANSWERED" : "UNANSWERED";
      found.push({
        issue,
        detail: `${unanswered.length} customer wait${unanswered.length === 1 ? "" : "s"} with no reply, oldest ${shortDuration(waiting)}`,
        waitingSeconds: waiting,
        order: waiting,
      });
    }

    const late = waits.filter((w) => w.status === "RECALLED" && w.waitSeconds !== null);
    if (late.length) {
      const worst = Math.max(...late.map((w) => w.waitSeconds!));
      found.push({
        issue: "SLA_BREACH",
        detail: `${late.length} answer${late.length === 1 ? "" : "s"} after the SLA, worst ${shortDuration(worst)}`,
        waitingSeconds: worst,
        order: worst,
      });
    }

    const silenceSeconds = g.lastActivityAt === null ? null : Math.max(0, Math.round((input.measuredTo - g.lastActivityAt) / 1000));
    if (g.messagesInPeriod === 0) {
      found.push({
        issue: "NO_COMMUNICATION",
        detail:
          silenceSeconds === null
            ? "No communication · never recorded"
            : `No communication · ${Math.floor(silenceSeconds / 86_400)} days since last activity`,
        waitingSeconds: null,
        order: silenceSeconds ?? Number.MAX_SAFE_INTEGER,
      });
    } else {
      const ratio = changeRatio(g.messagesPreviousPeriod, g.messagesInPeriod);
      if (g.messagesPreviousPeriod >= DECLINE_MIN_PREVIOUS && ratio !== null && g.messagesInPeriod <= g.messagesPreviousPeriod * DECLINE_MAX_RATIO) {
        found.push({
          issue: "DECLINING",
          detail: `Activity down ${Math.round(-ratio * 1000) / 10}% (${g.messagesPreviousPeriod} → ${g.messagesInPeriod} messages)`,
          waitingSeconds: null,
          order: -ratio,
        });
      }
    }

    if (!found.length) continue;
    found.sort((a, b) => severity(a.issue) - severity(b.issue));
    const main = found[0]!;
    items.push({
      item: {
        groupKey: g.groupKey,
        issue: main.issue,
        alsoIssues: found.slice(1).map((f) => f.issue),
        detail: main.detail,
        waitingSeconds: main.waitingSeconds,
        lastActivityAt: g.lastActivityAt,
      },
      order: main.order,
    });
  }

  return items
    .sort((a, b) => severity(a.item.issue) - severity(b.item.issue) || b.order - a.order || a.item.groupKey.localeCompare(b.item.groupKey))
    .map(({ item }) => item);
}
