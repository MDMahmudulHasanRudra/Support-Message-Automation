import type { Prisma } from "@prisma/client";

/**
 * The /groups list's filter vocabulary, in one place.
 *
 * It lives here rather than in the page because "select all N matching these filters" is resolved
 * by a server action, and a second hand-written copy of this `where` would be a silent correctness
 * bug of the worst kind: the operator selects what the page told them are 1,798 unmonitored groups,
 * and the action writes to a different 1,798. Same reasoning as `lib/aiResponseModes.ts` — one
 * definition, imported by both sides, so the two cannot drift.
 *
 * "use server" files may only export async functions, which is why this cannot live in
 * `server/actions/groups.ts` alongside its only other caller.
 */
export type GroupFilterKey = "all" | "monitored" | "unmonitored" | "active" | "inactive" | "needs_setup";

export const GROUP_FILTER_KEYS = [
  "all",
  "monitored",
  "unmonitored",
  "active",
  "inactive",
  "needs_setup",
] as const satisfies readonly GroupFilterKey[];

export function isGroupFilterKey(value: string | undefined): value is GroupFilterKey {
  return (GROUP_FILTER_KEYS as readonly string[]).includes(value ?? "");
}

/**
 * The narrowing that is NOT the status chips: the search box and the account picker.
 *
 * The chips' own counts are computed against this, so each says how many match *within the current
 * search and account* rather than across the whole table — otherwise picking one account would
 * leave "Monitored (312)" counting groups belonging to a different number.
 */
export function buildGroupSearchWhere(search: string, accountId?: string | null): Prisma.WhatsAppGroupWhereInput {
  const trimmed = search.trim();
  return {
    ...(trimmed ? { name: { contains: trimmed, mode: "insensitive" as const } } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/**
 * Search + chip. `monitored`/`unmonitored` and `active`/`inactive` are deliberately separate axes
 * expressed as one chip list: "active" means the account is still a member of the group, while
 * "monitored" means an admin opted it into automation. Never conflate them.
 */
export function buildGroupWhere(
  search: string,
  filter: GroupFilterKey,
  accountId?: string | null,
): Prisma.WhatsAppGroupWhereInput {
  const where: Prisma.WhatsAppGroupWhereInput = { ...buildGroupSearchWhere(search, accountId) };
  if (filter === "monitored") where.isMonitored = true;
  if (filter === "unmonitored") where.isMonitored = false;
  if (filter === "active") where.isActive = true;
  if (filter === "inactive") where.isActive = false;
  // The one combination the single chip list could not express, and the list somebody opens this
  // page to work through: groups the account is really in that nobody has switched on yet.
  // Inactive groups are left out because monitoring a group the number has left does nothing.
  if (filter === "needs_setup") {
    where.isActive = true;
    where.isMonitored = false;
  }
  return where;
}
