"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import {
  BILLING_INTERVAL_LABELS,
  formatMoneyMinor,
  isBillingInterval,
  isSaasPaymentMethod,
  SAAS_PAYMENT_METHOD_LABELS,
  SAAS_PAYMENT_METHODS,
  SAAS_SUBSCRIPTION_STATE_LABELS,
} from "@support-automation/shared";
import { Alert, Badge, Button, Field, Input, Select, SectionHeader, Table, Td, Textarea, Th, useToast } from "@/components/ui";
import {
  assignPlan,
  cancelSubscription,
  extendSubscription,
  issueInvoice,
  recordPayment,
  reversePayment,
  suspendSubscription,
  unlockSubscription,
  updateSubscriptionTerms,
  voidInvoice,
  type BillingActionResult,
} from "@/server/actions/saasBilling";
import type { CustomerBillingData, PlanView, SubscriptionView } from "@/server/saasBilling";

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const STATE_COLOR = { TRIALING: "blue", ACTIVE: "green", PAST_DUE: "yellow", SUSPENDED: "red", CANCELLED: "gray" } as const;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

function useResult(state: BillingActionResult, onSuccess?: () => void) {
  const router = useRouter();
  const { showToast } = useToast();
  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: "Done", description: state.success });
      onSuccess?.();
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per result
  }, [state]);
}

function Errors({ state }: { state: BillingActionResult }) {
  const messages = [state.error, ...Object.values(state.fieldErrors ?? {})].filter(Boolean);
  return messages.length ? <Alert tone="danger">{messages.join(" ")}</Alert> : null;
}

/**
 * Assign a plan, or change it. A change starts from the current terms — the paid-through date and
 * automatic suspension carry over unless edited — so changing plan never makes a paying customer
 * unpaid, nor silently switches enforcement off.
 */
function AssignPlanForm({ customerId, plans, defaultGraceDays, current, onDone }: { customerId: string; plans: PlanView[]; defaultGraceDays: number; current: SubscriptionView | null; onDone?: () => void }) {
  const [state, action, pending] = useActionState<BillingActionResult, FormData>(assignPlan.bind(null, customerId), {});
  useResult(state, onDone);
  const active = plans.filter((p) => p.isActive);
  if (active.length === 0) return <p className="text-sm text-[color:var(--color-muted-foreground)]">Create a plan first (Main Admin → Plans).</p>;
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan" htmlFor="ap-plan" required>
          <Select id="ap-plan" name="planId" defaultValue={current?.planId && active.some((p) => p.id === current.planId) ? current.planId : active[0]!.id}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatMoneyMinor(p.priceMinor, p.currency)} / {isBillingInterval(p.interval) ? BILLING_INTERVAL_LABELS[p.interval].toLowerCase() : p.interval}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starts" htmlFor="ap-start">
          <Input id="ap-start" name="startsAt" type="date" defaultValue={today()} />
        </Field>
        <Field label="Trial days" htmlFor="ap-trial" hint={current ? "A plan change starts no new trial unless you set one." : "Empty = the plan's own trial."}>
          <Input id="ap-trial" name="trialDays" type="number" min={0} max={365} defaultValue={current ? 0 : undefined} />
        </Field>
        <Field label="Already paid through (optional)" htmlFor="ap-paid" hint={current ? "Kept from the current subscription unless you change it." : "If they have paid for a period already."}>
          <Input id="ap-paid" name="paidThrough" type="date" defaultValue={current?.paidThrough?.slice(0, 10) ?? ""} />
        </Field>
        <Field label="Grace days" htmlFor="ap-grace">
          <Input id="ap-grace" name="graceDays" type="number" min={0} max={90} defaultValue={defaultGraceDays} />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="autoEnforce" defaultChecked={current?.autoEnforce ?? false} className="mt-1" />
        <span>
          <span className="font-medium">Suspend automatically when unpaid</span>
          <span className="block text-xs text-[color:var(--color-muted-foreground)]">
            Off by default. When off, this customer is never suspended by itself — only by you. Leave it off for an existing customer until you have agreed terms.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="applyFeatures" value="on" defaultChecked className="mt-1" />
        <span>
          <span className="font-medium">Set the workspace&apos;s modules to the plan&apos;s</span>
          <span className="block text-xs text-[color:var(--color-muted-foreground)]">Modules the plan does not include are switched off (nothing is deleted).</span>
        </span>
      </label>
      <Errors state={state} />
      <div className="flex justify-end gap-2">
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={pending}>
          {current ? "Change plan" : "Assign plan"}
        </Button>
      </div>
    </form>
  );
}

