"use client";

import { Button, Card, Field, Input, SectionHeader, Select, Textarea } from "@/components/ui";

export interface TeamsResolutionRuleFormOption {
  id: string;
  label: string;
}

export interface TeamsResolutionRuleFormDefaults {
  name?: string;
  description?: string;
  keywordIds?: string[];
}

export function TeamsResolutionRuleForm({
  action,
  defaults = {},
  submitLabel = "Save",
  keywordOptions,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaults?: TeamsResolutionRuleFormDefaults;
  submitLabel?: string;
  keywordOptions: TeamsResolutionRuleFormOption[];
}) {
  return (
    <form action={action} className="space-y-4">
      <Card>
        <SectionHeader title="Basics" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input name="name" defaultValue={defaults.name} required />
          </Field>
          <Field label="Description">
            <Textarea name="description" defaultValue={defaults.description} rows={1} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Keywords" description="Any one matching keyword in a developer's Teams message makes this rule fire." />
        {keywordOptions.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No resolution keywords yet — add one on the Resolution Keywords page first.
          </p>
        ) : (
          <Select name="keywordIds" multiple defaultValue={defaults.keywordIds} className="h-32 py-2" size={6}>
            {keywordOptions.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        )}
      </Card>

      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
