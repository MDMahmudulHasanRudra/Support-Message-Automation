import { formatDhakaDateKey } from "./dhakaDay.js";

/**
 * Every report the product offers, in one catalogue — what the All Reports page shows on each card,
 * which category it sits in, the question it answers and what it exports. The three reports that
 * predate this list keep their own routes; every newer one lives at `/reports/<id>` and is rendered
 * by one generic page (see REPORTS.md).
 *
 * The catalogue describes; it never grants. Each report's page and export check their own
 * permission, and the project feature that owns the route decides whether it exists at all.
 */

export const REPORT_CATEGORIES = [
  "Support Performance",
  "Team & Employee",
  "Group / Client Health",
  "Response & SLA",
  "Activity & Workload",
  "Management",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export type ReportExportFormat = "CSV" | "Excel";

export interface ReportCatalogueEntry {
  /** Stable id; for a generic report also its route segment. */
  id: string;
  href: string;
  label: string;
  category: ReportCategory;
  description: string;
  /** The one question the report answers, in a reader's words. */
  question: string;
  exports: readonly ReportExportFormat[];
  /** True for reports rendered by the generic `/reports/[report]` page. */
  generic: boolean;
}

const BOTH: readonly ReportExportFormat[] = ["CSV", "Excel"];

export const REPORT_CATALOGUE: readonly ReportCatalogueEntry[] = [
  {
    id: "team-report",
    href: "/team-report",
    label: "Team Report",
    category: "Support Performance",
    description: "Groups, replies, missed and recalled customer waits, and support time per team member, from the stored WhatsApp messages.",
    question: "What did the team do, and what was missed?",
    exports: BOTH,
    generic: false,
  },
  {
    id: "support-activity",
    href: "/support-activity/reports",
    label: "Support Activity",
    category: "Support Performance",
    description: "Support activity and session history by WhatsApp group, for any date range.",
    question: "Which support activity was recorded, per group and session?",
    exports: BOTH,
    generic: false,
  },
  {
    id: "employee-groups",
    href: "/reports/employee-groups",
    label: "Employee Support Breakdown",
    category: "Team & Employee",
    description: "Every team member against every group they supported: replies, waits answered, response time and support time.",
    question: "Which groups did each person support, and how?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "duty-history",
    href: "/team-management/attendance",
    label: "Duty History",
    category: "Team & Employee",
    description: "Each person's scheduled shift against the first and last message actually recorded, by day.",
    question: "Did each person's day match their shift?",
    exports: ["CSV"],
    generic: false,
  },
  {
    id: "duty-workload",
    href: "/reports/duty-workload",
    label: "Duty & Workload",
    category: "Team & Employee",
    description: "Scheduled shift time against recorded support time: in shift, beyond the shift, on off days, and overnight shifts.",
    question: "How does recorded support time compare with the scheduled shift?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "inactive-groups",
    href: "/reports/inactive-groups",
    label: "Inactive Groups",
    category: "Group / Client Health",
    description: "Monitored groups with no communication at all in the period — with their last activity before it — plus no customer activity, no reply, or low activity.",
    question: "Which groups had no communication at all during this period?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "group-coverage",
    href: "/reports/group-coverage",
    label: "Group Support Coverage",
    category: "Group / Client Health",
    description: "Per group: customer waits, how many were answered, how many in time, and how many never.",
    question: "In each group, how many customer waits got an answer?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "group-trend",
    href: "/reports/group-trend",
    label: "Group Activity Trend",
    category: "Group / Client Health",
    description: "Customer messages, replies, active groups and unanswered groups per day, week or month.",
    question: "Are groups getting busier or quieter?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "response-sla",
    href: "/reports/response-sla",
    label: "Response SLA",
    category: "Response & SLA",
    description: "First-response times and the share of customer waits answered within their target, per group and per person.",
    question: "How fast are customers answered, and how often within the target?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "missed",
    href: "/reports/missed",
    label: "Missed Support",
    category: "Response & SLA",
    description: "Every customer wait that is still waiting, was answered late or was never answered, with the customer's first line.",
    question: "Which customer waits went unanswered or were answered late?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "workload",
    href: "/reports/workload",
    label: "Team Workload",
    category: "Activity & Workload",
    description: "Replies, groups, waits answered, support time and active days per team member.",
    question: "How much support work did each person record?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "heatmap",
    href: "/reports/heatmap",
    label: "Support Activity Heatmap",
    category: "Activity & Workload",
    description: "Customer messages, team replies or new waits by weekday and hour of the day.",
    question: "When in the week do customers write and the team reply?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "calls",
    href: "/reports/calls",
    label: "WhatsApp Call Activity",
    category: "Activity & Workload",
    description: "Messages asking for or mentioning a call. Inferred from message text: WhatsApp call events are not recorded.",
    question: "Where did people ask for, or mention, a call?",
    exports: BOTH,
    generic: true,
  },
  {
    id: "distribution",
    href: "/reports/distribution",
    label: "Workload Distribution",
    category: "Management",
    description: "Each person's share of the team's replies, support time, groups or answered waits, with the total it is a share of.",
    question: "How is the work shared across the team?",
    exports: BOTH,
    generic: true,
  },
];

export const GENERIC_REPORT_IDS = REPORT_CATALOGUE.filter((r) => r.generic).map((r) => r.id);

export function reportCatalogueEntry(id: string): ReportCatalogueEntry | null {
  return REPORT_CATALOGUE.find((r) => r.id === id) ?? null;
}

export function reportCatalogueEntryForHref(href: string): ReportCatalogueEntry | null {
  return REPORT_CATALOGUE.find((r) => r.href === href) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Date presets — quick choices that map onto the reports' existing period/date/from/to filters, so
// a preset is an ordinary report URL and every existing link keeps meaning what it meant.
// ---------------------------------------------------------------------------------------------

export const DATE_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_year", label: "This year" },
] as const;

/**
 * Rolling "last N days" periods, ending today and counting today. Offered only by reports that ask
 * for them (Inactive Groups), so no other report's preset row changes. Ninety days stays inside the
 * 92-day custom-range limit.
 */
export const ROLLING_DATE_PRESETS = [
  { id: "last_7_days", label: "Last 7 days", days: 7 },
  { id: "last_30_days", label: "Last 30 days", days: 30 },
  { id: "last_60_days", label: "Last 60 days", days: 60 },
  { id: "last_90_days", label: "Last 90 days", days: 90 },
] as const;

export type DatePresetId = (typeof DATE_PRESETS)[number]["id"] | (typeof ROLLING_DATE_PRESETS)[number]["id"];

/** Every preset's label, by id. */
export const DATE_PRESET_LABELS: Record<DatePresetId, string> = Object.fromEntries(
  [...DATE_PRESETS, ...ROLLING_DATE_PRESETS].map((p) => [p.id, p.label]),
) as Record<DatePresetId, string>;

export interface PresetParams {
  period: "day" | "week" | "month" | "custom";
  date?: string;
  from?: string;
  to?: string;
}

const DAY_MS = 86_400_000;

/** The period/date/from/to a preset stands for, as of `now` (Asia/Dhaka days). */
export function datePresetParams(preset: DatePresetId, now: Date): PresetParams {
  const today = formatDhakaDateKey(now);
  const daysAgo = (n: number) => formatDhakaDateKey(new Date(now.getTime() - n * DAY_MS));
  switch (preset) {
    case "today":
      return { period: "day", date: today };
    case "yesterday":
      return { period: "day", date: daysAgo(1) };
    case "this_week":
      return { period: "week", date: today };
    case "last_week":
      return { period: "week", date: daysAgo(7) };
    case "this_month":
      return { period: "month", date: today };
    case "last_month": {
      // The day before the 1st of this month is always in last month.
      const firstOfMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1));
      return { period: "month", date: new Date(firstOfMonth.getTime() - DAY_MS).toISOString().slice(0, 10) };
    }
    case "this_year":
      return { period: "custom", from: `${today.slice(0, 4)}-01-01`, to: today };
    case "last_7_days":
    case "last_30_days":
    case "last_60_days":
    case "last_90_days": {
      const days = ROLLING_DATE_PRESETS.find((p) => p.id === preset)!.days;
      return { period: "custom", from: daysAgo(days - 1), to: today };
    }
  }
}
