"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { PROJECT_NAME_MAX, PROJECT_SLUG_MAX, suggestProjectSlug } from "@support-automation/shared";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { createCustomer, type CustomerFormState } from "@/server/actions/saas";

export function NewCustomerForm({
  projects,
  defaultProjectName,
  rootDomain,
}: {
  projects: Array<{ id: string; name: string; slug: string }>;
  defaultProjectName: string;
  rootDomain: string | null;
}) {
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(createCustomer, {});
  const [mode, setMode] = useState<"new" | "existing">(projects.length > 0 ? "existing" : "new");
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const shownSlug = slugEdited ? slug : suggestProjectSlug(projectName);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-5">
      <Field label="Customer name" htmlFor="c-name" required error={errors.name}>
        <Input id="c-name" name="name" maxLength={120} required autoComplete="off" placeholder="e.g. Nexora Customer 2" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact person" htmlFor="c-contact">
          <Input id="c-contact" name="contactName" maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Contact email" htmlFor="c-email" error={errors.contactEmail}>
          <Input id="c-email" name="contactEmail" type="email" maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Contact phone" htmlFor="c-phone">
          <Input id="c-phone" name="contactPhone" maxLength={40} autoComplete="off" />
        </Field>
      </div>

      <Field label="Workspace" htmlFor="c-mode" hint="One workspace (project) per customer.">
        <Select id="c-mode" name="projectMode" value={mode} onChange={(e) => setMode(e.target.value === "existing" ? "existing" : "new")}>
          <option value="new">Create a new workspace</option>
          <option value="existing" disabled={projects.length === 0}>
            Use an existing project{projects.length === 0 ? " (none available)" : ""}
          </option>
        </Select>
      </Field>

      {mode === "existing" ? (
        <Field
          label="Existing project"
          htmlFor="c-project"
          required
          error={errors.projectId}
          hint="Its data, WhatsApp numbers, people and addresses stay exactly as they are. Only the link to this customer is added."
        >
          <Select id="c-project" name="projectId" defaultValue={projects[0]?.id}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (/p/{p.slug})
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name" htmlFor="c-pname" required error={errors.projectName}>
            <Input id="c-pname" name="projectName" value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={PROJECT_NAME_MAX} />
          </Field>
          <Field label="Workspace address" htmlFor="c-pslug" required error={errors.projectSlug} hint="Used in links: /p/<address>/">
            <Input
              id="c-pslug"
              name="projectSlug"
              value={shownSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
              maxLength={PROJECT_SLUG_MAX}
              className="font-mono"
              spellCheck={false}
            />
          </Field>
        </div>
      )}

      <Field
        label="Customer address (optional)"
        htmlFor="c-host"
        error={errors.hostname}
        hint={rootDomain ? `For example customer2.${rootDomain}. You can add or change it later.` : "Set the root domain under Domains first, or add the address later."}
      >
        <Input id="c-host" name="hostname" maxLength={253} autoComplete="off" spellCheck={false} className="font-mono" placeholder={rootDomain ? `customer2.${rootDomain}` : "customer2.example.com"} />
      </Field>

      <Field label="Notes" htmlFor="c-notes" hint="Only Main Admins see these.">
        <Textarea id="c-notes" name="notes" rows={2} maxLength={2000} />
      </Field>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          <Plus className="size-4" aria-hidden />
          Add customer
        </Button>
      </div>
    </form>
  );
}
