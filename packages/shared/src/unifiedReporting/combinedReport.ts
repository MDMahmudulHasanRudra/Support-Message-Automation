import type { HumanWait } from "../intelligence/model.js";
import { formatHoursMinutes } from "../duration.js";
import { median, responseStats } from "../supportReports.js";
import type { ReportWait, TeamReportSummary } from "../teamReport.js";
import { isVerifiedHumanActor, REPLY_CATEGORIES_OF_REPLIES, REPLY_CATEGORY_LABELS, type ResponseMetrics } from "../teamReportReliability.js";
import type { PersonalReportResult } from "./personalReport.js";

/**
 * The "groups and personal chats" table (05-group-and-personal-reporting-spec §4). The two reports are
 * computed independently; this only sets their figures side by side and adds the ones that CAN be added.
 * Every combined cell says how it was combined:
 *
 *   ADDITIVE                   group + personal (the conversations are disjoint by construction)
 *   RECOMPUTED                 over the union of both lists of waits — never an average of two medians
 *   ADDITIVE_DIFFERENT_UNITS   a sum of two things that are each "one conversation"
 *   GROUP_ONLY                 a group concept (support time, overtime, groups supported): personal shows nothing
 *   NOT_COMBINABLE             a customer in a group and in a one-to-one chat can be a LID in one and a phone in
 *                              the other, so a distinct-customer figure would be a guess: not offered
 */

export type Additivity = "ADDITIVE" | "RECOMPUTED" | "ADDITIVE_DIFFERENT_UNITS" | "GROUP_ONLY" | "NOT_COMBINABLE";

export const ADDITIVITY_LABELS: Record<Additivity, string> = {
  ADDITIVE: "Added together",
  RECOMPUTED: "Recalculated over both, not averaged",
  ADDITIVE_DIFFERENT_UNITS: "Added: a group and a personal chat are each one conversation",
  GROUP_ONLY: "Groups only",
  NOT_COMBINABLE: "Cannot be combined",
};

export interface CombinedLine {
  label: string;
  group: number | string | null;
  personal: number | string | null;
  combined: number | string | null;
  additivity: Additivity;
  note: string;
}

const duration = (seconds: number | null): string | null => (seconds === null ? null : formatHoursMinutes(seconds));

/** Time to a verified person's first reply, over the human waits a verified person ended — `computeResponseMetrics`' own rule. */
function verifiedHumanTimes(waits: readonly HumanWait[]): number[] {
  const times: number[] = [];
  for (const wait of waits) {
    if (wait.repliedBy && isVerifiedHumanActor(wait.repliedBy.actor) && wait.waitSeconds !== null) times.push(wait.waitSeconds);
  }
  return times.sort((a, b) => a - b);
}

export function combineReportSummaries(input: {
  group: {
    summary: TeamReportSummary;
    response: ResponseMetrics;
    /** The waits behind `response` (the groups the report is answerable for). */
    waits: readonly ReportWait[];
    humanWaits: readonly HumanWait[];
    groupsWithMessages: number;
  };
  personal: PersonalReportResult;
}): CombinedLine[] {
  const { group, personal } = input;
  const g = group.summary;
  const p = personal.summary;
  const sum = (label: string, gv: number, pv: number, note = ""): CombinedLine => ({ label, group: gv, personal: pv, combined: gv + pv, additivity: "ADDITIVE", note });
  const groupOnly = (label: string, value: number | string | null, note: string): CombinedLine => ({
    label,
    group: value,
    personal: null,
    combined: value,
    additivity: "GROUP_ONLY",
    note,
  });

  const groupWaitStats = group.response.firstResponse;
  const personalWaitStats = personal.response.firstResponse;
  const allWaits = responseStats([...group.waits, ...personal.waits]);
  const groupHumanTimes = verifiedHumanTimes(group.humanWaits);
  const personalHumanTimes = verifiedHumanTimes(personal.humanWaits);
  const allHumanTimes = [...groupHumanTimes, ...personalHumanTimes].sort((a, b) => a - b);

  const lines: CombinedLine[] = [
    sum("Customer messages", g.customerMessages, p.customerMessages, "Customers' messages in groups, and in one-to-one chats with a customer."),
    sum(
      "Verified employee replies",
      g.memberReplies - g.unattributedStaffReplies,
      p.verifiedEmployeeReplies,
      "A team member on their own WhatsApp (groups) or a dashboard reply by a login linked to a member (both). Staff the roster cannot name are in no person's count.",
    ),
    sum(
      "Business number replies",
      g.businessReplies,
      p.businessReplies - p.verifiedEmployeeReplies,
      "Sent from our own number and credited to no named person: the AI, a rule, a broadcast, an unlinked login, or the phone.",
    ),
    sum("Customer waits", g.waits, p.waits, "A customer message that needed a reply; a run of lines is one wait."),
    sum("Missed", g.missed, p.missed, "Waits that went past their threshold (answered late, or never)."),
    sum("Recall support", g.recalled, p.recalled, "Missed, then answered."),
    sum("Never answered", g.unrecovered, p.unrecovered, ""),
    sum("Still inside the threshold", groupWaitStats.pending, personalWaitStats.pending, ""),
  ];
  for (const category of REPLY_CATEGORIES_OF_REPLIES) {
    lines.push(sum(`First reply came from: ${REPLY_CATEGORY_LABELS[category]}`, group.response.firstReplyBy[category], personal.response.firstReplyBy[category]));
  }
  lines.push(
    {
      label: "Median first observed response",
      group: duration(groupWaitStats.medianSeconds),
      personal: duration(personalWaitStats.medianSeconds),
      combined: duration(allWaits.medianSeconds),
      additivity: "RECOMPUTED",
      note: "Any reply ends a wait. The middle of every wait in both, not the average of the two middles.",
    },
    {
      label: "90th percentile first observed response",
      group: duration(groupWaitStats.p90Seconds),
      personal: duration(personalWaitStats.p90Seconds),
      combined: duration(allWaits.p90Seconds),
      additivity: "RECOMPUTED",
      note: "",
    },
    {
      label: "Median first human response",
      group: duration(group.response.human.medianSeconds),
      personal: duration(personal.response.human.medianSeconds),
      combined: duration(median(allHumanTimes)),
      additivity: "RECOMPUTED",
      note: "Only a person's reply ends it; measured over the waits a verified person ended.",
    },
    {
      label: "Conversations",
      group: group.groupsWithMessages,
      personal: p.conversations,
      combined: group.groupsWithMessages + p.conversations,
      additivity: "ADDITIVE_DIFFERENT_UNITS",
      note: "Groups with a message, plus personal chats with a message.",
    },
    {
      label: "Distinct customers",
      group: null,
      personal: null,
      combined: null,
      additivity: "NOT_COMBINABLE",
      note: "A customer in a group and in a personal chat can be a hidden id in one and a phone number in the other, so they cannot be matched.",
    },
    groupOnly("Groups supported", g.groupsSupported, "A group concept."),
    groupOnly("Active team members", g.activeMembers, "Members with a message in a group."),
    groupOnly("Support time", duration(g.activeSeconds), "The group timeline; personal replies do not enter it."),
    groupOnly("Support Overtime", duration(g.overtimeSeconds), "Beyond regular duty, per day; personal replies do not enter it."),
  );
  return lines;
}
