"use client";

import { useActionState, useState } from "react";
import { Alert, Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { approveModule, revokeModuleApproval, type ModuleApprovalState } from "@/server/platform/actions/moduleApprovals";

export interface ApprovalRowView {
  id: string;
  moduleName: string;
  scope: string;
  reason: string;
  approved: string;
  revoked: string | null;
  revokeReason: string | null;
}

/**
 * Platform approval of the approval-only modules (MODULE_APPROVALS.md). Approving switches nothing on — the
 * customer's Main Admin does that; revoking switches the module off where no other approval covers it.
 */
export function ModuleApprovalsPanel({
  customerId,
  modules,
  projects,
  approvals,
}: {
  customerId: string;
  modules: Array<{ key: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  approvals: ApprovalRowView[];
}) {
  const [state, action, pending] = useActionState<ModuleApprovalState, FormData>(approveModule.bind(null, customerId), {});
  const [values, setValues] = useState({ featureKey: modules[0]?.key ?? "", scope: "ALL", reason: "" });
  const active = approvals.filter((a) => !a.revoked);
  const history = approvals.filter((a) => a.revoked);

  return (
    <div className="space-y-5">
      {active.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">Nothing approved. The customer&apos;s Main Admin cannot switch any of these modules on.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-sm">
          {active.map((a) => (
            <ApprovalRow key={a.id} row={a} />
          ))}
        </ul>
      )}

      <form action={action} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
        <h3 className="text-sm font-semibold">Approve a module</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Module">
            <Select name="featureKey" value={values.featureKey} onChange={(e) => setValues((v) => ({ ...v, featureKey: e.target.value }))}>
              {modules.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For" hint="Every workspace includes the customer's later ones.">
            <Select name="scope" value={values.scope} onChange={(e) => setValues((v) => ({ ...v, scope: e.target.value }))}>
              <option value="ALL">Every workspace</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} only
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Reason" hint="Kept with the approval and in the platform's activity log.">
          <Textarea name="reason" rows={2} maxLength={500} required value={values.reason} onChange={(e) => setValues((v) => ({ ...v, reason: e.target.value }))} placeholder="e.g. Lab test passed on their test number; owner asked for it on 1 Nov" />
        </Field>
        <Field label="Your platform password">
          <Input name="operatorPassword" type="password" autoComplete="current-password" required className="max-w-sm" />
        </Field>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Approve
          </Button>
        </div>
      </form>

      {history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[color:var(--color-muted-foreground)]">Revoked approvals ({history.length})</summary>
          <ul className="mt-2 divide-y divide-[var(--color-border)]">
            {history.map((a) => (
              <li key={a.id} className="py-2">
                <span className="font-medium">{a.moduleName}</span> · {a.scope}
                <span className="block text-xs text-[color:var(--color-muted-foreground)]">
                  Approved {a.approved}: {a.reason}
                </span>
                <span className="block text-xs text-[color:var(--color-muted-foreground)]">
                  Revoked {a.revoked}: {a.revokeReason}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ApprovalRow({ row }: { row: ApprovalRowView }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, action, pending] = useActionState<ModuleApprovalState, FormData>(revokeModuleApproval.bind(null, row.id), {});
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{row.moduleName}</span>{" "}
          <Badge color="green">Approved</Badge>
          <span className="block text-xs text-[color:var(--color-muted-foreground)]">
            {row.scope} · {row.approved}
          </span>
          <span className="block text-xs text-[color:var(--color-muted-foreground)]">{row.reason}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Revoke…
        </Button>
      </div>
      {open ? (
        <form action={action} className="mt-3 space-y-3 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] p-3">
          <Alert tone="warning">The module is switched off at once wherever no other approval covers it. Its data is kept; scheduled work stops.</Alert>
          <Field label="Reason">
            <Textarea name="reason" rows={2} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Your platform password">
            <Input name="operatorPassword" type="password" autoComplete="current-password" required className="max-w-sm" />
          </Field>
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state.success ? <Alert tone="success">{state.success}</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="danger" loading={pending}>
              Revoke approval
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
