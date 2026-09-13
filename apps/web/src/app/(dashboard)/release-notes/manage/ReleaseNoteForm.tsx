"use client";

import { useActionState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionHeader,
  Select,
  Textarea,
} from "@/components/ui";
import { RELEASE_NOTE_MODULE_TAGS, RELEASE_SECTIONS, RELEASE_TYPE_LABEL, RELEASE_TYPES } from "@/lib/releaseNotes";
import type { ReleaseNoteFormState } from "@/server/actions/releaseNotes";

export interface ReleaseNoteFormDefaults {
  version?: string;
  title?: string;
  summary?: string;
  /** `YYYY-MM-DD`, matching what `<input type="date">` reads and writes. */
  releaseDate?: string;
  releaseType?: string;
  whatsNew?: string;
  improvements?: string;
  bugFixes?: string;
  security?: string;
  breakingChanges?: string;
  knownIssues?: string;
  technicalNotes?: string;
  affectedModules?: string[];
}

/**
 * The one Release Notes editor, shared by Create and Edit — same shape as `RuleForm.tsx`: a
 * `useActionState`-bound form, `action` supplied by the page (`createReleaseNoteDraft`, or
 * `updateReleaseNote.bind(null, id)`), no client-side field validation beyond what the browser's
 * own `required` gives for free — every real check happens server-side in the action.
 *
 * Seven plain `Textarea`s, one bullet per line — not a rich-text/markdown editor. This app has
 * none anywhere (audited before building this), and inventing one for a form seven fields deep
 * would be exactly the "giant editor" Phase 11 says to avoid.
 */
export function ReleaseNoteForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prevState: ReleaseNoteFormState, formData: FormData) => Promise<ReleaseNoteFormState>;
  defaults?: ReleaseNoteFormDefaults;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const selectedModules = new Set(defaults.affectedModules ?? []);

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Card>
        <SectionHeader title="Basics" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version" htmlFor="version" required hint='Just the number, e.g. "1.8.0" — shown everywhere as "v1.8.0".'>
            <Input id="version" name="version" defaultValue={defaults.version} maxLength={40} required autoFocus />
          </Field>
          <Field label="Release date" htmlFor="releaseDate" required>
            <Input id="releaseDate" name="releaseDate" type="date" defaultValue={defaults.releaseDate} required />
          </Field>
        </div>
        <Field label="Title" htmlFor="title" required className="mt-4">
          <Input id="title" name="title" defaultValue={defaults.title} maxLength={200} required />
        </Field>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Release type" htmlFor="releaseType">
            <Select id="releaseType" name="releaseType" defaultValue={defaults.releaseType ?? "FEATURE"}>
              {RELEASE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {RELEASE_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Summary" htmlFor="summary" hint="Optional — a sentence or two shown above the sections." className="mt-4">
          <Textarea id="summary" name="summary" defaultValue={defaults.summary} rows={2} maxLength={500} />
        </Field>
      </Card>

      <Card>
        <SectionHeader title="What changed" description="One line per bullet. Leave any section empty if it doesn't apply." />
        <div className="space-y-4">
          {RELEASE_SECTIONS.map(({ key, label }) => (
            <Field key={key} label={label} htmlFor={key}>
              <Textarea
                id={key}
                name={key}
                defaultValue={defaults[key as keyof ReleaseNoteFormDefaults] as string | undefined}
                rows={3}
                placeholder="One change per line…"
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Affected modules" description="Tag which parts of the product this release touched." />
        <div className="flex flex-wrap gap-x-4 gap-y-2.5">
          {RELEASE_NOTE_MODULE_TAGS.map((tag) => (
            <label key={tag} className="flex items-center gap-1.5 text-sm text-[color:var(--color-foreground)]">
              <Checkbox name="affectedModules" value={tag} defaultChecked={selectedModules.has(tag)} />
              {tag}
            </label>
          ))}
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
