/**
 * The order to empty a set of tables in so that no foreign key refuses a delete (CUSTOMER_REMOVAL.md,
 * permanent delete). Pure: the caller reads the tables and their foreign keys from the database's own
 * catalogue, so a table added later is covered without anybody remembering to list it.
 *
 * Every key between two tables of the set is an edge, child → parent, and the child's rows should go
 * first. A BLOCKING key (ON DELETE RESTRICT / NO ACTION) must be honoured, or the delete fails. A key
 * that cascades or sets null would not fail, but deleting the parent first rewrites the child's rows
 * — and some tables refuse to be rewritten (a client payment is immutable) — so those are honoured
 * too wherever they can be. Only when the tables point at each other (a client and its current
 * subscription) is one non-blocking key given up: the first table, alphabetically, that no remaining
 * BLOCKING key holds back goes next. A table referencing itself is emptied by one statement.
 *
 * Alphabetical among equals, so the order is the same on every run. A cycle of blocking keys cannot be
 * ordered at all, and is returned rather than guessed at — the caller refuses the delete and names it.
 */
export type DeletionOrder = { ok: true; order: string[] } | { ok: false; cycle: string[] };

export interface DeletionEdge {
  child: string;
  parent: string;
  /** RESTRICT / NO ACTION. Defaults to true: when unsure, treat a key as one that refuses. */
  blocking?: boolean;
}

export function deletionOrder(tables: readonly string[], edges: readonly DeletionEdge[]): DeletionOrder {
  const inSet = new Set(tables);
  const all = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  const blocking = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent, blocking: isBlocking = true } of edges) {
    if (child === parent || !inSet.has(child) || !inSet.has(parent)) continue;
    all.get(parent)!.add(child);
    if (isBlocking) blocking.get(parent)!.add(child);
  }
  const order: string[] = [];
  const remaining = new Set(tables);
  const clear = (children: Map<string, Set<string>>) => (t: string) => [...children.get(t)!].every((c) => !remaining.has(c));
  while (remaining.size > 0) {
    let next = [...remaining].filter(clear(all)).sort();
    if (next.length === 0) next = [...remaining].filter(clear(blocking)).sort().slice(0, 1);
    if (next.length === 0) return { ok: false, cycle: [...remaining].sort() };
    for (const t of next) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return { ok: true, order };
}
