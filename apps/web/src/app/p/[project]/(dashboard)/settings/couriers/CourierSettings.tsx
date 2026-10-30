"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { COURIER_CREDENTIAL_FIELDS, COURIER_LABELS, COURIER_PROVIDERS, type CourierProvider } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, SectionHeader, useToast } from "@/components/ui";
import { removeCourierConnection, saveCourierConnection, testCourierConnection } from "@/server/actions/couriers";

export interface CourierConnectionRow {
  id: string;
  provider: CourierProvider;
  label: string;
  sandbox: boolean;
  isActive: boolean;
  settings: { storeId?: string; weight?: string; pickupStoreId?: string };
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
}

const HELP: Record<CourierProvider, string> = {
  STEADFAST: "Steadfast merchant panel → API: copy the API key and secret key.",
  PATHAO: "Pathao merchant panel → Developers API: client id and secret, plus your merchant login. Then set the store parcels are picked up from.",
  REDX: "RedX merchant panel → API: generate an access token.",
};

function ProviderCard({ provider, row, canManage }: { provider: CourierProvider; row: CourierConnectionRow | undefined; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [form, setForm] = useState({
    label: row?.label ?? COURIER_LABELS[provider],
    sandbox: row?.sandbox ?? false,
    isActive: row?.isActive ?? true,
    storeId: row?.settings.storeId ?? "",
    weight: row?.settings.weight ?? "",
    pickupStoreId: row?.settings.pickupStoreId ?? "",
    credentials: {} as Record<string, string>,
  });

  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else {
        setNotice(r.success ?? null);
        showToast({ tone: "success", title: r.success ?? "Done" });
        after?.();
      }
      router.refresh();
    });
  };

  return (
    <Card>
      <SectionHeader
        title={COURIER_LABELS[provider]}
        description={HELP[provider]}
        action={
          row ? (
            <Badge color={!row.isActive ? "gray" : row.lastCheckOk === true ? "green" : row.lastCheckOk === false ? "red" : "yellow"} dot>
              {!row.isActive ? "Off" : row.lastCheckOk === true ? "Working" : row.lastCheckOk === false ? "Failing" : "Not tested"}
            </Badge>
          ) : (
            <Badge color="gray">Not connected</Badge>
          )
        }
      />
      {row?.lastError ? <p className="mb-3 text-xs text-[color:var(--color-danger)]">{row.lastError}</p> : null}
      {canManage ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveCourierConnection({ provider, ...form }), () => setForm((f) => ({ ...f, credentials: {} })));
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COURIER_CREDENTIAL_FIELDS[provider].map((f) => (
              <Field key={f.key} label={f.label} hint={row ? "Leave empty to keep the saved value." : undefined}>
                <Input
                  type={/secret|password|token|key/i.test(f.key) ? "password" : "text"}
                  autoComplete="off"
                  value={form.credentials[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, credentials: { ...form.credentials, [f.key]: e.target.value } })}
                />
              </Field>
            ))}
            {provider === "PATHAO" ? (
              <>
                <Field label="Store id" hint="Test the connection to see your stores.">
                  <Input value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })} inputMode="numeric" />
                </Field>
                <Field label="Default weight (kg)" hint="0.5 to 10.">
                  <Input value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} inputMode="decimal" placeholder="0.5" />
                </Field>
              </>
            ) : null}
            {provider === "REDX" ? (
              <>
                <Field label="Pickup store id" hint="Optional.">
                  <Input value={form.pickupStoreId} onChange={(e) => setForm({ ...form, pickupStoreId: e.target.value })} inputMode="numeric" />
                </Field>
                <Field label="Default parcel weight (grams)">
                  <Input value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} inputMode="numeric" placeholder="500" />
                </Field>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Use this courier
            </label>
            {provider !== "STEADFAST" ? (
              <label className="flex items-center gap-2">
                <Checkbox checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} /> Sandbox (test bookings, nothing is picked up)
              </label>
            ) : null}
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={pending}>
              {row ? "Save" : "Connect"}
            </Button>
            {row ? (
              <Button type="button" variant="secondary" loading={pending} onClick={() => run(() => testCourierConnection(row.id))}>
                Test connection
              </Button>
            ) : null}
            {row ? (
              <Button type="button" variant="ghost" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {row ? (
        <ConfirmDialog
          open={removing}
          onClose={() => setRemoving(false)}
          tone="danger"
          loading={pending}
          title={`Remove ${COURIER_LABELS[provider]}?`}
          description="The saved credentials are deleted. Shipments already booked are kept with their courier ids, but their status stops refreshing."
          confirmLabel="Remove"
          onConfirm={() => run(() => removeCourierConnection(row.id), () => setRemoving(false))}
        />
      ) : null}
    </Card>
  );
}

export function CourierSettings({ rows, canManage }: { rows: CourierConnectionRow[]; canManage: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      {COURIER_PROVIDERS.map((p) => (
        <ProviderCard key={p} provider={p} row={rows.find((r) => r.provider === p)} canManage={canManage} />
      ))}
    </div>
  );
}
