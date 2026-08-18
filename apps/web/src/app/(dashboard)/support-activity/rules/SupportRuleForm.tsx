"use client";

import { useState } from "react";
import { Button, Card, Checkbox, Field, Input, SectionHeader, Select, Textarea } from "@/components/ui";

export interface SupportRuleFormOption {
  id: string;
  label: string;
}

export interface SupportRuleFormDefaults {
  name?: string;
  description?: string;
  triggerType?: string;
  appliesToAllGroups?: boolean;
  groupIds?: string[];
  appliesToAllTeamMembers?: boolean;
  teamMemberIds?: string[];
  keywordIds?: string[];
}

export function SupportRuleForm({
  action,
  defaults = {},
  submitLabel = "Save",
  groupOptions,
  teamMemberOptions,
  keywordOptions,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaults?: SupportRuleFormDefaults;
  submitLabel?: string;
  groupOptions: SupportRuleFormOption[];
  teamMemberOptions: SupportRuleFormOption[];
  keywordOptions: SupportRuleFormOption[];
}) {
  const [allGroups, setAllGroups] = useState(defaults.appliesToAllGroups ?? true);
  const [allMembers, setAllMembers] = useState(defaults.appliesToAllTeamMembers ?? true);
  const [triggerType, setTriggerType] = useState(defaults.triggerType ?? "KEYWORD_MATCH");

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
        <div className="mt-4 max-w-xs">
          <Field
            label="Trigger Type"
            hint={
              triggerType === "REPLY_TO_CUSTOMER"
                ? "Fires when a support member's message is a WhatsApp reply to a real customer message — no keyword needed."
                : triggerType === "MENTION"
                  ? "Fires when a support member @-mentions a customer in their message — no keyword needed."
                  : "Fires when a support member's message matches one of the selected keywords."
            }
          >
            <Select name="triggerType" value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
              <option value="KEYWORD_MATCH">Keyword Match</option>
              <option value="REPLY_TO_CUSTOMER">Reply to Customer</option>
              <option value="MENTION">Mention</option>
            </Select>
          </Field>
        </div>
      </Card>

      {triggerType === "KEYWORD_MATCH" ? (
        <Card>
          <SectionHeader title="Keywords" description="Any one matching keyword makes this rule fire." />
          {keywordOptions.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              No keywords yet — add one on the Keywords page first.
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
      ) : null}

      <Card>
        <SectionHeader title="Team Member Scope" />
        <label className="mb-3 flex items-center gap-2 text-sm">
          <Checkbox name="appliesToAllTeamMembers" checked={allMembers} onChange={(e) => setAllMembers(e.target.checked)} />
          All support team members
        </label>
        {!allMembers ? (
          <Select name="teamMemberIds" multiple defaultValue={defaults.teamMemberIds} className="h-32 py-2" size={6}>
            {teamMemberOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        ) : null}
      </Card>

      <Card>
        <SectionHeader title="Group Scope" />
        <label className="mb-3 flex items-center gap-2 text-sm">
          <Checkbox name="appliesToAllGroups" checked={allGroups} onChange={(e) => setAllGroups(e.target.checked)} />
          All groups
        </label>
        {!allGroups ? (
          <Select name="groupIds" multiple defaultValue={defaults.groupIds} className="h-32 py-2" size={6}>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </Select>
        ) : null}
      </Card>

      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
