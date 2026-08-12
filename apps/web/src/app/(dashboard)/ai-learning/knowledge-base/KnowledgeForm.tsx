"use client";

import { useActionState } from "react";
import { Button, Card, Field, Input, SectionHeader, Select, Textarea } from "@/components/ui";
import type { KnowledgeFormState } from "@/server/actions/aiKnowledge";

const CATEGORIES = [
  "SOFTWARE",
  "WORKFLOW",
  "FAQ",
  "TROUBLESHOOTING",
  "CUSTOMER_RESPONSE",
  "SOP",
  "REQUIREMENT",
  "FEATURE",
  "POLICY",
  "ANNOUNCEMENT",
  "SCREENSHOT",
];

export interface KnowledgeFormDefaults {
  title?: string;
  category?: string;
  question?: string;
  answer?: string;
  procedure?: string;
  software?: string;
  module?: string;
  softwareVersion?: string;
}

export function KnowledgeForm({
  action,
  defaults = {},
  submitLabel = "Save",
  isEdit = false,
}: {
  action: (prevState: KnowledgeFormState, formData: FormData) => Promise<KnowledgeFormState>;
  defaults?: KnowledgeFormDefaults;
  submitLabel?: string;
  isEdit?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Knowledge" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Title" required>
            <Input name="title" defaultValue={defaults.title} required />
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue={defaults.category ?? "FAQ"}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Software" hint="Optional.">
            <Input name="software" defaultValue={defaults.software} />
          </Field>
          <Field label="Module" hint="Optional.">
            <Input name="module" defaultValue={defaults.module} />
          </Field>
          <Field label="Software Version" hint="Optional.">
            <Input name="softwareVersion" defaultValue={defaults.softwareVersion} />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Question / Intent" hint="Optional — the customer question this answers.">
            <Input name="question" defaultValue={defaults.question} />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Answer" required>
            <Textarea name="answer" defaultValue={defaults.answer} rows={4} required />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Procedure" hint="Optional — step-by-step, if this is a workflow/SOP.">
            <Textarea name="procedure" defaultValue={defaults.procedure} rows={4} />
          </Field>
        </div>
        {isEdit ? (
          <div className="mt-4">
            <Field label="Change summary" hint="Shown in this item's version history.">
              <Input name="changeSummary" placeholder="e.g. Updated for v3.2 package-change workflow" />
            </Field>
          </div>
        ) : null}
      </Card>

      {state.error ? <p className="text-sm text-[color:var(--color-danger)]">{state.error}</p> : null}

      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
