"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import {
  PROJECT_NAME_MAX,
  PROJECT_SLUG_MAX,
  PROJECT_STATUS_DESCRIPTIONS,
  suggestProjectSlug,
  validateProjectName,
  validateProjectSlug,
} from "@support-automation/shared";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { createProject, type ProjectFormState } from "@/server/actions/projects";
import { ClientCodeFields, type ClientCodeContext } from "./ClientCodeFields";
import { useBranding } from "@/components/BrandingProvider";

/**
 * Name, slug, description, status. The slug follows the name until somebody edits it by hand.
 * The same validators run here and in the action — this copy is a convenience; the action's is the
 * one that counts.
 */
export interface ModuleSetupOption {
  key: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  moduleCount: number;
}

export function CreateProjectForm({
  defaultName = "",
  templates = [],
  planName = null,
  codeContext,
}: {
  defaultName?: string;
  templates?: ModuleSetupOption[];
  planName?: string | null;
  codeContext: ClientCodeContext;
}) {
  const [state, formAction, pending] = useActionState<ProjectFormState, FormData>(createProject, {});
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [status, setStatus] = useState<"SETUP" | "ACTIVE">("SETUP");
  const [setup, setSetup] = useState("PLAN");
  const chosen = templates.find((t) => t.key === setup);
  // The placeholder follows the product name (BRANDING.md), never a hard-coded one.
  const exampleName = `${useBranding().productName} Project 2`;

  const shownSlug = slugEdited ? slug : suggestProjectSlug(name);
  const nameError = state.fieldErrors?.name ?? (name ? validateProjectName(name.trim()) : null);
  const slugError = state.fieldErrors?.slug ?? (shownSlug ? validateProjectSlug(shownSlug) : null);

  return (
    <form action={formAction} className="space-y-5">
      <Field label="Project name" htmlFor="project-name" required error={nameError ?? undefined}>
        <Input
          id="project-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={`e.g. ${exampleName}`}
          maxLength={PROJECT_NAME_MAX}
          required
          autoComplete="off"
        />
      </Field>

      <Field
        label="Slug"
        htmlFor="project-slug"
        required
        error={slugError ?? undefined}
        hint={`The project's address: /p/${shownSlug || "your-slug"}/. Lower-case letters, digits and hyphens. It cannot be changed from here later, so bookmarks keep working.`}
      >
        <Input
          id="project-slug"
          name="slug"
          value={shownSlug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value);
          }}
          placeholder={`e.g. ${suggestProjectSlug(exampleName) || "project-2"}`}
          maxLength={PROJECT_SLUG_MAX}
          required
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </Field>

      <Field label="Description" htmlFor="project-description" hint="Optional. Shown to Main Admins only.">
        <Textarea id="project-description" name="description" rows={2} maxLength={500} />
      </Field>

      <Field label="Status" htmlFor="project-status" hint={PROJECT_STATUS_DESCRIPTIONS[status]}>
        <Select
          id="project-status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value === "ACTIVE" ? "ACTIVE" : "SETUP")}
        >
          <option value="SETUP">Setting up</option>
          <option value="ACTIVE">Active</option>
        </Select>
      </Field>

      <Field
        label="Business type and modules"
        htmlFor="project-setup"
        hint={
          setup === "PLAN"
            ? `The modules of the customer's plan${planName ? ` (${planName})` : ""}, exactly as before.`
            : setup === "CUSTOM"
              ? "Starts with the plan's modules and opens the Module Builder next, to choose each one."
              : `${chosen?.description ?? ""} ${chosen ? `${chosen.moduleCount} modules; anything the plan does not include is left out and noted.` : ""}`.trim()
        }
      >
        <Select id="project-setup" name="moduleSetup" value={setup} onChange={(event) => setSetup(event.target.value)}>
          <option value="PLAN">The plan&apos;s modules</option>
          <optgroup label="Business types and templates">
            {templates
              .filter((t) => t.builtIn)
              .map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
          </optgroup>
          {templates.some((t) => !t.builtIn) ? (
            <optgroup label="Your templates">
              {templates
                .filter((t) => !t.builtIn)
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
          ) : null}
          <option value="CUSTOM">Custom Mix — choose modules next</option>
        </Select>
      </Field>

      <ClientCodeFields context={codeContext} name={name} slug={shownSlug} errors={state.fieldErrors} />

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={Boolean(validateProjectName(name.trim()) || validateProjectSlug(shownSlug))}>
          <Plus className="size-4" aria-hidden />
          Create project
        </Button>
      </div>
    </form>
  );
}
