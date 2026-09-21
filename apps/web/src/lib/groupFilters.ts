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
export type GroupFilterKey = "all" | "monitored" | "unmonitored" | "active" | "inactive";

export const GROUP_FILTER_KEYS = [
  "all",
  "monitored",
  "unmonitored",
  "active",
  "inactive",
] as const satisfies readonly GroupFilterKey[];

export function isGroupFilterKey(value: string | undefined): value is GroupFilterKey {
  return (GROUP_FILTER_KEYS as readonly string[]).includes(value ?? "");
}

/** The search half on its own — the filter chips' counts are computed against this, so each says
 *  how many match *within the current search* rather than across the whole table. */
export function buildGroupSearchWhere(search: string): Prisma.WhatsAppGroupWhereInput {
  const trimmed = search.trim();
  return trimmed ? { name: { contains: trimmed, mode: "insensitive" } } : {};
}

/**
 * Search + chip. `monitored`/`unmonitored` and `active`/`inactive` are deliberately separate axes
 * expressed as one chip list: "active" means the account is still a member of the group, while
 * "monitored" means an admin opted it into automation. Never conflate them.
 */
export function buildGroupWhere(search: string, filter: GroupFilterKey): Prisma.WhatsAppGroupWhereInput {
  const where: Prisma.WhatsAppGroupWhereInput = { ...buildGroupSearchWhere(search) };
  if (filter === "monitored") where.isMonitored = true;
  if (filter === "unmonitored") where.isMonitored = false;
  if (filter === "active") where.isActive = true;
  if (filter === "inactive") where.isActive = false;
  return where;
}
