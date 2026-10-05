/**
 * WhatsApp Operations: one reading of every long-running WhatsApp job, whatever kind it is, for the
 * job indicator shown on every page and the module pages themselves.
 *
 * The jobs themselves stay where they are — Add Number to Groups (`GroupParticipantAddJob`) and the
 * Groups Admin Maker (`GroupAdminPromotionJob`) each have their own job and per-group result tables,
 * which the worker owns and processes. The browser never does the work; it only reads these rows,
 * so leaving the page, refreshing or closing the browser changes nothing about the job. This module
 * is the shared vocabulary on top: one state set, one progress figure, one polling rule, so a new
 * kind of WhatsApp job is one more `summarise…` function, not a second indicator.
 *
 * Pure: no database, no clock except the one passed in.
 */

export const WHATSAPP_OPERATION_KINDS = ["ADD_NUMBER_TO_GROUPS", "ADMIN_MAKER"] as const;
export type WhatsAppOperationKind = (typeof WHATSAPP_OPERATION_KINDS)[number];

export const WHATSAPP_OPERATION_TITLES: Record<WhatsAppOperationKind, string> = {
  ADD_NUMBER_TO_GROUPS: "Add Number to Groups",
  ADMIN_MAKER: "Groups Admin Maker",
};

/**
 * - CHECKING / RUNNING: the worker is working on it.
 * - WAITING_ACCOUNT: the account is not connected; the job carries on by itself once it is.
 * - REVIEW: waiting for a person to choose (Add Number to Groups' membership review).
 * - PAUSED: waiting for a person to press Resume (Admin Maker after a disconnect or the kill switch).
 * - COMPLETED / PARTIAL (completed with failures) / FAILED / CANCELLED / STOPPED: finished.
 */
export type WhatsAppOperationState =
  | "CHECKING"
  | "RUNNING"
  | "WAITING_ACCOUNT"
  | "REVIEW"
  | "PAUSED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "STOPPED";

const FINISHED_STATES: ReadonlySet<WhatsAppOperationState> = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED"]);
/** States in which the worker is moving the job along on its own, so its figures change by the second. */
const WORKING_STATES: ReadonlySet<WhatsAppOperationState> = new Set(["CHECKING", "RUNNING", "WAITING_ACCOUNT"]);

export const isFinishedOperationState = (state: WhatsAppOperationState) => FINISHED_STATES.has(state);
export const isWorkingOperationState = (state: WhatsAppOperationState) => WORKING_STATES.has(state);

/**
 * Clearing an operation from one person's tracker (WhatsAppOperationDismissal) — display only, never
 * a cancel. The wording says so: a job the worker is still moving, or one paused waiting for Resume,
 * is only HIDDEN ("Hide"; Cancel stays on its own page); one finished or ready for review is CLEARED.
 */
export function operationClearLabel(state: WhatsAppOperationState): "Clear" | "Hide" {
  return isFinishedOperationState(state) || state === "REVIEW" ? "Clear" : "Hide";
}

/**
 * Whether a person's dismissal still applies. It holds while the operation is in the state it was
 * cleared in; once the job moves on — a review continued, a running job finished or paused — that is
 * news, and the operation shows again until it is cleared again.
 */
export function isOperationCleared(op: Pick<WhatsAppOperation, "state">, dismissal: { stateAtDismissal: string } | undefined): boolean {
  return dismissal !== undefined && dismissal.stateAtDismissal === op.state;
}

export type WhatsAppOperationTone = "success" | "warning" | "danger" | "neutral";

export interface WhatsAppOperationCount {
  label: string;
  value: number;
  tone: WhatsAppOperationTone;
}

