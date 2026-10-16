/**
 * What a finished group sync's result rests on (PHASE2.md Stage 2, GROUP_SYNC.md).
 *
 * WhatsApp gives a linked device no signal that it has finished receiving the phone's chat list, so no
 * sync here can be "verified complete". What a sync CAN say is what evidence it had, and the account
 * card states that instead of implying certainty:
 *
 *   STABLE_READS          the list stopped growing across several consecutive reads (the arrival
 *                         passes after a connect settled), then one full read recorded it;
 *   KNOWN_GROUPS_PRESENT  a recovery read contained every group this account had recorded as active
 *                         (and saved every group it listed);
 *   SINGLE_READ           one read of the list — a manual resync, or the 15-minute follow-up;
 *   WINDOW_ENDED          the 20-minute arrival window ended before the list settled; groups that
 *                         arrive later are still added by the recovery loop's follow-up reads.
 *
 * Recorded only beside COMPLETED / PARTIAL; null for everything else and for syncs recorded before
 * the column existed. It never changes what a status means or what any loop does.
 */

export const GROUP_SYNC_BASES = ["STABLE_READS", "KNOWN_GROUPS_PRESENT", "SINGLE_READ", "WINDOW_ENDED"] as const;
export type GroupSyncBasis = (typeof GROUP_SYNC_BASES)[number];

export function isGroupSyncBasis(value: unknown): value is GroupSyncBasis {
  return typeof value === "string" && (GROUP_SYNC_BASES as readonly string[]).includes(value);
}

/** One short clause for the account card: "list stable across consecutive reads". */
export const GROUP_SYNC_BASIS_LABELS: Record<GroupSyncBasis, string> = {
  STABLE_READS: "list stable across consecutive reads",
  KNOWN_GROUPS_PRESENT: "every group recorded as active was listed",
  SINGLE_READ: "one read of the list",
  WINDOW_ENDED: "list had not settled when the arrival window ended — later groups are still added",
};

/** Said once wherever a sync result is shown, so nobody reads a group count as a guarantee. */
export const GROUP_SYNC_COMPLETENESS_NOTE = "WhatsApp gives no signal that a group list is complete; the line says what the evidence was.";

/** The label for a stored value, or null for none / an unknown value (never a guess). */
export function describeGroupSyncBasis(value: string | null | undefined): string | null {
  return isGroupSyncBasis(value) ? GROUP_SYNC_BASIS_LABELS[value] : null;
}
