"use client";

import NextLink from "next/link";
import { useActionState, useState } from "react";
import { BILLING_INTERVAL_LABELS, formatMoneyMinor, isBillingInterval, PROJECT_NAME_MAX, PROJECT_SLUG_MAX, SAAS_PAYMENT_METHODS, SAAS_PAYMENT_METHOD_LABELS, suggestProjectSlug } from "@support-automation/shared";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { createCustomer, type CustomerFormState } from "@/server/platform/actions/customers";

interface PlanOption {
  id: string;
  name: string;
  priceMinor: string;
  currency: string;
  interval: string;
  allModules: boolean;
}

const toMajor = (minor: string) => {
  const v = BigInt(minor);
  return `${v / BigInt(100)}${v % BigInt(100) ? `.${String(v % BigInt(100)).padStart(2, "0")}` : ""}`;
};

const Section = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <fieldset className="space-y-4 border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0">
    <legend className="mb-1 text-sm font-semibold text-[color:var(--color-foreground)]">
      <span className="mr-2 text-[color:var(--color-subtle-foreground)]">{n}.</span>
      {title}
    </legend>
    {children}
  </fieldset>
);

/**
 * Onboarding in one form (SAAS_PLATFORM_PLAN.md §12): company → owner → address → plan (All Access
 * unless chosen otherwise) → price, expiry, first payment. After saving: the owner's link and what is
 * left to do (DNS, Check now).
 */
