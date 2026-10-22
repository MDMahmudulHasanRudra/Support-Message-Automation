"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, Checkbox, Field, Input, Select, SwitchField, useToast } from "@/components/ui";
import { saveClientModuleSettings } from "@/server/actions/clientExtras";
import type { ClientModuleSettingsValue, ClientSubModule } from "@support-automation/shared";

export function ClientSettingsForm({
  initial,
  canEdit,
  modules,
  fields,
  countries,
}: {
  initial: ClientModuleSettingsValue;
  canEdit: boolean;
  modules: Array<{ key: ClientSubModule; label: string; description: string }>;
  fields: Array<{ key: string; label: string }>;
  countries: Array<{ code: string; name: string }>;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [value, setValue] = useState(initial);
  const [busy, start] = useTransition();
  const toggleField = (key: string) =>
    setValue((v) => ({ ...v, requiredFields: v.requiredFields.includes(key as never) ? v.requiredFields.filter((k) => k !== key) : [...v.requiredFields, key as never] }));

  return (
    <form
      className="space-y-7"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveClientModuleSettings({ ...value, requiredFields: value.requiredFields, defaultCountry: value.defaultCountry ?? "" });
          showToast({ tone: r.ok ? "success" : "danger", title: r.message });
          if (r.ok) router.refresh();
        });
      }}
    >
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Sub-modules</h3>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">Switching one off hides its pages and refuses its actions on the server. Nothing is deleted; switching it back on shows everything again.</p>
        {modules.map((m) => (
          <SwitchField
            key={m.key}
            label={m.label}
            description={m.key === "payments" && !value.billing ? `${m.description} (Billing is off, so this is off too.)` : m.description}
            checked={value[m.key]}
            disabled={!canEdit}
            onChange={(e) => setValue((v) => ({ ...v, [m.key]: e.target.checked }))}
          />
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Required fields when adding or editing a client</h3>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">Everything is optional unless ticked here. Technical rules (a real email, a real date, a valid currency) always apply whether or not a field is required.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.requiredFields.includes(f.key as never)} disabled={!canEdit} onChange={() => toggleField(f.key)} />
              {f.label}
            </label>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Renewal window (days)" hint="A paid term this close to its expiry shows as “Renew soon”. 0–90.">
          <Input type="number" min={0} max={90} value={value.renewalWindowDays} disabled={!canEdit} onChange={(e) => setValue((v) => ({ ...v, renewalWindowDays: Number(e.target.value) }))} />
        </Field>
        <Field label="Default country for local numbers" hint="A number typed without +country code is read as this country's. Leave empty to always require the code.">
          <Select value={value.defaultCountry ?? ""} disabled={!canEdit} onChange={(e) => setValue((v) => ({ ...v, defaultCountry: e.target.value || null }))}>
            <option value="">None — always require the country code</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      {canEdit ? (
        <Button type="submit" loading={busy}>
          Save settings
        </Button>
      ) : null}
    </form>
  );
}
