"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { LEAD_SOURCE_LABELS, LEAD_SOURCES } from "@support-automation/shared";
import { Alert, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { saveLead, type LeadInput } from "@/server/actions/sales";

const EMPTY: LeadInput = { name: "", phone: "", email: "", company: "", source: "WHATSAPP", currency: "BDT", value: "", nextFollowUpAt: "", notes: "", clientId: "" };

/** Add or edit a lead: who, where they came from, what they might be worth and when to follow up. */
export function LeadForm({ leadId, defaults, clients }: { leadId?: string; defaults?: LeadInput; clients: Array<{ id: string; name: string; code: string }> }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [form, setForm] = useState<LeadInput>(defaults ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (k: keyof LeadInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await saveLead(leadId ?? null, form);
          if (r.error) {
            setError(r.error);
            return;
          }
          showToast({ tone: "success", title: r.success ?? "Saved" });
          if (!leadId && r.id) router.push(`/sales/${r.id}`);
          else router.refresh();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={160} required />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={200} />
        </Field>
        <Field label="Company">
          <Input value={form.company} onChange={(e) => set("company", e.target.value)} maxLength={200} />
        </Field>
        <Field label="Came from">
          <Select value={form.source} onChange={(e) => set("source", e.target.value)}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Next follow-up">
          <Input type="datetime-local" value={form.nextFollowUpAt} onChange={(e) => set("nextFollowUpAt", e.target.value)} />
        </Field>
        <Field label="Possible value" hint="Optional.">
          <Input value={form.value} onChange={(e) => set("value", e.target.value)} inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Currency">
          <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} />
        </Field>
        {clients.length ? (
          <Field label="Client record">
            <Select value={form.clientId} onChange={(e) => set("clientId", e.target.value)}>
              <option value="">None</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <Field label="Notes">
        <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} maxLength={4000} />
      </Field>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={pending}>
        {leadId ? "Save lead" : "Add lead"}
      </Button>
    </form>
  );
}