function RecordPaymentForm({ customerId, openInvoices, onDone }: { customerId: string; openInvoices: CustomerBillingData["invoices"]; onDone: () => void }) {
  const [state, action, pending] = useActionState<BillingActionResult, FormData>(recordPayment.bind(null, customerId), {});
  useResult(state, onDone);
  return (
    <form action={action} className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (BDT)" htmlFor="rp-amount" required>
          <Input id="rp-amount" name="amount" inputMode="decimal" required />
        </Field>
        <Field label="Method" htmlFor="rp-method" required>
          <Select id="rp-method" name="method" defaultValue="BKASH">
            {SAAS_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {SAAS_PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference" htmlFor="rp-ref" hint="Transaction ID, cheque or receipt number. Never a card number.">
          <Input id="rp-ref" name="reference" maxLength={120} />
        </Field>
        <Field label="Received on" htmlFor="rp-date">
          <Input id="rp-date" name="receivedAt" type="date" defaultValue={today()} />
        </Field>
        <Field label="Pays invoice" htmlFor="rp-inv">
          <Select id="rp-inv" name="invoiceId" defaultValue={openInvoices[0]?.id ?? ""}>
            <option value="">None — record it on its own</option>
            {openInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} — {formatMoneyMinor(i.amountMinor, i.currency)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Covers through" htmlFor="rp-covers" hint="Empty = the invoice's period end, or one more period.">
          <Input id="rp-covers" name="coversThrough" type="date" />
        </Field>
      </div>
      <Field label="Note" htmlFor="rp-note">
        <Input id="rp-note" name="note" maxLength={500} />
      </Field>
      <Errors state={state} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Record payment
        </Button>
      </div>
    </form>
  );
}

function SimpleForm({
  action,
  fields,
  submit,
  onDone,
  variant = "secondary",
}: {
  action: (prev: BillingActionResult, formData: FormData) => Promise<BillingActionResult>;
  fields: React.ReactNode;
  submit: string;
  onDone: () => void;
  variant?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState<BillingActionResult, FormData>(action, {});
  useResult(state, onDone);
  return (
    <form action={formAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
      {fields}
      <Errors state={state} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={variant} loading={pending}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

export function BillingPanel({
  customerId,
  billing,
  plans,
  defaultGraceDays,
  canManage,
}: {
  customerId: string;
  billing: CustomerBillingData;
  plans: PlanView[];
  defaultGraceDays: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState<null | "plan" | "payment" | "extend" | "suspend" | "cancel" | "terms">(null);
  const [busy, startTransition] = useTransition();
  const sub = billing.subscription;
  const close = () => setOpen(null);
  const run = (fn: () => Promise<BillingActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      const problem = r.error ?? (r.fieldErrors ? Object.values(r.fieldErrors).join(" ") : null);
      showToast({ tone: problem ? "danger" : "success", title: problem ? "Not done" : "Done", description: problem ?? r.success ?? "" });
      router.refresh();
    });

  if (!sub) {
    return (
      <div className="space-y-4">
        <Alert tone="info" title="No subscription">
          This customer is not billed here, has no limits and can never be suspended by billing. Assign a plan when you are ready.
        </Alert>
        {canManage ? <AssignPlanForm customerId={customerId} plans={plans} defaultGraceDays={defaultGraceDays} current={null} /> : null}
      </div>
    );
  }

  const r = sub.reading;
  const openInvoices = billing.invoices.filter((i) => i.status === "OPEN");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{sub.planName}</span>
            <Badge color={STATE_COLOR[r.state]} dot>
              {SAAS_SUBSCRIPTION_STATE_LABELS[r.state]}
            </Badge>
            {r.held ? <Badge color="red">Workspace read-only</Badge> : null}
          </div>
          <p className="mt-1 text-sm">
            {formatMoneyMinor(sub.priceMinor, sub.currency)} / {isBillingInterval(sub.interval) ? BILLING_INTERVAL_LABELS[sub.interval].toLowerCase() : sub.interval}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            {r.state === "TRIALING" ? "Trial ends" : "Paid through"} {day(r.accessUntil)} · grace {sub.graceDays} day{sub.graceDays === 1 ? "" : "s"} ·{" "}
            {sub.autoEnforce ? (r.suspendsAt ? `suspends automatically on ${day(r.suspendsAt)}` : "suspends automatically when unpaid") : "never suspended automatically"}
            {sub.suspendReason ? ` · suspended: ${sub.suspendReason}` : ""}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setOpen("payment")}>
              Record payment
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => issueInvoice(customerId))}>
              Issue invoice
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen("extend")}>
              Extend
            </Button>
            {r.held ? (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => unlockSubscription(customerId))}>
                Unlock
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setOpen("suspend")}>
                Suspend
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setOpen("terms")}>
              Terms
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen("plan")}>
              Change plan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen("cancel")}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>

      {open === "payment" ? <RecordPaymentForm customerId={customerId} openInvoices={openInvoices} onDone={close} /> : null}
      {open === "plan" ? <AssignPlanForm customerId={customerId} plans={plans} defaultGraceDays={sub.graceDays} current={sub} onDone={close} /> : null}
      {open === "extend" ? (
        <SimpleForm
          action={extendSubscription.bind(null, customerId)}
          onDone={close}
          submit="Extend"
          fields={
            <Field label="Days to add" htmlFor="ex-days" hint="From the end of the paid period, or from today if it has ended.">
              <Input id="ex-days" name="days" type="number" min={1} max={3650} defaultValue={30} />
            </Field>
          }
        />
      ) : null}
      {open === "suspend" ? (
        <SimpleForm
          action={suspendSubscription.bind(null, customerId)}
          onDone={close}
          submit="Suspend now"
          variant="danger"
          fields={
            <>
              <Alert tone="warning">
                The workspace becomes read-only at once: automation, AI and outgoing messages stop. All data, WhatsApp sessions and incoming messages are kept. Unlock
                any time.
              </Alert>
              <Field label="Reason" htmlFor="sp-reason">
                <Input id="sp-reason" name="reason" maxLength={500} placeholder="e.g. Unpaid since October" />
              </Field>
            </>
          }
        />
      ) : null}
      {open === "cancel" ? (
        <SimpleForm
          action={cancelSubscription.bind(null, customerId)}
          onDone={close}
          submit="Cancel subscription"
          variant="danger"
          fields={
            <Field label="When" htmlFor="cs-when" hint="Cancelled = read-only workspace; nothing is deleted. Unlock or assign a plan to restore.">
              <Select id="cs-when" name="when" defaultValue="periodEnd">
                <option value="periodEnd">At the end of the paid period</option>
                <option value="now">Now</option>
              </Select>
            </Field>
          }
        />
      ) : null}
      {open === "terms" ? (
        <SimpleForm
          action={updateSubscriptionTerms.bind(null, customerId)}
          onDone={close}
          submit="Save terms"
          fields={
            <>
              <Field label="Grace days" htmlFor="tm-grace">
                <Input id="tm-grace" name="graceDays" type="number" min={0} max={90} defaultValue={sub.graceDays} />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="autoEnforce" defaultChecked={sub.autoEnforce} className="mt-1" />
                <span>
                  <span className="font-medium">Suspend automatically when unpaid</span>
                  <span className="block text-xs text-[color:var(--color-muted-foreground)]">When off, only you can suspend this customer.</span>
                </span>
              </label>
              <Field label="Notes" htmlFor="tm-notes">
                <Textarea id="tm-notes" name="notes" rows={2} defaultValue={sub.notes ?? ""} maxLength={2000} />
              </Field>
            </>
          }
        />
      ) : null}

      <div>
        <SectionHeader title="Invoices" />
        {billing.invoices.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">None yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Period</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {billing.invoices.map((i) => (
                <tr key={i.id}>
                  <Td className="font-mono text-xs">{i.number}</Td>
                  <Td>
                    {day(i.periodStart)} → {day(i.periodEnd)}
                  </Td>
                  <Td>{formatMoneyMinor(i.amountMinor, i.currency)}</Td>
                  <Td>
                    <Badge color={i.status === "PAID" ? "green" : i.status === "OPEN" ? "yellow" : "gray"}>{i.status === "OPEN" ? "Due" : i.status === "PAID" ? "Paid" : "Void"}</Badge>
                  </Td>
                  <Td>
                    {canManage && i.status === "OPEN" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const reason = window.prompt(`Void ${i.number}? Say why:`);
                          if (reason) run(() => voidInvoice(i.id, {}, form({ reason })));
                        }}
                      >
                        Void
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div>
        <SectionHeader title="Payments" />
        {billing.payments.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">None yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Amount</Th>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th>Invoice</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {billing.payments.map((p) => (
                <tr key={p.id} className={p.reversedAt ? "opacity-60" : ""}>
                  <Td>{day(p.receivedAt)}</Td>
                  <Td>
                    {formatMoneyMinor(p.amountMinor, p.currency)}
                    {p.reversedAt ? <span className="ml-2 text-xs">(reversed: {p.reversalReason})</span> : null}
                  </Td>
                  <Td>{isSaasPaymentMethod(p.method) ? SAAS_PAYMENT_METHOD_LABELS[p.method] : p.method}</Td>
                  <Td className="text-xs">{p.reference ?? "—"}</Td>
                  <Td className="font-mono text-xs">{p.invoiceNumber ?? "—"}</Td>
                  <Td>
                    {canManage && !p.reversedAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const reason = window.prompt("Reverse this payment? It is kept in the history. Say why:");
                          if (reason) run(() => reversePayment(p.id, {}, form({ reason })));
                        }}
                      >
                        Reverse
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {billing.events.length > 0 ? (
        <div>
          <SectionHeader title="History" />
          <ul className="space-y-1.5 text-xs">
            {billing.events.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-2">
                <span className="text-[color:var(--color-muted-foreground)]">{new Date(e.createdAt).toLocaleString()}</span>
                <span className="font-medium">{e.kind.replace(/_/g, " ").toLowerCase()}</span>
                {e.actorUsername ? <span className="text-[color:var(--color-muted-foreground)]">by {e.actorUsername}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
