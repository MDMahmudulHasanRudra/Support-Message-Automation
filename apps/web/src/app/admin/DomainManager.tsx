"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { CheckCircle2, CircleAlert, Plus, RefreshCw } from "lucide-react";
import { DOMAIN_STATUS_DESCRIPTIONS } from "@support-automation/shared";
import { Alert, Button, Field, Input, useToast } from "@/components/ui";
import {
  addCustomerDomain,
  checkCustomerDomain,
  disableCustomerDomain,
  enableCustomerDomain,
  removeCustomerDomain,
  type DomainActionResult,
} from "@/server/actions/saas";
import type { DomainView } from "@/server/saasAdmin";
import { DomainStatusBadge } from "./DomainStatusBadge";

const STEP_LABEL: Record<string, string> = {
  FORMAT: "Address",
  DNS: "DNS",
  REACHES_APP: "Reaches this server",
  HTTPS: "HTTPS",
};

async function noCustomer(): Promise<DomainActionResult> {
  return { error: "Open a customer to add an address." };
}

/**
 * A customer's addresses: the DNS record to create, the last check step by step, and the actions.
 * Every button is a Server Action that checks the Main Admin permission itself.
 */
export function DomainManager({
  customerId,
  domains,
  canManage,
  rootDomain,
  showCustomer = false,
}: {
  customerId?: string;
  domains: DomainView[];
  canManage: boolean;
  rootDomain: string | null;
  showCustomer?: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const addAction = customerId ? addCustomerDomain.bind(null, customerId) : noCustomer;
  const [addState, formAction, adding] = useActionState<DomainActionResult, FormData>(addAction, {});

  useEffect(() => {
    if (addState.success) {
      showToast({ tone: "success", title: "Address added", description: addState.success });
      router.refresh();
    }
  }, [addState, showToast, router]);

  const run = (key: string, action: () => Promise<DomainActionResult>) => {
    setBusy(key);
    startTransition(async () => {
      const result = await action();
      setBusy(null);
      if (result.error) showToast({ tone: "danger", title: "Not done", description: result.error });
      else showToast({ tone: "success", title: "Done", description: result.success ?? "" });
      router.refresh();
    });
  };

  const placeholder = rootDomain ? `customer2.${rootDomain}` : "customer2.example.com";

  return (
    <div className="space-y-4">
      {domains.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">No address yet.</p>
      ) : (
        domains.map((d) => (
          <div key={d.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="break-all font-mono text-sm font-medium hover:underline">
                    {d.hostname}
                  </a>
                  <DomainStatusBadge status={d.status} />
                  {d.isAdminHostname ? <span className="text-xs text-[color:var(--color-muted-foreground)]">also the admin address</span> : null}
                </div>
                {showCustomer ? <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{d.customerName}</p> : null}
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{DOMAIN_STATUS_DESCRIPTIONS[d.status]}</p>
              </div>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {d.status !== "DISABLED" ? (
                    <Button size="sm" variant="secondary" loading={busy === `check:${d.id}`} onClick={() => run(`check:${d.id}`, () => checkCustomerDomain(d.id))}>
                      <RefreshCw className="size-3.5" aria-hidden />
                      Check now
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busy === `enable:${d.id}`} onClick={() => run(`enable:${d.id}`, () => enableCustomerDomain(d.id))}>
                      Enable
                    </Button>
                  )}
                  {d.status !== "DISABLED" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `disable:${d.id}`}
                      onClick={() => {
                        if (window.confirm(`Disable ${d.hostname}? It stops opening this customer's workspace immediately.`)) {
                          run(`disable:${d.id}`, () => disableCustomerDomain(d.id));
                        }
                      }}
                    >
                      Disable
                    </Button>
                  ) : null}
                  {d.status === "PENDING" || d.status === "DISABLED" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `remove:${d.id}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${d.hostname} from this customer?`)) run(`remove:${d.id}`, () => removeCustomerDomain(d.id));
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {d.status !== "ACTIVE" && d.status !== "DISABLED" ? (
              <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-xs">
                <p className="font-medium">DNS record to create at your domain provider</p>
                {d.dnsRecords.length === 0 ? (
                  <p className="mt-1 text-[color:var(--color-muted-foreground)]">Set the server&apos;s public IP under Domains to see the record.</p>
                ) : (
                  <table className="mt-2 font-mono">
                    <thead>
                      <tr className="text-left text-[color:var(--color-muted-foreground)]">
                        <th className="pr-4 font-normal">Type</th>
                        <th className="pr-4 font-normal">Name</th>
                        <th className="font-normal">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.dnsRecords.map((r) => (
                        <tr key={`${r.type}${r.value}`}>
                          <td className="pr-4">{r.type}</td>
                          <td className="pr-4">{r.name}</td>
                          <td>{r.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}

            {d.lastCheck ? (
              <ul className="mt-3 space-y-1.5">
                {d.lastCheck.map((s) => (
                  <li key={s.key} className="flex items-start gap-2 text-xs">
                    {s.ok ? (
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-success)]" aria-label="passed" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-danger)]" aria-label="failed" />
                    )}
                    <span>
                      <span className="font-medium">{STEP_LABEL[s.key] ?? s.key}:</span> {s.detail}
                    </span>
                  </li>
                ))}
                {d.lastCheckedAt ? (
                  <li className="text-[11px] text-[color:var(--color-muted-foreground)]">Checked {new Date(d.lastCheckedAt).toLocaleString()}</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ))
      )}

      {canManage && customerId ? (
        <form action={formAction} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label="Add an address" htmlFor="new-host">
                <Input id="new-host" name="hostname" maxLength={253} autoComplete="off" spellCheck={false} className="font-mono" placeholder={placeholder} />
              </Field>
            </div>
            <Button type="submit" variant="secondary" loading={adding}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
          {addState.error ? <Alert tone="danger">{addState.error}</Alert> : null}
        </form>
      ) : null}
    </div>
  );
}
