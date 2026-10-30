"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { deleteSocialTemplateAction, saveSocialTemplateAction, type SocialActionState } from "@/server/actions/social";

export interface TemplateRow {
  id: string;
  kind: string;
  name: string;
  content: string;
  createdByUsername: string;
}

const KINDS = [
  ["TEMPLATE", "Post template"],
  ["SIGNATURE", "Signature"],
  ["HASHTAGS", "Hashtag set"],
] as const;

export function TemplateForm({ value, onDone }: { value?: TemplateRow; onDone?: () => void }) {
  const router = useProjectRouter();
  const [state, action, pending] = useActionState<SocialActionState, FormData>(saveSocialTemplateAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
      onDone?.();
    }
  }, [state.success, router, onDone]);
  const key = value?.id ?? "new";
  return (
    <form action={action} className="space-y-3">
      {value ? <input type="hidden" name="id" value={value.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" htmlFor={`kind-${key}`}>
          <Select id={`kind-${key}`} name="kind" defaultValue={value?.kind ?? "TEMPLATE"}>
            {KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" htmlFor={`tname-${key}`}>
          <Input id={`tname-${key}`} name="name" defaultValue={value?.name ?? ""} maxLength={120} />
        </Field>
      </div>
      <Field label="Text" htmlFor={`tcontent-${key}`} hint="A hashtag set is a line of #hashtags; a signature is added under a post.">
        <Textarea id={`tcontent-${key}`} name="content" rows={4} defaultValue={value?.content ?? ""} />
      </Field>
      {state.error ? <Alert tone="danger" title={state.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {value ? "Save" : "Add"}
        </Button>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function TemplateList({ templates, canEdit }: { templates: TemplateRow[]; canEdit: boolean }) {
  const router = useProjectRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (templates.length === 0) return <p className="py-8 text-center text-sm text-[color:var(--color-muted-foreground)]">None yet.</p>;
  return (
    <ul className="space-y-3">
      {templates.map((t) => (
        <li key={t.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {editing === t.id ? (
            <TemplateForm value={t} onDone={() => setEditing(null)} />
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {t.name} <span className="text-xs font-normal text-[color:var(--color-muted-foreground)]">· {KINDS.find((k) => k[0] === t.kind)?.[1] ?? t.kind}</span>
                </p>
                {canEdit ? (
                  <div className="flex gap-3 text-sm">
                    <button type="button" className="link" onClick={() => setEditing(t.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-[color:var(--color-danger)]"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(`Delete “${t.name}”?`)) start(async () => {
                          await deleteSocialTemplateAction(t.id);
                          router.refresh();
                        });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{t.content}</p>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