export interface WhatsAppOperation {
  id: string;
  kind: WhatsAppOperationKind;
  title: string;
  /** Project-relative link to the job's own page. */
  href: string;
  /** Who the job is for: "+8801…", or "+8801… and 2 more". */
  target: string;
  accountLabel: string;
  state: WhatsAppOperationState;
  stateLabel: string;
  /** What is happening or what to do, in a sentence; null when the label says it all. */
  detail: string | null;
  /** Work done of `total`, for the progress bar. */
  processed: number;
  total: number;
  /** What `processed / total` counts: "Groups checked", "Adds done". */
  progressLabel: string;
  counts: WhatsAppOperationCount[];
  /** The pair being worked on now, or the next one due. */
  current: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const formatOperationTarget = (numbers: readonly string[]): string => {
  if (numbers.length === 0) return "—";
  const first = `+${numbers[0]}`;
  return numbers.length === 1 ? first : `${first} and ${numbers.length - 1} more`;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------------------------
// Add Number to Groups

export interface AddJobInput {
  id: string;
  status: string;
  phoneNumbers: readonly string[];
  queuedCount: number;
  accountLabel: string;
  accountConnected: boolean;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  /** Item count per GroupParticipantAddItemStatus. */
  byStatus: Readonly<Record<string, number>>;
  /** The pair in flight, or the next one due. */
  current: { phoneNumber: string; groupName: string; processing: boolean; scheduledAt: Date } | null;
}

const CHECK_OUTSTANDING = ["PENDING_CHECK", "CHECKING"];
const ADD_SETTLED = ["ADDED", "FAILED", "CANCELLED", "SKIPPED_ALREADY_MEMBER"];
const ADD_PHASE = [...ADD_SETTLED, "PENDING", "PROCESSING"];
const CANNOT_ADD = ["INVALID_NUMBER", "NOT_ON_WHATSAPP", "NO_PERMISSION", "GROUP_UNAVAILABLE", "CHECK_FAILED"];

export function summariseAddJob(job: AddJobInput, now: Date): WhatsAppOperation {
  const n = (...statuses: string[]) => statuses.reduce((sum, s) => sum + (job.byStatus[s] ?? 0), 0);
  const allItems = Object.values(job.byStatus).reduce((a, b) => a + b, 0);
  const alreadyMember = n("ALREADY_MEMBER", "SKIPPED_ALREADY_MEMBER");
  const base = {
    id: job.id,
    kind: "ADD_NUMBER_TO_GROUPS" as const,
    title: WHATSAPP_OPERATION_TITLES.ADD_NUMBER_TO_GROUPS,
    href: `/group-member-adder/jobs/${job.id}`,
    target: formatOperationTarget(job.phoneNumbers),
    accountLabel: job.accountLabel,
    createdAt: job.createdAt.toISOString(),
    finishedAt: iso(job.completedAt ?? job.cancelledAt),
  };

  if (job.status === "CHECKING") {
    return {
      ...base,
      state: job.accountConnected ? "CHECKING" : "WAITING_ACCOUNT",
      stateLabel: job.accountConnected ? "Checking membership" : "Waiting for the account",
      detail: job.accountConnected
        ? "Reading each group's members. Nothing is added until you review the result."
        : `"${job.accountLabel}" is not connected. The check carries on by itself once it is — nothing is lost.`,
      processed: allItems - n(...CHECK_OUTSTANDING),
      total: allItems,
      progressLabel: "Pairs checked",
      counts: [
        { label: "Can be added", value: n("READY", "CANNOT_VERIFY"), tone: "neutral" },
        { label: "Already member", value: alreadyMember, tone: "neutral" },
      ],
      current: null,
    };
  }

  if (job.status === "AWAITING_REVIEW") {
    return {
      ...base,
      state: "REVIEW",
      stateLabel: "Ready for review",
      detail: "The membership check finished. Choose what to add — nothing is added until you confirm.",
      processed: allItems,
      total: allItems,
      progressLabel: "Pairs checked",
      counts: [
        { label: "Can be added", value: n("READY", "CANNOT_VERIFY"), tone: "neutral" },
        { label: "Already member", value: alreadyMember, tone: "neutral" },
        { label: "Cannot add", value: n(...CANNOT_ADD), tone: n(...CANNOT_ADD) > 0 ? "warning" : "neutral" },
      ],
      current: null,
    };
  }

  const processed = n(...ADD_SETTLED);
  const total = Math.max(job.queuedCount, n(...ADD_PHASE));
  const failed = n("FAILED");
  const counts: WhatsAppOperationCount[] = [
    { label: "Added", value: n("ADDED"), tone: n("ADDED") > 0 ? "success" : "neutral" },
    { label: "Already member", value: alreadyMember, tone: "neutral" },
    { label: "Failed", value: failed, tone: failed > 0 ? "danger" : "neutral" },
  ];
  const common = { processed, total, progressLabel: "Adds done", counts };

  if (job.status === "QUEUED" || job.status === "RUNNING") {
    if (!job.accountConnected) {
      return {
        ...base,
        ...common,
        state: "WAITING_ACCOUNT",
        stateLabel: "Waiting for the account",
        detail: `"${job.accountLabel}" is not connected. Nothing is lost: the job carries on from ${processed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} once it is reconnected.`,
        current: null,
      };
    }
    let current: string | null = null;
    if (job.current) {
      const pair = `+${job.current.phoneNumber} → ${job.current.groupName}`;
      if (job.current.processing) current = `Adding ${pair}`;
      else {
        const seconds = Math.round((job.current.scheduledAt.getTime() - now.getTime()) / 1000);
        current = seconds > 1 ? `Next in ${formatWait(seconds)}: ${pair}` : `Next: ${pair}`;
      }
    }
    return { ...base, ...common, state: "RUNNING", stateLabel: job.status === "QUEUED" ? "Queued" : "Processing", detail: null, current };
  }

  if (job.status === "COMPLETED") {
    return {
      ...base,
      ...common,
      state: failed > 0 ? "PARTIAL" : "COMPLETED",
      stateLabel: failed > 0 ? "Completed with failures" : "Completed",
      detail: null,
      current: null,
    };
  }
  if (job.status === "STOPPED_KILL_SWITCH") {
    return {
      ...base,
      ...common,
      state: "STOPPED",
      stateLabel: "Stopped — automation turned off",
      detail: "Automation was turned off, so the groups still waiting were cancelled. Adds already made stay made.",
      current: null,
    };
  }
  return { ...base, ...common, state: "CANCELLED", stateLabel: "Cancelled", detail: "Stopped by a person. Adds already made stay made.", current: null };
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------------------------
// Groups Admin Maker

export interface AdminJobInput {
  id: string;
  status: string;
  statusReason: string | null;
  phoneNumber: string;
  accountLabel: string;
  totalGroups: number;
  adminGroups: number | null;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  counts: { checked: number; promoted: number; alreadyAdmin: number; notMember: number; failed: number };
}

export function summariseAdminJob(job: AdminJobInput): WhatsAppOperation {
  const { counts } = job;
  const list: WhatsAppOperationCount[] = [
    ...(job.adminGroups === null ? [] : [{ label: "Eligible", value: job.adminGroups, tone: "neutral" as const }]),
    { label: "Promoted", value: counts.promoted, tone: counts.promoted > 0 ? "success" : "neutral" },
    { label: "Already admin", value: counts.alreadyAdmin, tone: "neutral" },
    { label: "Not a member", value: counts.notMember, tone: "neutral" },
    { label: "Failed", value: counts.failed, tone: counts.failed > 0 ? "danger" : "neutral" },
  ];
  const base = {
    id: job.id,
    kind: "ADMIN_MAKER" as const,
    title: WHATSAPP_OPERATION_TITLES.ADMIN_MAKER,
    href: `/group-admin-maker/jobs/${job.id}`,
    target: formatOperationTarget([job.phoneNumber]),
    accountLabel: job.accountLabel,
    processed: counts.checked,
    total: job.totalGroups,
    progressLabel: "Groups checked",
    counts: list,
    current: null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: iso(job.completedAt ?? job.cancelledAt),
  };
  switch (job.status) {
    case "CHECKING":
      return { ...base, state: "CHECKING", stateLabel: "Checking groups", detail: "Asking WhatsApp which groups this account administers. Nothing is changed yet." };
    case "RUNNING":
      return { ...base, state: "RUNNING", stateLabel: "Processing", detail: null };
    case "PAUSED_DISCONNECTED":
      return { ...base, state: "PAUSED", stateLabel: "Paused — connection lost", detail: job.statusReason };
    case "STOPPED_KILL_SWITCH":
      return { ...base, state: "PAUSED", stateLabel: "Paused — automation off", detail: job.statusReason };
    case "COMPLETED":
      return { ...base, state: counts.failed > 0 ? "PARTIAL" : "COMPLETED", stateLabel: counts.failed > 0 ? "Completed with failures" : "Completed", detail: null };
    case "FAILED":
      return { ...base, state: "FAILED", stateLabel: "Failed", detail: job.statusReason };
    default:
      return { ...base, state: "CANCELLED", stateLabel: "Cancelled", detail: job.statusReason };
  }
}

// ---------------------------------------------------------------------------------------------

/** Active first, oldest first (the order they were started); then finished, newest first. */
export function sortOperations(ops: readonly WhatsAppOperation[]): WhatsAppOperation[] {
  return [...ops].sort((a, b) => {
    const fa = isFinishedOperationState(a.state);
    const fb = isFinishedOperationState(b.state);
    if (fa !== fb) return fa ? 1 : -1;
    if (!fa) return a.createdAt.localeCompare(b.createdAt);
    return (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt);
  });
}

/** Polling: every 3s while the worker is moving something; 15s while one waits on a person; 30s otherwise. */
export const OPERATION_POLL_WORKING_MS = 3_000;
export const OPERATION_POLL_WAITING_MS = 15_000;
export const OPERATION_POLL_IDLE_MS = 30_000;

export function operationPollMs(ops: readonly WhatsAppOperation[]): number {
  if (ops.some((o) => isWorkingOperationState(o.state))) return OPERATION_POLL_WORKING_MS;
  if (ops.some((o) => !isFinishedOperationState(o.state))) return OPERATION_POLL_WAITING_MS;
  return OPERATION_POLL_IDLE_MS;
}
