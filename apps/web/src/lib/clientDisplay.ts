import { formatMinor, toMinor, type InvoiceState, type SubscriptionState } from "@support-automation/shared";

/**
 * Presentation helpers for the Client pages (CLIENTS_V3.md): dates, money and the colours of each
 * state. Client-safe (no server import), so the tables, cards and dialogs all word things the same way.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-15" → "Oct 15, 2026". A calendar day, so no time zone is involved. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** "200.00" + "AED" → "AED 200.00", in the currency's own decimals. */
export function money(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "No amount";
  const minor = toMinor(amount);
  return minor === null ? `${currency ?? ""} ${amount}`.trim() : formatMinor(minor, currency ?? null);
}

export type Tone = "green" | "yellow" | "red" | "gray" | "blue" | "cyan";

export const SUBSCRIPTION_TONE: Record<SubscriptionState, Tone> = {
  NONE: "gray",
  SCHEDULED: "blue",
  TRIAL: "cyan",
  ACTIVE: "green",
  EXPIRING: "yellow",
  EXPIRED: "red",
  PAUSED: "gray",
  CANCELLED: "gray",
};

export const INVOICE_TONE: Record<InvoiceState, Tone> = {
  PAID: "green",
  PART_PAID: "yellow",
  OVERDUE: "red",
  OPEN: "blue",
  WAIVED: "gray",
  CANCELLED: "gray",
  NO_AMOUNT: "gray",
};

/** Text colour for an expiry date: red once expired, amber when it needs a renewal soon. */
export function expiryTextClass(state: SubscriptionState): string {
  if (state === "EXPIRED") return "text-[color:var(--color-danger-fg)]";
  if (state === "EXPIRING" || state === "TRIAL") return "text-[color:var(--color-warning-fg)]";
  return "text-[color:var(--color-foreground)]";
}

/** The internal chat route for a linked group: this project's own WhatsApp Chat, never wa.me. */
export function groupChatHref(accountId: string | null, groupId: string | null): string | null {
  return accountId && groupId ? `/chat/account/${accountId}/${groupId}` : null;
}

/** Project-relative; pass it through `useProjectHref()` before use. */
export function photoPath(clientId: string, version: number | null): string | null {
  return version ? `/api/clients/${clientId}/photo?v=${version}` : null;
}
