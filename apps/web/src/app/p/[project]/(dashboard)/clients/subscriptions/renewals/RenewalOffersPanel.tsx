import { CONTACT_CHANNEL_LABELS, type ContactChannel } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Badge } from "@/components/ui";
import { formatDay } from "@/lib/clientDisplay";
import type { clientRenewalOffers } from "@/server/clientRenewals";
import { OfferActions } from "./RenewalParts";

type Offer = Awaited<ReturnType<typeof clientRenewalOffers>>[number];
const TONE: Record<string, "gray" | "blue" | "yellow" | "green" | "red"> = { PREPARED: "gray", CONTACTED: "blue", AWAITING_RESPONSE: "yellow", ACCEPTED: "green", RENEWED: "green", DECLINED: "red", WITHDRAWN: "gray" };

/** A client's renewal offers with their history (the profile's Subscriptions tab). A proposal is never shown as owed. */
export function RenewalOffersPanel({ offers, today, canManage, canInvoice, currentTerm }: { offers: Offer[]; today: string; canManage: boolean; canInvoice: boolean; currentTerm: { id: string; endDate: string } | null }) {
  if (offers.length === 0) return <p className="text-sm text-[color:var(--color-muted-foreground)]">No renewal offer yet. An offer records what was proposed and how the customer answered; it never creates money owed.</p>;
  return (
    <ul className="space-y-3">
      {offers.map((o) => (
        <li key={o.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{o.service}</span>
                <Badge color={TONE[o.status] ?? "gray"}>{o.statusLabel}</Badge>
                {o.lapsed ? <Badge color="red">Past valid-until</Badge> : null}
                {o.followUpDue ? <Badge color="yellow">Follow-up due</Badge> : null}
              </div>
              <p className="mt-0.5 text-sm text-[color:var(--color-muted-foreground)]">
                {o.duration}
                {o.price ? ` · ${o.price} proposed` : ""}
                {o.validUntil ? ` · valid until ${formatDay(o.validUntil)}` : ""}
                {o.followUpDate ? ` · follow up ${formatDay(o.followUpDate)}` : ""}
              </p>
              {o.invoiceDueId ? (
                <Link href={`/clients/dues/${o.invoiceDueId}`} className="text-sm hover:underline">
                  View the renewal invoice
                </Link>
              ) : null}
            </div>
            {canManage && currentTerm ? <OfferActions offerId={o.id} status={o.status} offerPrice={o.price} termEnd={currentTerm.endDate} today={today} canInvoice={canInvoice} /> : null}
          </div>
          {o.events.length ? (
            <ol className="mt-3 space-y-1 border-t border-[var(--color-border)] pt-3 text-xs text-[color:var(--color-muted-foreground)]">
              {o.events.map((e) => (
                <li key={e.id}>
                  <span className="text-[color:var(--color-foreground)]">
                    {e.type === "CONTACT"
                      ? `Contacted by ${CONTACT_CHANNEL_LABELS[e.channel as ContactChannel] ?? e.channel ?? "—"}`
                      : e.type === "PREPARED"
                        ? "Offer prepared"
                        : e.type === "RENEWED"
                          ? "Renewed from this offer"
                          : e.type === "FOLLOW_UP"
                            ? "Follow-up scheduled"
                            : `${e.fromStatus ?? "—"} → ${e.toStatus ?? "—"}`}
                  </span>
                  {e.note ? ` — ${e.note}` : ""} · {e.actorName ?? "—"} · {e.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
                </li>
              ))}
            </ol>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
