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

/**
 * Name, slug, description, status. The slug follows the name until somebody edits it by hand.
 * The same validators run here and in the action — this copy is a convenience; the action's is the
 * one that counts.
 */
export function CreateProjectForm() {
  const [state, formAction, pending] = useActionState<ProjectFormState, FormData>(createProject, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [status, setStatus] = useState<"SETUP" | "ACTIVE">("SETUP");

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
          placeholder="e.g. Bizify"
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
          placeholder="e.g. bizify"
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
