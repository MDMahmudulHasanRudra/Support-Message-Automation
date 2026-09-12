/**
 * What a person's day amounts to, once the plan, the evidence and any approved leave are read
 * together — plus the label each state is shown under.
 *
 * **This file must never import `@support-automation/db` or `@prisma/client`, and that is the
 * reason it exists separately from `server/teamManagementReports.ts`.** `DutyStateBadge` renders
 * inside `RosterDay`, which is a Client Component, so anything the badge imports as a *value*
 * crosses into the client bundle. These labels previously lived beside the derivation logic, which
 * meant importing them dragged Prisma across that boundary. The types other client components take
 * from the reports module are all `import type` and erase at compile time; a plain value does not,
 * and TypeScript will not warn you about the difference.
 *
 * Same shape as `lib/aiResponseModes.ts`: one shared definition read by both sides, so the label a
 * page prints and the state the server derived cannot drift apart.
 */

export type DerivedDutyState =
  | "WORKING"
  | "NO_ACTIVITY"
  | "OFF"
  | "OFF_DAY_DUTY"
  | "ON_LEAVE"
  | "LEAVE_CONFLICT"
  | "HOLIDAY"
  | "UNASSIGNED"
  | "ABSENT"
  | "EXCUSED";

/**
 * `NO_ACTIVITY` is deliberately worded as an observation rather than a verdict, and must stay that
 * way. "Absent" is a claim about where a person was; this system only knows whether a message was
 * stored. `ABSENT` appears here solely because a manager can state it explicitly.
 */
export const DUTY_STATE_LABEL: Record<DerivedDutyState, string> = {
  WORKING: "Working",
  NO_ACTIVITY: "No activity recorded",
  OFF: "Off",
  OFF_DAY_DUTY: "Off-day duty",
  ON_LEAVE: "On leave",
  LEAVE_CONFLICT: "Active while on leave",
  HOLIDAY: "Holiday",
  UNASSIGNED: "Not scheduled",
  ABSENT: "Marked absent",
  EXCUSED: "Excused",
};
