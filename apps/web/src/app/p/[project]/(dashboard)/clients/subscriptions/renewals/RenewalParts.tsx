"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { CalendarPlus, CheckCircle2, Clock, PhoneCall, RefreshCw, Send, Undo2, XCircle } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { prepareRenewalOffer, renewFromOffer, updateRenewalOffer, type OfferFormState } from "@/server/actions/clientRenewals";
import { CONTACT_CHANNELS, CONTACT_CHANNEL_LABELS, SUBSCRIPTION_DURATION_UNITS, SUBSCRIPTION_DURATION_LABELS, type RenewalOfferAction } from "@support-automation/shared";
import { RowMenu } from "../../RowMenu";

export interface OfferDefaults {
  service: string;
  durationValue: number | null;
  durationUnit: string | null;
  currency: string | null;
}

/** "Prepare offer" for one term: what is proposed, for how long, at what price (optional), valid until, follow up on. */
export function PrepareOfferButton({ subscriptionId, defaults, currencies, sellers, canPrice, label = "Prepare offer" }: { subscriptionId: string; defaults: OfferDefaults; currencies: string[]; sellers: Array<{ id: string; name: string }>; canPrice: boolean; label?: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<OfferFormState, FormData>(prepareRenewalOffer.bind(null, subscriptionId), {});
  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: state.success });
    setOpen(false);
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per result
  }, [state]);
  const v = (k: string, d: string) => state.values?.[k] ?? d;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Send className="size-3.5" aria-hidden /> {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title="Prepare a renewal offer" description="A proposal, not an invoice: nothing is owed because of an offer, even an accepted one. The term is renewed — and an invoice raised, if you choose — only from an accepted offer.">
        <form action={action} className="space-y-3">
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          <Field label="Service / plan">
            <Input name="service" defaultValue={v("service", defaults.service)} maxLength={120} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Duration">
              <Input name="durationValue" type="number" min={1} step={1} defaultValue={v("durationValue", String(defaults.durationValue ?? 1))} required />
            </Field>
            <Field label="Unit">
              <Select name="durationUnit" defaultValue={v("durationUnit", defaults.durationUnit ?? "MONTH")}>
                {SUBSCRIPTION_DURATION_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {SUBSCRIPTION_DURATION_LABELS[u][1]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {canPrice ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Proposed amount" hint="Optional. Not an invoice.">
                <Input name="amount" inputMode="decimal" defaultValue={v("amount", "")} placeholder="1500" />
              </Field>
              <Field label="Currency">
                <Select name="currency" defaultValue={v("currency", defaults.currency && currencies.includes(defaults.currency) ? defaults.currency : (currencies[0] ?? ""))}>
                  {currencies.length === 0 ? <option value="">No billing currency yet</option> : null}
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">Proposing a price needs the View Client Billing permission.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Valid until" hint="Optional.">
              <Input name="validUntil" type="date" defaultValue={v("validUntil", "")} />
            </Field>
            <Field label="Follow up on" hint="Optional. Listed under Follow-up due on that day.">
              <Input name="followUpDate" type="date" defaultValue={v("followUpDate", "")} />
            </Field>
          </div>
          {sellers.length ? (
            <Field label="Salesperson" hint="Optional. Credited on the renewal.">
              <Select name="soldByMemberId" defaultValue={v("soldByMemberId", "")}>
                <option value="">Same as the current term</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Note" hint="Internal.">
            <Textarea name="note" defaultValue={v("note", "")} rows={2} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Prepare offer
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

type Step = "RECORD_CONTACT" | "ACCEPT" | "DECLINE" | "WITHDRAW" | "SCHEDULE_FOLLOW_UP" | null;

/** The steps on one offer. Each is a separate, checked action; none of them creates money owed. */
export function OfferActions({ offerId, status, offerPrice, termEnd, today, canInvoice }: { offerId: string; status: string; offerPrice: string | null; termEnd: string; today: string; canInvoice: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>(null);
  const [renewing, setRenewing] = useState(false);
  const [note, setNote] = useState("");
  const [channel, setChannel] = useState<string>("WHATSAPP");
  const [followUp, setFollowUp] = useState("");
  const [busy, start] = useTransition();
  const open = status === "PREPARED" || status === "CONTACTED" || status === "AWAITING_RESPONSE" || status === "ACCEPTED";
  const run = (action: RenewalOfferAction, input: { note?: string; channel?: string; followUpDate?: string } = {}) =>
    start(async () => {
      const r = await updateRenewalOffer(offerId, action, input);
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) {
        setStep(null);
        setNote("");
        router.refresh();
      }
    });
  if (!open) return null;
  const titles: Record<Exclude<Step, null>, string> = {
    RECORD_CONTACT: "Record a contact attempt",
    ACCEPT: "Record the customer's acceptance",
    DECLINE: "Record the customer's decline",
    WITHDRAW: "Withdraw this offer",
    SCHEDULE_FOLLOW_UP: "Schedule a follow-up",
  };
  return (
    <div className="flex items-center justify-end gap-1.5">
      {status === "ACCEPTED" ? (
        <Button size="sm" onClick={() => setRenewing(true)}>
          <RefreshCw className="size-3.5" aria-hidden /> Renew
        </Button>
      ) : null}
      <RowMenu
        horizontal
        label="Offer actions"
        items={[
          { label: "Record contact…", icon: <PhoneCall className="size-4" aria-hidden />, onSelect: () => setStep("RECORD_CONTACT") },
          { label: "Mark awaiting response", icon: <Clock className="size-4" aria-hidden />, onSelect: () => run("MARK_AWAITING"), hidden: status !== "PREPARED" && status !== "CONTACTED" },
          { label: "Customer accepted…", icon: <CheckCircle2 className="size-4" aria-hidden />, onSelect: () => setStep("ACCEPT"), hidden: status === "ACCEPTED" },
          { label: "Customer declined…", icon: <XCircle className="size-4" aria-hidden />, onSelect: () => setStep("DECLINE") },
          { label: "Schedule follow-up…", icon: <CalendarPlus className="size-4" aria-hidden />, onSelect: () => setStep("SCHEDULE_FOLLOW_UP") },
          { label: "Withdraw offer…", icon: <Undo2 className="size-4" aria-hidden />, onSelect: () => setStep("WITHDRAW"), danger: true },
        ]}
      />
      <Dialog
        open={step !== null}
        onClose={() => setStep(null)}
        title={step ? titles[step] : ""}
        description={step === "ACCEPT" ? "Acceptance is recorded, not paid: nothing is owed until you renew and raise an invoice." : step === "DECLINE" ? "No balance is created by a decline." : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStep(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              variant={step === "WITHDRAW" ? "danger" : "primary"}
              disabled={(step === "DECLINE" || step === "WITHDRAW") && !note.trim()}
              onClick={() => step && run(step, { note, channel, followUpDate: followUp })}
            >
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {step === "RECORD_CONTACT" ? (
            <Field label="How">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CONTACT_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CONTACT_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {step === "SCHEDULE_FOLLOW_UP" ? (
            <Field label="Follow up on">
              <Input type="date" value={followUp} min={today} onChange={(e) => setFollowUp(e.target.value)} />
            </Field>
          ) : null}
          <Field label={step === "DECLINE" ? "What the customer said" : step === "WITHDRAW" ? "Why" : "Note"} hint={step === "DECLINE" || step === "WITHDRAW" ? "Required." : "Optional."}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
          </Field>
        </div>
      </Dialog>
      {renewing ? <RenewFromOfferDialog offerId={offerId} offerPrice={offerPrice} termEnd={termEnd} today={today} canInvoice={canInvoice} onClose={() => setRenewing(false)} /> : null}
    </div>
  );
}

function RenewFromOfferDialog({ offerId, offerPrice, termEnd, today, canInvoice, onClose }: { offerId: string; offerPrice: string | null; termEnd: string; today: string; canInvoice: boolean; onClose: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, action, pending] = useActionState<OfferFormState, FormData>(renewFromOffer.bind(null, offerId), {});
  const [invoice, setInvoice] = useState(false);
  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: state.success });
    router.refresh();
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per result
  }, [state]);
  const suggestedStart = termEnd > today ? termEnd : today;
  return (
    <Dialog open onClose={onClose} title="Renew from the accepted offer" description="Creates the new term with the offer's service and duration. The old term stays as history. A payment, when it arrives, is recorded separately.">
      <form action={action} className="space-y-3">
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Field label="Start date" hint="Where the current term ends, or today if it has lapsed.">
          <Input name="startDate" type="date" defaultValue={state.values?.startDate ?? suggestedStart} />
        </Field>
        {canInvoice && offerPrice ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="raiseInvoice" value="1" checked={invoice} onChange={(e) => setInvoice(e.target.checked)} /> Also raise an invoice for {offerPrice}
            </label>
            {invoice ? (
              <Field label="Invoice due date">
                <Input name="invoiceDueDate" type="date" defaultValue={state.values?.invoiceDueDate ?? suggestedStart} required />
              </Field>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">{offerPrice ? "Raising the invoice needs the Edit Client Billing permission." : "The offer has no price; raise an invoice on the Billing List if one is due."}</p>
        )}
        <Field label="Note" hint="Optional, kept on the new term.">
          <Textarea name="note" defaultValue={state.values?.note ?? ""} rows={2} maxLength={1000} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Renew
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
