/**
 * The column catalogues of the client register and the billing list (CLIENTS_V3.md §5).
 *
 * A column is PRESENTATION: which already-authorised fact is drawn. What a person may see is decided on
 * the server — a billing column is removed from the catalogue offered to someone without
 * `clients.view_billing`, AND the read model does not even select the figures for them. A saved
 * preference naming a column the viewer may no longer see is simply dropped when read back.
 */

export type ColumnNeed = "billing" | "subscriptions" | "groups";

export interface ListColumn {
  key: string;
  label: string;
  /** Shown when nobody has customised the list. */
  defaultVisible: boolean;
  /** Always first and cannot be hidden (the row's identity). */
  locked?: boolean;
  /** The permission or sub-module the column needs; absent = anyone who can open the list. */
  needs?: ColumnNeed;
  /** A server-side sort key this column orders by, when it has one. */
  sort?: string;
}

export const CLIENT_LIST_COLUMNS: readonly ListColumn[] = [
  { key: "client", label: "Client", defaultVisible: true, locked: true, sort: "name" },
  { key: "country", label: "Country", defaultVisible: true, sort: "country" },
  { key: "phone", label: "Phone & WhatsApp", defaultVisible: true },
  { key: "service", label: "Service / plan", defaultVisible: true, needs: "subscriptions" },
  { key: "expiry", label: "Expires", defaultVisible: true, needs: "subscriptions", sort: "expiry" },
  { key: "subscription", label: "Subscription", defaultVisible: true, needs: "subscriptions" },
  { key: "outstanding", label: "Outstanding", defaultVisible: true, needs: "billing" },
  { key: "soldBy", label: "Sold by", defaultVisible: true },
  { key: "whatsappGroup", label: "Linked WhatsApp group", defaultVisible: true, needs: "groups" },
  // Optional
  { key: "email", label: "Email", defaultVisible: false },
  { key: "company", label: "Company", defaultVisible: false },
  { key: "address", label: "Address / city", defaultVisible: false },
  { key: "currency", label: "Preferred currency", defaultVisible: false },
  { key: "assignedTeam", label: "Assigned team", defaultVisible: false },
  { key: "assignedTo", label: "Assigned staff", defaultVisible: false },
  { key: "subscriptionStart", label: "Subscription start", defaultVisible: false, needs: "subscriptions" },
  { key: "duration", label: "Duration", defaultVisible: false, needs: "subscriptions" },
  { key: "renewals", label: "Renewals", defaultVisible: false, needs: "subscriptions" },
  { key: "nextDue", label: "Next payment due", defaultVisible: false, needs: "billing" },
  { key: "invoices", label: "Open invoices", defaultVisible: false, needs: "billing" },
  { key: "category", label: "Category", defaultVisible: false },
  { key: "tags", label: "Tags", defaultVisible: false },
  { key: "source", label: "Source", defaultVisible: false },
  { key: "status", label: "Client status", defaultVisible: false },
  { key: "lastContact", label: "Last contact", defaultVisible: false, sort: "contact" },
  { key: "created", label: "Created on", defaultVisible: false, sort: "created" },
  { key: "updated", label: "Last updated", defaultVisible: false, sort: "updated" },
];

export const BILLING_LIST_COLUMNS: readonly ListColumn[] = [
  { key: "invoice", label: "Invoice / type", defaultVisible: true, locked: true, sort: "invoice" },
  { key: "client", label: "Client", defaultVisible: true, sort: "client" },
  { key: "service", label: "Service", defaultVisible: true },
  { key: "soldBy", label: "Sold by", defaultVisible: true },
  { key: "issued", label: "Issued", defaultVisible: false, sort: "issued" },
  { key: "due", label: "Due date", defaultVisible: true, sort: "due" },
  { key: "billed", label: "Billed", defaultVisible: true, sort: "amount" },
  { key: "collected", label: "Collected", defaultVisible: true },
  { key: "remaining", label: "Remaining", defaultVisible: true },
  { key: "status", label: "Payment status", defaultVisible: true },
  // Optional
  { key: "team", label: "Team", defaultVisible: false },
  { key: "currency", label: "Currency", defaultVisible: false },
  { key: "phone", label: "Client phone", defaultVisible: false },
  { key: "email", label: "Client email", defaultVisible: false },
  { key: "country", label: "Client country", defaultVisible: false },
  { key: "lastPayment", label: "Last payment", defaultVisible: false },
  { key: "subscriptionEnd", label: "Service expires", defaultVisible: false, needs: "subscriptions" },
  { key: "note", label: "Note", defaultVisible: false },
  { key: "createdBy", label: "Created by", defaultVisible: false },
];

export const LIST_KEYS = { clients: CLIENT_LIST_COLUMNS, billing: BILLING_LIST_COLUMNS } as const;
export type ListKey = keyof typeof LIST_KEYS;
export const isListKey = (v: unknown): v is ListKey => v === "clients" || v === "billing";

/** The columns a viewer may choose from, given what they may see. */
export function allowedColumns(list: ListKey, can: Partial<Record<ColumnNeed, boolean>>): ListColumn[] {
  return LIST_KEYS[list].filter((c) => !c.needs || can[c.needs]);
}

export function defaultColumnKeys(list: ListKey, can: Partial<Record<ColumnNeed, boolean>>): string[] {
  return allowedColumns(list, can)
    .filter((c) => c.defaultVisible)
    .map((c) => c.key);
}

/**
 * A saved or submitted selection made safe: known, allowed and unique keys only, in the order given,
 * with the locked identity column first. Nothing left (or nothing saved) = the defaults.
 */
export function sanitizeColumns(list: ListKey, requested: readonly unknown[] | null | undefined, can: Partial<Record<ColumnNeed, boolean>>): string[] {
  const allowed = allowedColumns(list, can);
  const allowedKeys = new Set(allowed.map((c) => c.key));
  const locked = allowed.filter((c) => c.locked).map((c) => c.key);
  const out: string[] = [...locked];
  for (const key of requested ?? []) {
    if (typeof key !== "string" || !allowedKeys.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > locked.length ? out : defaultColumnKeys(list, can);
}