export function NewCustomerForm({
  plans,
  defaultPlanId,
  defaultGraceDays,
  rootDomain,
  canAdoptOriginal,
  suggestedWorkspace,
}: {
  plans: PlanOption[];
  defaultPlanId: string | null;
  defaultGraceDays: number;
  rootDomain: string | null;
  canAdoptOriginal: boolean;
  suggestedWorkspace: string;
}) {
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(createCustomer, {});
  const [mode, setMode] = useState<"new" | "original">("new");
  const [ownerMode, setOwnerMode] = useState<"invite" | "login" | "later">("invite");
  const [planId, setPlanId] = useState(defaultPlanId ?? plans[0]?.id ?? "");
  const [workspace, setWorkspace] = useState(suggestedWorkspace);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const plan = plans.find((p) => p.id === planId);
  const e = state.fieldErrors ?? {};

  if (state.created) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Customer added">
          {mode === "original" ? "The original installation is now a customer. Nothing in it changed." : "Its software is ready."}
        </Alert>
        {state.created.link ? (
          <Alert tone="info" title="Owner invitation — shown once">
            <code className="block break-all rounded bg-[var(--color-surface-sunken)] p-2 font-mono text-xs">{state.created.link}</code>
            <p className="mt-2 text-xs">Single use, valid for 72 hours, on the customer&apos;s own address. Send it privately.</p>
          </Alert>
        ) : null}
        {state.created.notes.length > 0 ? (
          <Alert tone="warning" title="Still to do">
            <ul className="list-disc space-y-1 pl-4">
              {state.created.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <NextLink href={`/platform/customers/${state.created.customerId}`} className="inline-block text-sm font-medium text-[color:var(--color-accent)] hover:underline">
          Open the customer →
        </NextLink>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      {canAdoptOriginal ? (
        <Field label="What is this customer?" htmlFor="c-mode" error={e.mode}>
          <Select id="c-mode" name="mode" value={mode} onChange={(ev) => setMode(ev.target.value === "original" ? "original" : "new")}>
            <option value="new">A new customer — give them their own copy of the software</option>
            <option value="original">The original installation (Customer #1) — nothing in it changes</option>
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="mode" value="new" />
      )}

      <Section n={1} title="Company">
        <Field label="Customer name" htmlFor="c-name" required error={e.name}>
          <Input id="c-name" name="name" maxLength={120} required autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Contact person" htmlFor="c-contact">
            <Input id="c-contact" name="contactName" maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Contact email" htmlFor="c-email" error={e.contactEmail} hint="Receives renewal reminders.">
            <Input id="c-email" name="contactEmail" type="email" maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Contact phone" htmlFor="c-phone">
            <Input id="c-phone" name="contactPhone" maxLength={40} autoComplete="off" />
          </Field>
        </div>
      </Section>

      {mode === "new" ? (
        <>
          <Section n={2} title="Owner — the customer's own Main Admin">
            <Field label="How do they get in?" htmlFor="c-owner-mode">
              <Select id="c-owner-mode" name="ownerMode" value={ownerMode} onChange={(ev) => setOwnerMode(ev.target.value as typeof ownerMode)}>
                <option value="invite">Invite them — they choose their own username and password</option>
                <option value="login">Create their login now — you give them the password</option>
                <option value="later">Later</option>
              </Select>
            </Field>
            {ownerMode !== "later" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Owner's name" htmlFor="c-owner-name" required error={e.ownerName}>
                  <Input id="c-owner-name" name="ownerName" maxLength={120} autoComplete="off" />
                </Field>
                <Field label="Owner's email" htmlFor="c-owner-email" error={e.ownerEmail} hint={ownerMode === "invite" ? "The invitation is emailed when platform email is set up." : undefined}>
                  <Input id="c-owner-email" name="ownerEmail" type="email" maxLength={200} autoComplete="off" />
                </Field>
                {ownerMode === "login" ? (
                  <>
                    <Field label="Username" htmlFor="c-owner-user" required error={e.ownerUsername}>
                      <Input id="c-owner-user" name="ownerUsername" maxLength={60} autoComplete="off" />
                    </Field>
                    <Field label="Password" htmlFor="c-owner-pass" required error={e.ownerPassword} hint="At least 12 characters. Share it privately.">
                      <Input id="c-owner-pass" name="ownerPassword" type="password" autoComplete="new-password" />
                    </Field>
                  </>
                ) : null}
              </div>
            ) : null}
          </Section>

          <Section n={3} title="Workspace and address">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First workspace" htmlFor="c-ws" required error={e.projectName} hint="Their Main Admin can add more workspaces later.">
                <Input id="c-ws" name="projectName" value={workspace} maxLength={PROJECT_NAME_MAX} onChange={(ev) => setWorkspace(ev.target.value)} required />
              </Field>
              <Field label="Workspace link name" htmlFor="c-slug" required error={e.projectSlug} hint="Used in links: /p/<name>/">
                <Input
                  id="c-slug"
                  name="projectSlug"
                  value={slugEdited ? slug : suggestProjectSlug(workspace)}
                  maxLength={PROJECT_SLUG_MAX}
                  onChange={(ev) => {
                    setSlug(ev.target.value);
                    setSlugEdited(true);
                  }}
                  className="font-mono"
                  required
                />
              </Field>
            </div>
            <Field label="Customer address" htmlFor="c-host" error={e.hostname} hint={`Their own subdomain, for example customer2.${rootDomain ?? "udboy.com"}. You can add it later.`}>
              <Input id="c-host" name="hostname" maxLength={253} autoComplete="off" className="font-mono" placeholder={`customer2.${rootDomain ?? "udboy.com"}`} />
            </Field>
          </Section>

          <Section n={4} title="Plan, price and payment">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plan" htmlFor="c-plan" error={e.planId}>
                <Select id="c-plan" name="planId" value={planId} onChange={(ev) => setPlanId(ev.target.value)}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatMoneyMinor(p.priceMinor, p.currency)} / {isBillingInterval(p.interval) ? BILLING_INTERVAL_LABELS[p.interval].toLowerCase() : p.interval}
                    </option>
                  ))}
                  <option value="">No plan (not billed)</option>
                </Select>
              </Field>
              {plan ? (
                <Field label={`Price for this customer (${plan.currency})`} htmlFor="c-price" error={e.price} hint="Empty = the plan's price.">
                  <Input id="c-price" name="price" inputMode="decimal" placeholder={toMajor(plan.priceMinor)} />
                </Field>
              ) : null}
            </div>
            {plan ? (
              <>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">{plan.allModules ? "Every module of the software is switched on, including ones added later." : "The plan's modules are switched on."}</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Paid through (expiry)" htmlFor="c-paid" error={e.paidThrough} hint="Empty: the first payment sets it.">
                    <Input id="c-paid" name="paidThrough" type="date" />
                  </Field>
                  <Field label="Grace days" htmlFor="c-grace">
                    <Input id="c-grace" name="graceDays" type="number" min={0} max={90} defaultValue={defaultGraceDays} />
                  </Field>
                  <label className="flex items-start gap-2 pt-6 text-sm">
                    <input type="checkbox" name="autoEnforce" className="mt-1" />
                    <span>Suspend automatically when unpaid</span>
                  </label>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="First payment (optional)" htmlFor="c-pay" error={e.paymentAmount} hint="Amount received now.">
                    <Input id="c-pay" name="paymentAmount" inputMode="decimal" />
                  </Field>
                  <Field label="Method" htmlFor="c-pay-method">
                    <Select id="c-pay-method" name="paymentMethod" defaultValue="BKASH">
                      {SAAS_PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {SAAS_PAYMENT_METHOD_LABELS[m]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reference" htmlFor="c-pay-ref">
                    <Input id="c-pay-ref" name="paymentReference" maxLength={120} autoComplete="off" />
                  </Field>
                </div>
              </>
            ) : null}
          </Section>
        </>
      ) : (
        <Section n={2} title="Address">
          <Alert tone="info">
            Its projects, people, roles, WhatsApp numbers and settings stay exactly as they are, and no plan is given — it is never billed, limited or
            suspended until you decide otherwise.
          </Alert>
          <Field label="Its address" htmlFor="c-host-o" error={e.hostname} hint="For example zoventio.udboy.com. You can add it later.">
            <Input id="c-host-o" name="hostname" maxLength={253} autoComplete="off" className="font-mono" />
          </Field>
        </Section>
      )}

      <Field label="Notes" htmlFor="c-notes" hint="Only platform operators see these.">
        <Textarea id="c-notes" name="notes" rows={2} maxLength={2000} />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          {mode === "original" ? "Adopt the original installation" : "Add customer"}
        </Button>
      </div>
    </form>
  );
}
