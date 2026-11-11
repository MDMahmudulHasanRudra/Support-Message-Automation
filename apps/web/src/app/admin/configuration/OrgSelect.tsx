"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Select } from "@/components/ui";
import { quickAddDepartment, quickAddJobTitle } from "@/server/actions/configuration";

export interface OrgOption {
  id: string;
  name: string;
  isActive: boolean;
}

const NOUN = { department: "department", jobTitle: "job title" } as const;
const EXAMPLES = { department: "e.g. Support, Sales, Accounts", jobTitle: "e.g. Support Agent, Team Lead, Manager" } as const;

/**
 * A department or job title picker with "+ New" beside it, so an employee can be filed without leaving the form.
 * With none yet, the list says so and the button leads. Inactive ones stay offered only when already chosen.
 */
export function OrgSelect({
  kind,
  name,
  label,
  options: initial,
  defaultValue,
  required,
  canCreate,
}: {
  kind: "department" | "jobTitle";
  name: string;
  label: string;
  options: OrgOption[];
  defaultValue?: string | null;
  required: boolean;
  canCreate: boolean;
}) {
  const [options, setOptions] = useState(initial);
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = options.filter((o) => o.isActive || o.id === value);
  const noun = NOUN[kind];
  const none = shown.length === 0;

  const add = () =>
    start(async () => {
      const result = await (kind === "department" ? quickAddDepartment(newName) : quickAddJobTitle(newName));
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOptions((list) => [...list, { id: result.id, name: result.name, isActive: true }].sort((a, b) => a.name.localeCompare(b.name)));
      setValue(result.id);
      setOpen(false);
      setNewName("");
      setError(null);
    });

  return (
    <Field label={label} required={required} hint={none ? `No ${noun}s yet. Add the first one with + New.` : undefined}>
      <div className="flex gap-2">
        <Select name={name} value={value} onChange={(e) => setValue(e.target.value)} required={required} className="min-w-0 flex-1">
          <option value="">{none ? `Add a ${noun} first` : required ? `Choose a ${noun}` : "None"}</option>
          {shown.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.isActive ? "" : " (inactive)"}
            </option>
          ))}
        </Select>
        {canCreate ? (
          <Button type="button" variant={none ? "primary" : "secondary"} onClick={() => setOpen(true)} aria-label={`Add a new ${noun}`}>
            <Plus className="size-4" aria-hidden />
            New
          </Button>
        ) : null}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={`New ${noun}`} description={`It is added to Organization and chosen here. ${kind === "jobTitle" ? "A job title is a name only; it grants nothing." : ""}`}>
        <div className="space-y-4">
          <Field label="Name" required>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={EXAMPLES[kind]}
              maxLength={100}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newName.trim()) add();
                }
              }}
            />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={add} loading={pending} disabled={!newName.trim()}>
              Add {noun}
            </Button>
          </div>
        </div>
      </Dialog>
    </Field>
  );
}
