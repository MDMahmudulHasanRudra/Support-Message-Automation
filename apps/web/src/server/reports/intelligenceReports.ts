import {
  CASE_STATE_LABELS,
  changeRatio,
  CLOSED_CASE_STATES,
  DATA_CONFIDENCE_LABELS,
  DIMENSION_FORMULAS,
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  DIMENSIONS,
  ELIGIBILITY,
  formatDhakaDateKey,
  INTEL_ACTOR_LABELS,
  LEADERBOARDS,
  leaderboard,
  PREFERENCE_MIN_INTERACTIONS,
  PREFERENCE_MIN_SIGNALS,
  responseStats,
  volumeEfficiencyNote,
  type EmployeeEffectiveness,
  type HumanWait,
  type SupportCase,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { loadIntelligence, type IntelligenceData } from "@/server/intelligence/loader";
import { loadReportContext, type ReportContext } from "./context";
import { count, duration, percent, when } from "./format";
import { waitsInScope } from "./responseReports";
import type { BuiltReport, ReportTable, ReportTile } from "./types";

/**
 * Support Intelligence reports (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md): the layer above the
 * operational reports. Each builder reads `loadIntelligence` (one bounded query + the pure model) and
 * returns a BuiltReport, so the page, CSV and Excel are the same object.
 *
 * Wording rule: a fact is stated; an inference says "inferred" and its confidence; a small sample
 * says "insufficient sample"; data that was not collected says so. Nothing here is a verdict on
 * anyone's overall performance — it measures support visible in WhatsApp records.
 */

const VALIDATION_NOTE =
  "Inferred figures (cases, ownership, hand-offs, resolution, appreciation) come from rules that read the conversation. They have been tested against constructed conversations, and must be checked against real ISP Digital conversations with the read-only validation script before they are relied on.";

const caseLink = (ctx: ReportContext, groupKey: string) => {
  const qs = new URLSearchParams(Object.entries(ctx.params).filter(([, v]) => v !== undefined) as Array<[string, string]>);
  qs.set("groups", groupKey);
  qs.delete("member");
  return `/reports/support-cases?${qs.toString()}`;
};
const employeeLink = (ctx: ReportContext, memberId: string) => {
  const qs = new URLSearchParams(Object.entries(ctx.params).filter(([, v]) => v !== undefined) as Array<[string, string]>);
  qs.set("member", memberId);
  return `/reports/employee-effectiveness?${qs.toString()}`;
};

const name = (intel: IntelligenceData, memberId: string | null) => (memberId ? (intel.memberNames.get(memberId) ?? "Unknown team member") : "—");
const conf = (c: string | null | undefined) => (c ? `${c.charAt(0)}${c.slice(1).toLowerCase()}` : "—");
const seconds = (a: number, b: number) => Math.max(0, Math.round((b - a) / 1000));

async function operatorNames(intel: IntelligenceData): Promise<Map<string, string>> {
  const ids = [...new Set(intel.waits.map((w) => w.repliedBy?.operatorUserId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function answeredBy(intel: IntelligenceData, w: HumanWait, operators: Map<string, string>): string {
  if (!w.repliedBy) return "—";
  if (w.repliedBy.actor === "MEMBER") return name(intel, w.repliedBy.memberId);
  if (w.repliedBy.actor === "OPERATOR") return `${operators.get(w.repliedBy.operatorUserId ?? "") ?? "Dashboard operator"} (dashboard)`;
  return INTEL_ACTOR_LABELS[w.repliedBy.actor];
}

const HUMAN_STATUS_LABELS: Record<HumanWait["status"], string> = { ON_TIME: "On time", LATE: "Late", MISSED: "Missed", PENDING: "Still waiting" };

function humanStats(waits: readonly HumanWait[]) {
  const answered = waits.filter((w) => w.waitSeconds !== null).map((w) => w.waitSeconds!).sort((a, b) => a - b);
  const onTime = waits.filter((w) => w.status === "ON_TIME").length;
  const late = waits.filter((w) => w.status === "LATE").length;
  const missed = waits.filter((w) => w.status === "MISSED").length;
  const pending = waits.filter((w) => w.status === "PENDING").length;
  const decided = onTime + late + missed;
  return {
    waits: waits.length,
    onTime,
    late,
    missed,
    pending,
    sla: decided ? onTime / decided : null,
    median: answered.length ? answered[Math.floor((answered.length - 1) / 2)]! : null,
    average: answered.length ? Math.round(answered.reduce((a, b) => a + b, 0) / answered.length) : null,
    automatedFirst: waits.filter((w) => w.automatedFirstAt !== null).length,
  };
}

// ---------------------------------------------------------------------------------------------
// Human Response SLA

export async function buildHumanResponseSla(ctx: ReportContext): Promise<BuiltReport> {
  const intel = await loadIntelligence(ctx);
  const operators = await operatorNames(intel);
  const waits = intel.waits;
  const s = humanStats(waits);
  const existing = responseStats(waitsInScope(ctx));
  const byResponder = new Map<string, HumanWait[]>();
  for (const w of waits) if (w.repliedBy) byResponder.set(answeredBy(intel, w, operators), [...(byResponder.get(answeredBy(intel, w, operators)) ?? []), w]);
  const byGroup = new Map<string, HumanWait[]>();
  for (const w of waits) byGroup.set(w.groupKey, [...(byGroup.get(w.groupKey) ?? []), w]);

  const detail: ReportTable = {
    id: "waits",
    sheet: "Detailed",
    title: `Customer waits for a person (${count(waits.length)})`,
    description: "Newest first. Only a person's reply ends a wait; an AI or rule reply is shown beside it but does not.",
    noun: { singular: "wait", plural: "waits" },
    columns: [
      { label: "Group" },
      { label: "Customer asked", muted: true },
      { label: "Status" },
      { label: "Waited for a person" },
      { label: "Target" },
      { label: "First automated reply" },
      { label: "Answered by" },
      { label: "Answered", muted: true },
    ],
    rows: [...waits]
      .sort((a, b) => b.askedAt - a.askedAt)
      .map((w) => {
        const waited = w.waitSeconds ?? seconds(w.askedAt, intel.measuredTo);
        return {
          key: `${w.groupKey}|${w.askedAt}`,
          href: caseLink(ctx, w.groupKey),
          cells: [
            ctx.groupName(w.groupKey),
            when(w.askedAt),
            HUMAN_STATUS_LABELS[w.status],
            duration(waited),
            duration(w.thresholdSeconds),
            w.automatedFirstAt ? `${INTEL_ACTOR_LABELS[w.automatedFirstActor!]} after ${duration(seconds(w.askedAt, w.automatedFirstAt))}` : "—",
            answeredBy(intel, w, operators),
            w.repliedAt ? when(w.repliedAt) : "—",
          ],
          sort: [ctx.groupName(w.groupKey).toLowerCase(), w.askedAt, w.status, waited, w.thresholdSeconds, w.automatedFirstAt ?? 0, answeredBy(intel, w, operators).toLowerCase(), w.repliedAt ?? 0],
          sub: [w.groupKey, null, null, null, null, null, null, null],
        };
      }),
  };
  const statCols = [
    { label: "Waits", numeric: true },
    { label: "On time", numeric: true },
    { label: "Late", numeric: true },
    { label: "Missed", numeric: true },
    { label: "Still waiting", numeric: true },
    { label: "Human SLA" },
    { label: "Median" },
    { label: "AI/rule replied first", numeric: true },
  ];
  const statRow = (ws: HumanWait[]) => {
    const x = humanStats(ws);
    return { cells: [x.waits, x.onTime, x.late, x.missed, x.pending, percent(x.sla), duration(x.median), x.automatedFirst], sort: [x.waits, x.onTime, x.late, x.missed, x.pending, x.sla ?? -1, x.median ?? Number.MAX_SAFE_INTEGER, x.automatedFirst] };
  };
  const groups: ReportTable = {
    id: "groups",
    sheet: "Breakdown",
    title: "By group",
    description: "Lowest human SLA first. Select a group for its cases.",
    noun: { singular: "group", plural: "groups" },
    columns: [{ label: "Group" }, ...statCols],
    rows: [...byGroup.entries()]
      .map(([groupKey, ws]) => ({ groupKey, ws, x: humanStats(ws) }))
      .sort((a, b) => (a.x.sla ?? 2) - (b.x.sla ?? 2) || b.x.waits - a.x.waits)
      .map(({ groupKey, ws }) => {
        const r = statRow(ws);
        return { key: groupKey, href: caseLink(ctx, groupKey), cells: [ctx.groupName(groupKey), ...r.cells], sort: [ctx.groupName(groupKey).toLowerCase(), ...r.sort], sub: [groupKey, null, null, null, null, null, null, null, null] };
      }),
  };
  const responders: ReportTable = {
    id: "responders",
    sheet: "Breakdown",
    title: "Who answered",
    description: "Employees on their own WhatsApp, dashboard operators, and the business phone (a person, but not identifiable).",
    noun: { singular: "responder", plural: "responders" },
    columns: [{ label: "Answered by" }, { label: "Waits answered", numeric: true }, { label: "On time", numeric: true }, { label: "Late", numeric: true }, { label: "Median" }],
    rows: [...byResponder.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([who, ws]) => {
        const x = humanStats(ws);
        return { key: who, cells: [who, x.waits, x.onTime, x.late, duration(x.median)], sort: [who.toLowerCase(), x.waits, x.onTime, x.late, x.median ?? 0] };
      }),
  };

  return {
    id: "human-response-sla",
    title: "Human Response SLA",
    question: "How fast does a person answer a customer, and how often within the target?",
    tiles: [
      { label: "Customer waits", value: count(s.waits), hint: "a run of customer messages is one wait" },
      { label: "Human SLA", value: percent(s.sla), hint: "answered by a person within the target", tone: s.sla !== null && s.sla < 0.8 ? "warning" : "neutral" },
      { label: "Response SLA (existing)", value: percent(existing.slaRatio), hint: "any reply counts — AI and rules included" },
      { label: "Median human response", value: duration(s.median) },
      { label: "Average human response", value: duration(s.average) },
      { label: "Answered late", value: count(s.late), tone: s.late ? "warning" : "neutral" },
      { label: "Never answered by a person", value: count(s.missed), tone: s.missed ? "danger" : "neutral" },
      { label: "Still waiting", value: count(s.pending) },
      { label: "AI or rule replied first", value: count(s.automatedFirst), hint: "before any person did" },
    ],
    visuals: [],
    tables: [detail, groups, responders],
    notes: [
      {
        tone: "info",
        text: "The existing Response SLA report is unchanged: it counts any reply from our number — a person, a rule or the AI. This report counts only a person's reply, so the two percentages differ whenever automation answered first.",
      },
    ],
    formulas: [
      { title: "Wait", text: "The Team Report's wait: a customer message after a person's reply (or none) starts one; a run of customer messages is one wait; the next reply from a PERSON ends it. AI, rule and broadcast replies are recorded beside the wait and never end it." },
      { title: "Person", text: "An employee writing from their own WhatsApp (named), a reply typed in the dashboard's chat (the operator), or somebody on the business phone (a person, but which one cannot be known)." },
      { title: "Target and status", text: "The target is the Team Report's Missed threshold for the group. On time: answered within it. Late: answered after it. Missed: never answered by a person, older than the target. Still waiting: inside the target. Human SLA = on time ÷ (on time + late + missed)." },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: waits.length === 0 ? `No customer wait started in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Support cases

const CASE_FILTERS = ["all", "attention", "open", "resolved", "missed", "reopened", "handoff"] as const;

function caseRow(ctx: ReportContext, intel: IntelligenceData, c: SupportCase) {
  const firstHuman = c.firstHumanReplyAt === null ? null : seconds(c.openedAt, c.firstHumanReplyAt);
  const handoff = c.handoffs.filter((h) => h.confidence !== "LOW");
  return {
    key: c.id,
    href: caseLink(ctx, c.groupKey),
    cells: [
      ctx.groupName(c.groupKey),
      when(c.openedAt),
      CASE_STATE_LABELS[c.state],
      c.resolution ? `${conf(c.resolution.confidence)} — ${c.resolution.basis}` : c.state === "ABANDONED" ? "Low — no further contact (not counted as resolved)" : "—",
      c.resolution ? c.resolution.evidence.text : "—",
      c.owner ? `${name(intel, c.owner.memberId)} (${conf(c.owner.confidence)})` : "—",
      c.owner ? c.owner.reasons.join("; ") : "No employee replied",
      handoff.length ? handoff.map((h) => `${name(intel, h.memberId)} · ${conf(h.confidence)}${h.returned ? " · came back" : ""}`).join("; ") : "—",
      `${c.complexity.charAt(0)}${c.complexity.slice(1).toLowerCase()}${c.complexityReasons.length ? ` — ${c.complexityReasons.join("; ")}` : ""}`,
      firstHuman === null ? "—" : duration(firstHuman),
      `${c.customerMessages} / ${c.teamMessages}`,
      c.reopened ? "Yes" : "No",
      c.escalated ? "Yes" : "No",
    ],
    sort: [
      ctx.groupName(c.groupKey).toLowerCase(),
      c.openedAt,
      c.state,
      c.resolution?.confidence ?? "Z",
      c.resolution?.evidence.text ?? "",
      c.owner ? name(intel, c.owner.memberId).toLowerCase() : "~",
      c.owner?.reasons.length ?? 0,
      handoff.length,
      c.complexity,
      firstHuman ?? Number.MAX_SAFE_INTEGER,
      c.customerMessages + c.teamMessages,
      c.reopened ? 1 : 0,
      c.escalated ? 1 : 0,
    ],
    sub: [c.groupKey, null, null, null, null, null, null, null, null, null, null, null, null],
  };
}

const CASE_COLUMNS = [
  { label: "Group" },
  { label: "Opened", muted: true },
  { label: "State" },
  { label: "Resolution (inferred)" },
  { label: "Resolution evidence" },
  { label: "Owner (inferred)" },
  { label: "Why this owner" },
  { label: "Internal hand-off (inferred)" },
  { label: "Complexity" },
  { label: "First human reply" },
  { label: "Customer / team messages" },
  { label: "Reopened" },
  { label: "SLA escalation" },
];

export async function buildSupportCases(ctx: ReportContext): Promise<BuiltReport> {
  const intel = await loadIntelligence(ctx);
  const filter = (CASE_FILTERS as readonly string[]).includes(ctx.params.status ?? "") ? (ctx.params.status as (typeof CASE_FILTERS)[number]) : "all";
  const cases = intel.cases;
  const isOpen = (c: SupportCase) => !CLOSED_CASE_STATES.has(c.state) || (c.state === "RESOLVED" && !c.closed);
  const shown = cases.filter((c) =>
    filter === "all"
      ? true
      : filter === "attention"
        ? c.state === "MISSED" || c.state === "ACTIVE" || c.state === "REOPENED" || c.state === "ESCALATED" || c.state === "WAITING_INTERNAL"
        : filter === "open"
          ? isOpen(c)
          : filter === "resolved"
            ? c.state === "RESOLVED"
            : filter === "missed"
              ? c.state === "MISSED"
              : filter === "reopened"
                ? c.reopened
                : c.handoffs.some((h) => h.confidence !== "LOW"),
  );
  const resolvedHigh = cases.filter((c) => c.resolution?.confidence === "HIGH").length;
  const resolvedMedium = cases.filter((c) => c.resolution?.confidence === "MEDIUM").length;
  const handoffs = cases.filter((c) => c.handoffs.some((h) => h.confidence !== "LOW")).length;

  const byGroup = new Map<string, SupportCase[]>();
  for (const c of cases) byGroup.set(c.groupKey, [...(byGroup.get(c.groupKey) ?? []), c]);
  const groupTable: ReportTable = {
    id: "groups",
    sheet: "Breakdown",
    title: "By group",
    description: "Every group with a case in the period. Select a group to see only its cases and sessions.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "Cases", numeric: true },
      { label: "Resolved (High/Medium)", numeric: true },
      { label: "Resolution rate" },
      { label: "Missed", numeric: true },
      { label: "Reopened", numeric: true },
      { label: "Hand-offs", numeric: true },
      { label: "Complex", numeric: true },
      { label: "Employees", numeric: true },
      { label: "Median first human reply" },
    ],
    rows: [...byGroup.entries()]
      .map(([groupKey, list]) => {
        const resolved = list.filter((c) => c.resolution && c.resolution.confidence !== "LOW").length;
        const firsts = list.filter((c) => c.firstHumanReplyAt !== null).map((c) => seconds(c.openedAt, c.firstHumanReplyAt!)).sort((a, b) => a - b);
        const med = firsts.length ? firsts[Math.floor((firsts.length - 1) / 2)]! : null;
        const missed = list.filter((c) => c.state === "MISSED").length;
        const reopened = list.filter((c) => c.reopened).length;
        const ho = list.filter((c) => c.handoffs.some((h) => h.confidence !== "LOW")).length;
        const complex = list.filter((c) => c.complexity === "COMPLEX").length;
        const employees = new Set(list.flatMap((c) => c.memberIds)).size;
        return {
          key: groupKey,
          href: caseLink(ctx, groupKey),
          cells: [ctx.groupName(groupKey), list.length, resolved, percent(list.length ? resolved / list.length : null), missed, reopened, ho, complex, employees, duration(med)],
          sort: [ctx.groupName(groupKey).toLowerCase(), list.length, resolved, list.length ? resolved / list.length : 0, missed, reopened, ho, complex, employees, med ?? Number.MAX_SAFE_INTEGER],
          sub: [groupKey, null, null, null, null, null, null, null, null, null],
        };
      })
      .sort((a, b) => (b.sort[4] as number) - (a.sort[4] as number) || (b.sort[1] as number) - (a.sort[1] as number)),
  };
  const sessionTable: ReportTable = {
    id: "sessions",
    sheet: "Breakdown",
    title: `Support sessions (${count(intel.sessions.length)})`,
    description: "One employee's interaction with one group: first to last message, split where they went quiet in that group past the idle gap.",
    noun: { singular: "session", plural: "sessions" },
    columns: [{ label: "Team member" }, { label: "Group" }, { label: "Started", muted: true }, { label: "Duration" }, { label: "Messages", numeric: true }, { label: "Cases", numeric: true }, { label: "Case state" }],
    rows: intel.sessions.map((s) => ({
      key: s.id,
      href: employeeLink(ctx, s.memberId),
      cells: [name(intel, s.memberId), ctx.groupName(s.groupKey), when(s.start), duration(seconds(s.start, s.end)), s.messages, s.caseIds.length, s.state === "NO_CASE" ? "No case" : CASE_STATE_LABELS[s.state]],
      sort: [name(intel, s.memberId).toLowerCase(), ctx.groupName(s.groupKey).toLowerCase(), s.start, s.end - s.start, s.messages, s.caseIds.length, s.state],
      sub: [null, s.groupKey, null, null, null, null, null],
    })),
  };

  return {
    id: "support-cases",
    title: "Support Cases",
    question: "Which customer problems were raised, who took them on, and were they resolved?",
    tiles: [
      { label: "Cases", value: count(cases.length), hint: "opened in the period" },
      { label: "Resolved — High", value: count(resolvedHigh), hint: "customer confirmed, or an admin resolved", tone: "success" },
      { label: "Resolved — Medium", value: count(resolvedMedium), hint: "employee stated the fix, no complaint after" },
      { label: "Resolution rate (inferred)", value: percent(cases.length ? (resolvedHigh + resolvedMedium) / cases.length : null), hint: "High + Medium ÷ cases" },
      { label: "No further contact", value: count(cases.filter((c) => c.state === "ABANDONED").length), hint: "stopped after a reply — not counted as resolved" },
      { label: "Missed", value: count(cases.filter((c) => c.state === "MISSED").length), tone: cases.some((c) => c.state === "MISSED") ? "danger" : "neutral" },
      { label: "Open now", value: count(cases.filter(isOpen).length) },
      { label: "Reopened", value: count(cases.filter((c) => c.reopened).length), tone: cases.some((c) => c.reopened) ? "warning" : "neutral" },
      { label: "Internal hand-offs (inferred)", value: count(handoffs) },
      { label: "Complex", value: count(cases.filter((c) => c.complexity === "COMPLEX").length) },
    ],
    visuals: [],
    tables: [
      { id: "cases", sheet: "Detailed", title: `Cases (${count(shown.length)})`, description: "Newest first. Every inferred column carries its confidence and the message it rests on.", noun: { singular: "case", plural: "cases" }, columns: CASE_COLUMNS, rows: [...shown].sort((a, b) => b.openedAt - a.openedAt).map((c) => caseRow(ctx, intel, c)) },
      groupTable,
      sessionTable,
    ],
    notes: [{ tone: "info", text: VALIDATION_NOTE }],
    formulas: [
      { title: "Case", text: "Opened by a customer message when no case is open in the group (a bare 'ok', 'ji vai' or emoji never opens one). Closed after 4 hours of silence. A customer coming back within 24 hours of a resolution reopens it only when the message carries it on — quotes one of its messages, or says it is still not working; any other new question is a new case." },
      { title: "Resolution (inferred)", text: "High: the customer confirms it works, or an admin resolved the group's SLA escalation. Medium: the employee says it is fixed and the customer does not complain after; a completion keyword closed the session; or the customer thanked the team after the reply. A conversation that just stops is 'No further contact' and never counts as resolved." },
      { title: "Owner (inferred)", text: "Not simply the last replier: points for being first to respond (1), taking it on — 'I'll check with the developer' (2), coming back after that (2), telling the customer it is fixed (2), being the last employee before the resolution (1), and writing most replies (1). High confidence needs a return after a hand-off, or a stated fix that the customer's side confirms." },
      { title: "Internal hand-off vs SLA escalation", text: "A hand-off is the employee's own words about passing the problem on (developer, technical team, forwarded) — inferred, with confidence. An SLA escalation is the system's alert ladder for an unanswered priority group — a recorded fact. They are reported separately." },
      { title: "Complexity", text: "Points: 6+ turns (1) or 12+ (2); over an hour (1) or 4+ hours (2); a hand-off (2); several employees (1); an SLA escalation (2); reopened (1). Simple 0–1, Moderate 2–3, Complex 4+. The reasons are listed on every case." },
    ],
    selects: [
      {
        name: "status",
        label: "Show",
        value: filter,
        options: [
          { value: "all", label: "All cases" },
          { value: "attention", label: "Needing attention" },
          { value: "open", label: "Open now" },
          { value: "resolved", label: "Resolved" },
          { value: "missed", label: "Missed" },
          { value: "reopened", label: "Reopened" },
          { value: "handoff", label: "With an internal hand-off" },
        ],
      },
    ],
    usesGranularity: false,
    emptyMessage: cases.length === 0 ? `No customer case opened in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Employee effectiveness

const scoreText = (e: EmployeeEffectiveness) => (e.score === null ? "Insufficient sample" : String(e.score));
const dimScore = (e: EmployeeEffectiveness, d: (typeof DIMENSIONS)[number]) => e.dimensions.find((x) => x.dimension === d)!;

function weightsTable(): ReportTable {
  return {
    id: "weights",
    sheet: "Breakdown",
    title: "How the score is made",
    description: "Each dimension is 0–100. The score is their weighted average over the dimensions the employee had an opportunity in.",
    noun: { singular: "dimension", plural: "dimensions" },
    columns: [{ label: "Dimension" }, { label: "Weight", numeric: true }, { label: "Formula" }],
    rows: DIMENSIONS.map((d) => ({ key: d, cells: [DIMENSION_LABELS[d], DIMENSION_WEIGHTS[d], DIMENSION_FORMULAS[d]], sort: [DIMENSION_LABELS[d].toLowerCase(), DIMENSION_WEIGHTS[d], d] })),
  };
}

const EFFECTIVENESS_FORMULAS = [
  { title: "What this measures", text: "Support behaviour visible in WhatsApp records and the duty roster — not anyone's overall performance. Separate leaderboards, never one merged ranking." },
  { title: "Eligibility", text: `A score needs at least ${ELIGIBILITY.minWaitsHandled} human waits answered and ${ELIGIBILITY.minVerifiedActiveDays} verified active days (days before the verified-from date, or touched by an incomplete collection gap, do not count). Below that: Insufficient sample — never a low score.` },
  { title: "Shrinkage", text: "Every rate is pulled toward the team's rate by 10 pseudo-observations (5 pseudo-hours for efficiency), so 3 perfect cases land near the team average while 200 good ones earn their distance from it." },
  { title: "Observed Support Session Time", text: "The union of the employee's support sessions across every group — overlapping groups counted once. Different from the Team Report's Support Time, which joins all of a person's messages into stretches split at the idle gap: session time leaves out the gaps between groups. Both are shown; neither replaces the other." },
  { title: "Duty", text: "Observed session time inside a scheduled shift is during duty; outside it, before or after a shift that day, or on a day with no shift. Outside-duty time is shown, never scored." },
];

export async function buildEmployeeEffectiveness(ctx: ReportContext): Promise<BuiltReport> {
  const intel = await loadIntelligence(ctx);
  if (ctx.filters.memberId) return employeeDetail(ctx, intel, ctx.filters.memberId);
  const rows = intel.effectiveness;
  const eligible = rows.filter((r) => r.eligible);
  const totalObserved = rows.reduce((s, r) => s + r.metrics.observed.observedSeconds, 0);
  const totalAnswered = rows.reduce((s, r) => s + r.metrics.waitsHandled, 0);
  const totalOnTime = rows.reduce((s, r) => s + r.metrics.waitsOnTime, 0);
  const sorted = [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.metrics.sessions - a.metrics.sessions);

  const table: ReportTable = {
    id: "employees",
    sheet: "Detailed",
    title: `Employees (${count(rows.length)})`,
    description: "Select an employee for every case, session and message behind their figures.",
    noun: { singular: "employee", plural: "employees" },
    columns: [
      { label: "Employee" },
      { label: "Team" },
      { label: "Support Effectiveness" },
      { label: "Confidence" },
      ...DIMENSIONS.map((d) => ({ label: DIMENSION_LABELS[d] })),
      { label: "Scheduled" },
      { label: "Observed session time" },
      { label: "During duty" },
      { label: "Outside duty" },
      { label: "Peak / avg concurrent groups" },
      { label: "Groups", numeric: true },
      { label: "Sessions", numeric: true },
      { label: "Human waits answered", numeric: true },
      { label: "Median human response" },
      { label: "Cases owned", numeric: true },
      { label: "Resolved (High/Medium)", numeric: true },
      { label: "Reopened", numeric: true },
      { label: "Missed (charged)", numeric: true },
      { label: "Praise / thanks", numeric: false },
      { label: "Preferred by customers", numeric: true },
      { label: "Note" },
    ],
    rows: sorted.map((e) => {
      const m = e.metrics;
      const outside = m.duty.beforeShiftSeconds + m.duty.afterShiftSeconds + m.duty.offDaySeconds;
      return {
        key: e.memberId,
        href: employeeLink(ctx, e.memberId),
        cells: [
          name(intel, e.memberId),
          intel.memberTeams.get(e.memberId) ?? "—",
          scoreText(e),
          e.confidence === "INSUFFICIENT_SAMPLE" ? DATA_CONFIDENCE_LABELS.INSUFFICIENT_SAMPLE : conf(e.confidence),
          ...DIMENSIONS.map((d) => (dimScore(e, d).score === null ? "n/a" : String(dimScore(e, d).score))),
          duration(m.duty.scheduledSeconds),
          duration(m.observed.observedSeconds),
          duration(m.duty.inDutySeconds),
          duration(outside),
          `${m.observed.peakConcurrency} / ${m.observed.averageConcurrency ?? "—"}`,
          m.groups,
          m.sessions,
          m.waitsHandled,
          duration(m.medianResponseSeconds),
          m.casesOwned,
          m.resolvedOwned,
          m.reopenedOwned,
          m.missedCharged,
          `${m.appreciationPraise} / ${m.appreciationThanks}`,
          m.preferredByCustomers,
          e.eligibilityNote ?? volumeEfficiencyNote(e, rows) ?? "",
        ],
        sort: [
          name(intel, e.memberId).toLowerCase(),
          (intel.memberTeams.get(e.memberId) ?? "~").toLowerCase(),
          e.score ?? -1,
          e.confidence,
          ...DIMENSIONS.map((d) => dimScore(e, d).score ?? -1),
          m.duty.scheduledSeconds,
          m.observed.observedSeconds,
          m.duty.inDutySeconds,
          outside,
          m.observed.peakConcurrency,
          m.groups,
          m.sessions,
          m.waitsHandled,
          m.medianResponseSeconds ?? Number.MAX_SAFE_INTEGER,
          m.casesOwned,
          m.resolvedOwned,
          m.reopenedOwned,
          m.missedCharged,
          m.appreciationWeighted,
          m.preferredByCustomers,
          e.eligibilityNote ?? "",
        ],
      };
    }),
  };
  const boards: ReportTable = {
    id: "leaderboards",
    sheet: "Breakdown",
    title: "Leaderboards — eligible employees only",
    description: "Separate rankings, so volume is never mistaken for effectiveness. Each is the top three on one measure.",
    noun: { singular: "leaderboard", plural: "leaderboards" },
    columns: [{ label: "Leaderboard" }, { label: "#1" }, { label: "#2" }, { label: "#3" }, { label: "Ranked by" }],
    rows: LEADERBOARDS.map((b) => {
      const top = leaderboard(rows, b.id).slice(0, 3).map((e) => name(intel, e.memberId));
      return { key: b.id, cells: [b.label, top[0] ?? "—", top[1] ?? "—", top[2] ?? "—", b.metric], sort: [b.label.toLowerCase(), top[0] ?? "", top[1] ?? "", top[2] ?? "", b.metric] };
    }),
  };

  return {
    id: "employee-effectiveness",
    title: "Employee Effectiveness",
    question: "How effectively did each person handle support — and on how much evidence?",
    tiles: [
      { label: "Employees evaluated", value: count(rows.length), hint: "supported somebody in the period" },
      { label: "Eligible for a score", value: count(eligible.length), hint: `≥ ${ELIGIBILITY.minWaitsHandled} human waits and ≥ ${ELIGIBILITY.minVerifiedActiveDays} verified days` },
      { label: "Insufficient sample", value: count(rows.length - eligible.length) },
      { label: "Observed support session time", value: duration(totalObserved), hint: "each person's union of sessions, summed over people" },
      { label: "Support sessions", value: count(intel.sessions.length) },
      { label: "Cases", value: count(intel.cases.length) },
      { label: "Human SLA", value: percent(totalAnswered ? totalOnTime / totalAnswered : null), hint: "of waits answered by these employees" },
      { label: "Appreciation (attributed)", value: count(intel.appreciation.filter((a) => a.memberId && (a.confidence === "HIGH" || a.confidence === "MEDIUM")).length) },
    ],
    visuals: [],
    tables: [table, boards, weightsTable()],
    notes: [
      { tone: "info", text: "Support Effectiveness measures support behaviour visible in WhatsApp and the duty roster. It is not a measure of anyone's overall performance, and it should be read with its breakdown, sample and confidence." },
      ...(eligible.length === 0 && rows.length > 0
        ? [{ tone: "warning" as const, text: `Nobody has a score yet: no employee has ${ELIGIBILITY.minWaitsHandled} human waits answered on ${ELIGIBILITY.minVerifiedActiveDays} verified days in this period. Days are verified only after the project's verified-from date (Support Activity Setup) and outside collection gaps.` }]
        : []),
      { tone: "info", text: VALIDATION_NOTE },
    ],
    formulas: EFFECTIVENESS_FORMULAS,
    selects: [],
    usesGranularity: false,
    emptyMessage: rows.length === 0 ? `No employee supported a customer in ${ctx.data.range.label} for these filters.` : null,
  };
}

function employeeDetail(ctx: ReportContext, intel: IntelligenceData, memberId: string): BuiltReport {
  const e = intel.effectiveness.find((r) => r.memberId === memberId);
  const who = name(intel, memberId);
  if (!e) {
    return {
      id: "employee-effectiveness",
      title: `Employee Effectiveness — ${who}`,
      question: "How effectively did this person handle support — and on how much evidence?",
      tiles: [],
      visuals: [],
      tables: [],
      notes: [],
      formulas: EFFECTIVENESS_FORMULAS,
      selects: [],
      usesGranularity: false,
      emptyMessage: `${who} supported no customer in ${ctx.data.range.label} for these filters.`,
    };
  }
  const m = e.metrics;
  const existingSupportTime = ctx.data.result.members.find((r) => r.memberId === memberId)?.activeSeconds ?? 0;
  const myCases = intel.cases.filter((c) => c.memberIds.includes(memberId));
  const mySessions = intel.sessions.filter((s) => s.memberId === memberId);
  const myAppreciation = intel.appreciation.filter((a) => a.memberId === memberId);
  const myPreferences = intel.preferences.filter((p) => p.memberId === memberId);
  const tiles: ReportTile[] = [
    { label: "Support Effectiveness", value: scoreText(e), hint: e.eligibilityNote ?? `${conf(e.confidence)} confidence`, tone: e.score === null ? "neutral" : "accent" },
    { label: "Observed session time", value: duration(m.observed.observedSeconds), hint: `Team Report Support Time: ${duration(existingSupportTime)}` },
    { label: "Scheduled", value: duration(m.duty.scheduledSeconds) },
    { label: "During duty", value: duration(m.duty.inDutySeconds) },
    { label: "Outside duty", value: duration(m.duty.beforeShiftSeconds + m.duty.afterShiftSeconds + m.duty.offDaySeconds), hint: `before ${duration(m.duty.beforeShiftSeconds)} · after ${duration(m.duty.afterShiftSeconds)} · off-day ${duration(m.duty.offDaySeconds)}` },
    { label: "Groups / sessions", value: `${count(m.groups)} / ${count(m.sessions)}`, hint: `peak ${m.observed.peakConcurrency} groups at once, ${m.observed.averageConcurrency ?? "—"} on average` },
    { label: "Human waits answered", value: count(m.waitsHandled), hint: `${m.waitsOnTime} on time · median ${duration(m.medianResponseSeconds)}` },
    { label: "Cases owned / resolved", value: `${count(m.casesOwned)} / ${count(m.resolvedOwned)}`, hint: `${m.resolvedOwnedHigh} with High confidence · ${m.reopenedOwned} reopened` },
    { label: "Hand-offs", value: count(m.handoffsStated), hint: `${m.handoffsReturned} came back · ${m.handoffsResolved} resolved` },
    { label: "Appreciation", value: `${count(m.appreciationPraise)} praise · ${count(m.appreciationThanks)} thanks`, hint: "High/Medium attribution only" },
    { label: "Preferred by customers", value: count(m.preferredByCustomers), hint: `≥ ${PREFERENCE_MIN_INTERACTIONS} cases and ≥ ${PREFERENCE_MIN_SIGNALS} signals each` },
  ];
  return {
    id: "employee-effectiveness",
    title: `Employee Effectiveness — ${who}`,
    question: "How effectively did this person handle support — and on how much evidence?",
    tiles,
    visuals: [],
    tables: [
      {
        id: "dimensions",
        sheet: "Detailed",
        title: "Score breakdown",
        description: "Each dimension with its raw value, sample and weight. 'n/a' means no opportunity in this period — left out, not scored 0.",
        noun: { singular: "dimension", plural: "dimensions" },
        columns: [{ label: "Dimension" }, { label: "Score" }, { label: "Weight", numeric: true }, { label: "Raw" }, { label: "Sample", numeric: true }, { label: "Counted" }, { label: "Formula" }],
        rows: e.dimensions.map((d) => ({
          key: d.dimension,
          cells: [d.label, d.score === null ? "n/a" : String(d.score), d.weight, d.raw, d.sample, d.counted ? "Yes" : "No", DIMENSION_FORMULAS[d.dimension]],
          sort: [d.label.toLowerCase(), d.score ?? -1, d.weight, d.raw, d.sample, d.counted ? 1 : 0, d.dimension],
        })),
      },
      { id: "cases", sheet: "Breakdown", title: `Cases taken part in (${count(myCases.length)})`, description: "Newest first, with the evidence behind each inference.", noun: { singular: "case", plural: "cases" }, columns: CASE_COLUMNS, rows: [...myCases].sort((a, b) => b.openedAt - a.openedAt).map((c) => caseRow(ctx, intel, c)) },
      {
        id: "sessions",
        sheet: "Breakdown",
        title: `Sessions (${count(mySessions.length)})`,
        description: "First to last message in one group; overlapping groups are shown separately but counted once in observed time.",
        noun: { singular: "session", plural: "sessions" },
        columns: [{ label: "Group" }, { label: "Started", muted: true }, { label: "Ended", muted: true }, { label: "Duration" }, { label: "Messages", numeric: true }, { label: "Case state" }],
        rows: mySessions.map((s) => ({
          key: s.id,
          href: caseLink(ctx, s.groupKey),
          cells: [ctx.groupName(s.groupKey), when(s.start), when(s.end), duration(seconds(s.start, s.end)), s.messages, s.state === "NO_CASE" ? "No case" : CASE_STATE_LABELS[s.state]],
          sort: [ctx.groupName(s.groupKey).toLowerCase(), s.start, s.end, s.end - s.start, s.messages, s.state],
          sub: [s.groupKey, null, null, null, null, null],
        })),
      },
      {
        id: "appreciation",
        sheet: "Breakdown",
        title: `Customer appreciation (${count(myAppreciation.length)})`,
        description: "The customer's own words. Low-confidence attributions are listed but never counted.",
        noun: { singular: "message", plural: "messages" },
        columns: [{ label: "Group" }, { label: "When", muted: true }, { label: "Kind" }, { label: "Attribution" }, { label: "Confidence" }, { label: "Message" }],
        rows: myAppreciation.map((a) => ({
          key: a.messageKey,
          cells: [ctx.groupName(a.groupKey), when(a.at), a.kind === "EMPLOYEE_PRAISE" ? "Employee praise" : "General thanks", a.attribution, conf(a.confidence), a.text],
          sort: [ctx.groupName(a.groupKey).toLowerCase(), a.at, a.kind, a.attribution, a.confidence ?? "Z", a.text],
          sub: [a.groupKey, null, null, null, null, null],
        })),
      },
      {
        id: "preferences",
        sheet: "Breakdown",
        title: "Customer preference",
        description: `Preferred needs ≥ ${PREFERENCE_MIN_INTERACTIONS} cases together and ≥ ${PREFERENCE_MIN_SIGNALS} explicit signals; below that it is an insufficient sample, never a negative.`,
        noun: { singular: "customer", plural: "customers" },
        columns: [{ label: "Customer" }, { label: "Cases together", numeric: true }, { label: "Signals", numeric: true }, { label: "Status" }],
        rows: myPreferences.map((p) => ({
          key: p.customer,
          cells: [p.customerName ?? p.customer, p.interactions, p.signals, p.status === "PREFERRED" ? "Preferred" : "Insufficient sample"],
          sort: [(p.customerName ?? p.customer).toLowerCase(), p.interactions, p.signals, p.status],
        })),
      },
    ],
    notes: [
      ...(e.positives.length ? [{ tone: "info" as const, text: `Strengths: ${e.positives.join(" · ")}` }] : []),
      ...(e.negatives.length ? [{ tone: "warning" as const, text: `Weaker areas: ${e.negatives.join(" · ")}` }] : []),
      ...(e.missing.length ? [{ tone: "info" as const, text: `Missing data: ${e.missing.join(" · ")}` }] : []),
      { tone: "info", text: VALIDATION_NOTE },
    ],
    formulas: EFFECTIVENESS_FORMULAS,
    selects: [],
    usesGranularity: false,
    emptyMessage: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Customer signals

export async function buildCustomerSignals(ctx: ReportContext): Promise<BuiltReport> {
  const intel = await loadIntelligence(ctx);
  const a = intel.appreciation;
  const counted = a.filter((x) => x.memberId && (x.confidence === "HIGH" || x.confidence === "MEDIUM"));
  const preferred = intel.preferences.filter((p) => p.status === "PREFERRED");
  return {
    id: "customer-signals",
    title: "Customer Appreciation & Preference",
    question: "Where did customers thank or praise the team — and whom, on what evidence?",
    tiles: [
      { label: "Appreciation messages", value: count(a.length) },
      { label: "Employee praise", value: count(a.filter((x) => x.kind === "EMPLOYEE_PRAISE").length) },
      { label: "General thanks", value: count(a.filter((x) => x.kind === "GENERAL_THANKS").length) },
      { label: "Attributed (High/Medium)", value: count(counted.length), hint: "count toward an employee" },
      { label: "Not attributed", value: count(a.length - counted.length), hint: "to everyone, or too uncertain" },
      { label: "Customer preferences", value: count(preferred.length), hint: `≥ ${PREFERENCE_MIN_INTERACTIONS} cases and ≥ ${PREFERENCE_MIN_SIGNALS} signals` },
    ],
    visuals: [],
    tables: [
      {
        id: "appreciation",
        sheet: "Detailed",
        title: `Appreciation (${count(a.length)})`,
        description: "Newest first. Each row is the customer's own message.",
        noun: { singular: "message", plural: "messages" },
        columns: [{ label: "Group" }, { label: "When", muted: true }, { label: "Customer" }, { label: "Kind" }, { label: "Employee" }, { label: "Confidence" }, { label: "Attribution" }, { label: "Message" }],
        rows: [...a]
          .sort((x, y) => y.at - x.at)
          .map((x) => ({
            key: x.messageKey,
            href: caseLink(ctx, x.groupKey),
            cells: [ctx.groupName(x.groupKey), when(x.at), x.customerName ?? x.customer, x.kind === "EMPLOYEE_PRAISE" ? "Employee praise" : "General thanks", name(intel, x.memberId), conf(x.confidence), x.attribution, x.text],
            sort: [ctx.groupName(x.groupKey).toLowerCase(), x.at, (x.customerName ?? x.customer).toLowerCase(), x.kind, name(intel, x.memberId).toLowerCase(), x.confidence ?? "Z", x.attribution, x.text],
            sub: [x.groupKey, null, null, null, null, null, null, null],
          })),
      },
      {
        id: "preferences",
        sheet: "Breakdown",
        title: "Customer preference",
        description: "Every customer–employee pair with at least one explicit signal. Below the threshold: insufficient sample.",
        noun: { singular: "pair", plural: "pairs" },
        columns: [{ label: "Customer" }, { label: "Employee" }, { label: "Cases together", numeric: true }, { label: "Signals", numeric: true }, { label: "Status" }],
        rows: intel.preferences.map((p) => ({
          key: `${p.customer}|${p.memberId}`,
          href: employeeLink(ctx, p.memberId),
          cells: [p.customerName ?? p.customer, name(intel, p.memberId), p.interactions, p.signals, p.status === "PREFERRED" ? "Preferred" : "Insufficient sample"],
          sort: [(p.customerName ?? p.customer).toLowerCase(), name(intel, p.memberId).toLowerCase(), p.interactions, p.signals, p.status],
        })),
      },
    ],
    notes: [{ tone: "info", text: VALIDATION_NOTE }],
    formulas: [
      { title: "Kinds", text: "General thanks ('thanks', 'ধন্যবাদ') weighs 0.5 in any figure; employee praise ('আপনি অনেক ভালো support দেন', 'great support') weighs 1." },
      { title: "Attribution", text: "High: quotes the employee's message or @mentions them. Medium: names them, or they were the only employee who replied in that case. Low: several employees replied (attributed to the case owner, never counted). Addressed to everyone: nobody." },
      { title: "Preference", text: `An explicit request ('rahim vai ke din', 'আপনার কাছেই support নিতে চাই') or praise attributed to the employee is a signal. Preferred needs at least ${PREFERENCE_MIN_INTERACTIONS} cases together and ${PREFERENCE_MIN_SIGNALS} signals.` },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: a.length === 0 && intel.preferences.length === 0 ? `No customer thanked, praised or asked for anyone in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Executive Support Intelligence

interface PeriodFigures {
  customerMessages: number;
  cases: number;
  humanSla: number | null;
  medianHuman: number | null;
  missed: number;
  resolutionRate: number | null;
  observedSeconds: number;
  activeGroups: number;
  activeEmployees: number;
  appreciation: number;
  preferred: number;
  reopened: number;
}

function figures(ctx: ReportContext, intel: IntelligenceData): PeriodFigures {
  const hs = humanStats(intel.waits);
  const resolved = intel.cases.filter((c) => c.resolution && c.resolution.confidence !== "LOW").length;
  return {
    customerMessages: ctx.data.result.summary.customerMessages,
    cases: intel.cases.length,
    humanSla: hs.sla,
    medianHuman: hs.median,
    missed: hs.missed,
    resolutionRate: intel.cases.length ? resolved / intel.cases.length : null,
    observedSeconds: intel.effectiveness.reduce((s, r) => s + r.metrics.observed.observedSeconds, 0),
    activeGroups: new Set(intel.messages.filter((m) => m.ts >= ctx.rangeStart && m.ts < ctx.rangeEnd).map((m) => m.groupKey)).size,
    activeEmployees: new Set(intel.sessions.map((s) => s.memberId)).size,
    appreciation: intel.appreciation.filter((a) => a.memberId && (a.confidence === "HIGH" || a.confidence === "MEDIUM")).length,
    preferred: intel.preferences.filter((p) => p.status === "PREFERRED").length,
    reopened: intel.cases.filter((c) => c.reopened).length,
  };
}

/** "+18% (412 → 486)"; never a percentage from zero. */
function change(prev: number, cur: number, fmt: (n: number) => string = count): string {
  const r = changeRatio(prev, cur);
  if (r === null) return prev === cur ? "no change (0)" : `new (0 → ${fmt(cur)})`;
  const sign = r > 0 ? "+" : "";
  return `${sign}${(Math.round(r * 1000) / 10).toFixed(1)}% (${fmt(prev)} → ${fmt(cur)})`;
}
function changePoints(prev: number | null, cur: number | null): string {
  if (prev === null || cur === null) return `${percent(prev)} → ${percent(cur)}`;
  const d = Math.round((cur - prev) * 1000) / 10;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} pp (${percent(prev)} → ${percent(cur)})`;
}

async function previousPeriod(ctx: ReportContext): Promise<{ ctx: ReportContext; intel: IntelligenceData; label: string }> {
  const length = ctx.rangeEnd - ctx.rangeStart;
  const from = formatDhakaDateKey(new Date(ctx.rangeStart - length));
  const to = formatDhakaDateKey(new Date(ctx.rangeStart - 1));
  const prevCtx = await loadReportContext({ ...ctx.params, period: "custom", from, to }, ctx.now);
  return { ctx: prevCtx, intel: await loadIntelligence(prevCtx), label: prevCtx.data.range.label };
}

export async function buildSupportIntelligence(ctx: ReportContext): Promise<BuiltReport> {
  const [intel, prev] = await Promise.all([loadIntelligence(ctx), previousPeriod(ctx)]);
  const cur = figures(ctx, intel);
  const old = figures(prev.ctx, prev.intel);
  const running = ctx.now.getTime() < ctx.rangeEnd;

  // Attention: each item once, most urgent first.
  type Item = { kind: string; subject: string; detail: string; href: string | null; order: number };
  const items: Item[] = [];
  for (const c of intel.cases) {
    if (c.state === "ACTIVE" || c.state === "REOPENED" || c.state === "ESCALATED") {
      const age = seconds(c.lastAt, intel.measuredTo);
      items.push({ kind: c.state === "REOPENED" ? "Reopened case" : c.state === "ESCALATED" ? "SLA escalation open" : "Customer waiting", subject: ctx.groupName(c.groupKey), detail: `${CASE_STATE_LABELS[c.state]} · ${duration(age)} since the last message`, href: caseLink(ctx, c.groupKey), order: 1_000_000 + age });
    }
  }
  const byGroup = new Map<string, HumanWait[]>();
  for (const w of intel.waits) byGroup.set(w.groupKey, [...(byGroup.get(w.groupKey) ?? []), w]);
  for (const [groupKey, ws] of byGroup) {
    const x = humanStats(ws);
    if (x.waits >= 5 && x.sla !== null && x.sla < 0.5) items.push({ kind: "Low human SLA", subject: ctx.groupName(groupKey), detail: `${percent(x.sla)} of ${x.waits} waits answered by a person in time`, href: caseLink(ctx, groupKey), order: 500_000 + Math.round((1 - x.sla) * 1000) });
  }
  for (const e of intel.effectiveness) {
    const m = e.metrics;
    const outside = m.duty.beforeShiftSeconds + m.duty.afterShiftSeconds + m.duty.offDaySeconds;
    if ((m.observed.averageConcurrency ?? 0) >= 3 || (m.observed.observedSeconds > 0 && outside / m.observed.observedSeconds >= 0.3 && outside >= 3600)) {
      items.push({
        kind: "Possibly overloaded",
        subject: name(intel, e.memberId),
        detail: `${m.observed.averageConcurrency ?? "—"} groups at once on average (peak ${m.observed.peakConcurrency}); ${duration(outside)} of observed support outside duty`,
        href: employeeLink(ctx, e.memberId),
        order: 200_000 + Math.round((m.observed.averageConcurrency ?? 0) * 100),
      });
    } else if (m.duty.scheduledSeconds >= 4 * 3600 && m.duty.inDutySeconds < 0.15 * m.duty.scheduledSeconds) {
      items.push({
        kind: "Little recorded support during duty",
        subject: name(intel, e.memberId),
        detail: `${duration(m.duty.inDutySeconds)} observed of ${duration(m.duty.scheduledSeconds)} scheduled — not a performance verdict: waiting, calls and work outside WhatsApp leave no record`,
        href: employeeLink(ctx, e.memberId),
        order: 100_000,
      });
    }
  }
  for (const g of ctx.dataHealth.gaps.filter((x) => x.incomplete)) items.push({ kind: "Data gap", subject: g.accountLabel, detail: g.text, href: null, order: 2_000_000 });
  items.sort((a, b) => b.order - a.order);

  const tiles: ReportTile[] = [
    { label: "Customer messages", value: count(cur.customerMessages), hint: change(old.customerMessages, cur.customerMessages) },
    { label: "Cases", value: count(cur.cases), hint: change(old.cases, cur.cases) },
    { label: "Human SLA", value: percent(cur.humanSla), hint: changePoints(old.humanSla, cur.humanSla) },
    { label: "Median human response", value: duration(cur.medianHuman), hint: `previously ${duration(old.medianHuman)}` },
    { label: "Never answered by a person", value: count(cur.missed), hint: change(old.missed, cur.missed), tone: cur.missed ? "danger" : "neutral" },
    { label: "Resolution rate (inferred)", value: percent(cur.resolutionRate), hint: changePoints(old.resolutionRate, cur.resolutionRate) },
    { label: "Reopened cases", value: count(cur.reopened), hint: change(old.reopened, cur.reopened) },
    { label: "Observed support session time", value: duration(cur.observedSeconds), hint: change(old.observedSeconds, cur.observedSeconds, (n) => duration(n)) },
    { label: "Active groups", value: count(cur.activeGroups), hint: change(old.activeGroups, cur.activeGroups) },
    { label: "Active employees", value: count(cur.activeEmployees), hint: change(old.activeEmployees, cur.activeEmployees) },
    { label: "Customer appreciation", value: count(cur.appreciation), hint: change(old.appreciation, cur.appreciation) },
    { label: "Customer preferences", value: count(cur.preferred), hint: change(old.preferred, cur.preferred) },
    { label: "Needs attention", value: count(items.length), tone: items.length ? "warning" : "neutral" },
  ];
  const comparison: ReportTable = {
    id: "comparison",
    sheet: "Breakdown",
    title: `Compared with ${prev.label}`,
    description: "The previous period of equal length. A change from zero has no percentage.",
    noun: { singular: "measure", plural: "measures" },
    columns: [{ label: "Measure" }, { label: "Previous" }, { label: "Current" }, { label: "Change" }],
    rows: [
      ["Customer messages", count(old.customerMessages), count(cur.customerMessages), change(old.customerMessages, cur.customerMessages)],
      ["Cases", count(old.cases), count(cur.cases), change(old.cases, cur.cases)],
      ["Human SLA", percent(old.humanSla), percent(cur.humanSla), changePoints(old.humanSla, cur.humanSla)],
      ["Median human response", duration(old.medianHuman), duration(cur.medianHuman), old.medianHuman !== null && cur.medianHuman !== null ? change(old.medianHuman, cur.medianHuman, (n) => duration(n)) : "—"],
      ["Never answered by a person", count(old.missed), count(cur.missed), change(old.missed, cur.missed)],
      ["Resolution rate (inferred)", percent(old.resolutionRate), percent(cur.resolutionRate), changePoints(old.resolutionRate, cur.resolutionRate)],
      ["Reopened cases", count(old.reopened), count(cur.reopened), change(old.reopened, cur.reopened)],
      ["Observed support session time", duration(old.observedSeconds), duration(cur.observedSeconds), change(old.observedSeconds, cur.observedSeconds, (n) => duration(n))],
      ["Active groups", count(old.activeGroups), count(cur.activeGroups), change(old.activeGroups, cur.activeGroups)],
      ["Active employees", count(old.activeEmployees), count(cur.activeEmployees), change(old.activeEmployees, cur.activeEmployees)],
      ["Customer appreciation", count(old.appreciation), count(cur.appreciation), change(old.appreciation, cur.appreciation)],
      ["Customer preferences", count(old.preferred), count(cur.preferred), change(old.preferred, cur.preferred)],
    ].map((cells) => ({ key: cells[0]!, cells, sort: cells })),
  };
  const attention: ReportTable = {
    id: "attention",
    sheet: "Detailed",
    title: `Needs attention (${count(items.length)})`,
    description: "Data gaps first, then customers waiting and reopened or escalated cases, then groups with a low human SLA, then workload signals.",
    noun: { singular: "item", plural: "items" },
    columns: [{ label: "Subject" }, { label: "Issue" }, { label: "Detail" }],
    rows: items.map((i, index) => ({ key: `${index}|${i.kind}|${i.subject}`, href: i.href, cells: [i.subject, i.kind, i.detail], sort: [i.subject.toLowerCase(), i.kind, i.order] })),
  };
  return {
    id: "support-intelligence",
    title: "Executive Support Intelligence",
    question: "What is happening in support, where are the problems, and what changed?",
    tiles,
    visuals: [],
    tables: [attention, comparison],
    notes: [
      ...(running ? [{ tone: "info" as const, text: `This period is still running; the previous period (${prev.label}) is complete, so totals are not yet like for like.` }] : []),
      { tone: "info", text: "A layer above the operational reports, which are unchanged. Workload signals describe what WhatsApp recorded and are not performance verdicts." },
      { tone: "info", text: VALIDATION_NOTE },
    ],
    formulas: [
      { title: "Comparison", text: "The previous period is the same number of days immediately before this one. Counts show a percentage change; rates show percentage points. A change from zero is shown as 'new', never as a percentage." },
      { title: "Possibly overloaded", text: "Three or more groups at once on average across observed support time, or at least an hour and 30% of observed support outside scheduled duty." },
      { title: "Little recorded support during duty", text: "At least 4 scheduled hours with under 15% of them covered by observed support sessions. Absence of a WhatsApp record is not absence of work." },
    ],
    selects: [],
    usesGranularity: false,
    // Nothing recorded at all and nothing wrong with collection: say so rather than show zeros.
    emptyMessage:
      cur.customerMessages === 0 && intel.messages.every((m) => m.ts < ctx.rangeStart || m.ts >= ctx.rangeEnd) && items.length === 0
        ? `No customer message or support activity was recorded in ${ctx.data.range.label} for these filters.`
        : null,
  };
}
