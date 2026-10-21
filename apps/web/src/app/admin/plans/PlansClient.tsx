"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { BILLING_INTERVAL_LABELS, formatMoneyMinor, isBillingInterval, SUPPORTED_CURRENCIES } from "@support-automation/shared";
import { Alert, Badge, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { saveBillingSettings, savePlan, setPlanActive, type BillingActionResult } from "@/server/actions/saasBilling";
import type { BillingSettingsData, PlanView } from "@/server/saasBilling";

type Feature = { key: string; label: string; defaultEnabled: boolean };

function useSaved(state: BillingActionResult, title: string, after?: () => void) {
  const router = useRouter();
  const { showToast } = useToast();
  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title, description: state.success ?? "" });
    after?.();
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per save
  }, [state.savedAt]);
}

const toMajor = (minor: string) => {
  const v = BigInt(minor);
  return `${v / BigInt(100)}${v % BigInt(100) ? `.${String(v % BigInt(100)).padStart(2, "0")}` : ""}`;
};

function PlanForm({ plan, features, onDone }: { plan: PlanView | null; features: Feature[]; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<BillingActionResult, FormData>(savePlan.bind(null, plan?.id ?? null), {});
  useSaved(state, plan ? "Plan saved" : "Plan created", onDone);
  const e = state.fieldErrors ?? {};
  // A new plan starts with the modules a new project gets anyway; the opt-in ones (off by default
  // for every project) are ticked only on purpose.
  const chosen = new Set(plan ? plan.features : features.filter((f) => f.defaultEnabled).map((f) => f.key));
  return (
    <form action={formAction} className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="pl-name" required error={e.name}>
          <Input id="pl-name" name="name" defaultValue={plan?.name ?? ""} maxLength={80} required />
        </Field>
        <Field label="Price" htmlFor="pl-price" required error={e.priceMinor} hint="Per billing period, e.g. 1500 or 1500.50.">
          <div className="flex gap-2">
            <Select name="currency" defaultValue={plan?.currency ?? "BDT"} aria-label="Currency" className="w-24">
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <Input id="pl-price" name="price" defaultValue={plan ? toMajor(plan.priceMinor) : ""} inputMode="decimal" required />
          </div>
        </Field>
        <Field label="Billing period" htmlFor="pl-interval" error={e.interval}>
          <Select id="pl-interval" name="interval" defaultValue={plan?.interval ?? "MONTH"}>
            <option value="MONTH">Monthly</option>
            <option value="YEAR">Yearly</option>
          </Select>
        </Field>
        <Field label="Free trial (days)" htmlFor="pl-trial" error={e.trialDays} hint="0 for no trial.">
          <Input id="pl-trial" name="trialDays" type="number" min={0} max={365} defaultValue={plan?.trialDays ?? 0} />
        </Field>
        <Field label="WhatsApp numbers" htmlFor="pl-wa" error={e.maxWhatsAppAccounts} hint="Empty = no limit.">
          <Input id="pl-wa" name="maxWhatsAppAccounts" type="number" min={0} defaultValue={plan?.maxWhatsAppAccounts ?? ""} />
        </Field>
        <Field label="Users" htmlFor="pl-users" error={e.maxUsers} hint="Logins with access, Main Admins not counted. Empty = no limit.">
          <Input id="pl-users" name="maxUsers" type="number" min={0} defaultValue={plan?.maxUsers ?? ""} />
        </Field>
      </div>
      <Field label="Description" htmlFor="pl-desc">
        <Textarea id="pl-desc" name="description" rows={2} defaultValue={plan?.description ?? ""} maxLength={500} />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Included modules</legend>
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {features.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="features" value={f.key} defaultChecked={chosen.has(f.key)} />
              {f.label}
            </label>
          ))}
        </div>
      </fieldset>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {plan ? "Save plan" : "Create plan"}
        </Button>
      </div>
    </form>
  );
}

export function PlanList({ plans, features, canManage }: { plans: PlanView[]; features: Feature[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [, startTransition] = useTransition();
  const label = (keys: string[]) => (keys.length === features.length ? "All modules" : `${keys.length} of ${features.length} modules`);

  return (
    <div className="space-y-3">
      {plans.length === 0 && editing !== "new" ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No plans yet.</p> : null}
      {plans.map((p) =>
        editing === p.id ? (
          <PlanForm key={p.id} plan={p} features={features} onDone={() => setEditing(null)} />
        ) : (
          <div key={p.id} className={`flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4 ${p.isActive ? "" : "opacity-60"}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {!p.isActive ? <Badge color="gray">Archived</Badge> : null}
              </div>
              <p className="mt-1 text-sm">
                {formatMoneyMinor(p.priceMinor, p.currency)} / {isBillingInterval(p.interval) ? BILLING_INTERVAL_LABELS[p.interval].toLowerCase() : p.interval}
                {p.trialDays ? ` · ${p.trialDays}-day trial` : ""}
              </p>
              <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                {p.maxWhatsAppAccounts ?? "Unlimited"} WhatsApp number{p.maxWhatsAppAccounts === 1 ? "" : "s"} · {p.maxUsers ?? "unlimited"} user
                {p.maxUsers === 1 ? "" : "s"} · {label(p.features)} · {p.customers} customer{p.customers === 1 ? "" : "s"}
              </p>
            </div>
            {canManage ? (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    startTransition(async () => {
                      const r = await setPlanActive(p.id, !p.isActive);
                      showToast({ tone: r.error ? "danger" : "success", title: r.error ? "Not done" : "Done", description: r.error ?? r.success ?? "" });
                      router.refresh();
                    })
                  }
                >
                  {p.isActive ? "Archive" : "Restore"}
                </Button>
              </div>
            ) : null}
          </div>
        ),
      )}
      {canManage ? (
        editing === "new" ? (
          <PlanForm plan={null} features={features} onDone={() => setEditing(null)} />
        ) : (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="size-4" aria-hidden />
            New plan
          </Button>
        )
      ) : null}
    </div>
  );
}

export function BillingSettingsForm({ settings, canManage }: { settings: BillingSettingsData; canManage: boolean }) {
  const [state, formAction, pending] = useActionState<BillingActionResult, FormData>(saveBillingSettings, {});
  useSaved(state, "Billing settings saved");
  const e = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4">
      <fieldset disabled={!canManage} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Grace period (days)" htmlFor="bs-grace" error={e.defaultGraceDays} hint="After a period ends unpaid, before an enforced subscription is suspended.">
            <Input id="bs-grace" name="defaultGraceDays" type="number" min={0} max={90} defaultValue={settings.defaultGraceDays} />
          </Field>
          <Field label="Reminder days" htmlFor="bs-remind" error={e.reminderDaysBefore} hint="Days before renewal to remind the owner, e.g. 7, 3, 1.">
            <Input id="bs-remind" name="reminderDaysBefore" defaultValue={settings.reminderDaysBefore.join(", ")} />
          </Field>
        </div>
        <Field label="Payment instructions" htmlFor="bs-pay" hint="Shown to customers on their Subscription page and in reminders: bKash/Nagad numbers, bank account, who to contact.">
          <Textarea id="bs-pay" name="paymentInstructions" rows={3} defaultValue={settings.paymentInstructions ?? ""} maxLength={1000} />
        </Field>
      </fieldset>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}
