"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Select, SwitchField, Textarea, useToast } from "@/components/ui";
import { approveSignup, rejectSignup, setSignupEnabled, type SignupDecision } from "@/server/platform/actions/signups";
import type { SignupRow } from "@/server/platform/signups";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });
type Tab = "PENDING_APPROVAL" | "EMAIL_PENDING" | "APPROVED" | "CLOSED";
const TABS: Array<[Tab, string]> = [["PENDING_APPROVAL", "Waiting for you"], ["EMAIL_PENDING", "Email not confirmed"], ["APPROVED", "Approved"], ["CLOSED", "Rejected or expired"]];
const inTab = (r: SignupRow, tab: Tab) => (tab === "CLOSED" ? r.status === "REJECTED" || r.status === "EXPIRED" : r.status === tab);

export function SignupSwitch({ open, pricingUrl, publicPlans }: { open: boolean; pricingUrl: string; publicPlans: number }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2.5">
      <SwitchField
        label="Public sign-up"
        description={open ? `Open at ${pricingUrl}` : "Closed. The pricing and sign-up pages do not exist until this is on."}
        checked={open}
        onChange={(e) => {
          const on = e.target.checked;
          start(async () => {
            const r = await setSignupEnabled(on);
            if (r.error) setError(r.error);
            else {
              setError(null);
              showToast({ tone: "success", title: r.success ?? "Saved" });
              router.refresh();
            }
          });
        }}
      />
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
        {publicPlans === 1 ? "1 plan is" : `${publicPlans} plans are`} shown on the pricing page. Set prices and choose which show on{" "}
        <NextLink href="/platform/plans" className="link">
          Plans &amp; billing
        </NextLink>
        .
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}

export function SignupQueue({ rows, plans }: { rows: SignupRow[]; plans: Array<{ id: string; name: string }> }) {
  const [tab, setTab] = useState<Tab>("PENDING_APPROVAL");
  const [approving, setApproving] = useState<SignupRow | null>(null);
  const [rejecting, setRejecting] = useState<SignupRow | null>(null);
  const shown = rows.filter((r) => inTab(r, tab));
  return (
    <>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium ${tab === key ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
            {label} <span className="tabular opacity-80">{rows.filter((r) => inTab(r, key)).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Card>
          <EmptyState>Nothing here.</EmptyState>
        </Card>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <li key={r.id}>
              <Card className="grid gap-x-4 gap-y-2 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
                    {r.businessName}
                    {r.planName ? <Badge color="blue">{r.planName}</Badge> : null}
                    {r.status === "REJECTED" ? <Badge color="red">Rejected</Badge> : null}
                    {r.status === "EXPIRED" ? <Badge color="gray">Expired</Badge> : null}
                  </p>
                  <p className="mt-0.5 break-words text-[13px] text-[color:var(--color-muted-foreground)]">
                    {r.ownerName} · {r.email}
                    {r.phone ? ` · ${r.phone}` : ""} · {r.slug}
                  </p>
                  <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    {DATE.format(new Date(r.createdAt))}
                    {r.rejectReason ? ` · ${r.rejectReason}` : ""}
                    {r.decidedBy ? ` · ${r.decidedBy}` : ""}
                  </p>
                  {r.emailError ? <p className="text-[12.5px] text-[color:var(--color-danger-fg)]">The email could not be sent: {r.emailError}</p> : null}
                </div>
                {r.status === "PENDING_APPROVAL" ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setApproving(r)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRejecting(r)}>
                      Reject
                    </Button>
                  </div>
                ) : r.customerId ? (
                  <NextLink href={`/platform/customers/${r.customerId}`} className="link text-[13px] font-medium">
                    Open customer
                  </NextLink>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {approving ? <ApproveDialog key={approving.id} row={approving} plans={plans} onClose={() => setApproving(null)} /> : null}
      {rejecting ? <RejectDialog key={rejecting.id} row={rejecting} onClose={() => setRejecting(null)} /> : null}
    </>
  );
}

function ApproveDialog({ row, plans, onClose }: { row: SignupRow; plans: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [state, action, pending] = useActionState<SignupDecision, FormData>(approveSignup.bind(null, row.id), {});
  if (state.success) {
    return (
      <Dialog open onClose={onClose} title={state.success}>
        <div className="space-y-3 text-[13.5px]">
          {state.link ? (
            <div>
              <p>The owner will get their invitation by email. Their link, shown once:</p>
              <p className="mt-1 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[12.5px]">{state.link}</p>
            </div>
          ) : null}
          {state.notes?.map((n) => (
            <Alert key={n} tone="warning">
              {n}
            </Alert>
          ))}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title={`Approve ${row.businessName}`} description="Sets up the workspace, the plan and an invitation to the owner, as Add customer does.">
      <form action={action} className="space-y-3.5">
        <Field label="Plan">
          <Select name="planId" defaultValue={row.planId ?? ""}>
            <option value="">No plan</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Workspace address">
          <Input name="slug" defaultValue={row.slug} required maxLength={63} />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox name="autoEnforce" />
          Suspend automatically if they do not pay
        </label>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Setting up…" : "Approve"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RejectDialog({ row, onClose }: { row: SignupRow; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Reject ${row.businessName}`} description="They will be told by email.">
      <div className="space-y-3.5">
        <Field label="Reason (optional)" hint="Included in the email.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await rejectSignup(row.id, reason);
                if (r.error) setError(r.error);
                else {
                  onClose();
                  router.refresh();
                }
              })
            }
          >
            Reject
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
