"use client";

import { useRouter } from "next/navigation";
import { startTransition as startActionTransition, useActionState, useEffect, useState, useTransition, type FormEvent } from "react";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, useToast } from "@/components/ui";
import type { ConfigFormState } from "@/server/actions/configuration";

/**
 * Departments and Job Titles share one shape: a named list, added and edited in place, deactivated
 * rather than deleted once somebody uses an entry. This renders either; the page hands it that
 * list's own actions, so nothing here knows which one it is showing.
 */

export interface NameRow {
  id: string;
  name: string;
  code?: string | null;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

export function NameList({
  noun,
  rows,
  canManage,
  withCode,
  save,
  toggle,
  remove,
}: {
  /** "department" / "job title" — used in labels and messages. */
  noun: string;
  rows: NameRow[];
  canManage: boolean;
  withCode?: boolean;
  save: (prev: ConfigFormState, form: FormData) => Promise<ConfigFormState>;
  toggle: (id: string, isActive: boolean) => Promise<ConfigFormState>;
  remove: (id: string) => Promise<ConfigFormState>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NameRow | null>(null);
  const [pending, startTransition] = useTransition();
  /** The row whose Deactivate / Reactivate / Delete is in flight, so its button shows it. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const router = useRouter();
  const { showToast } = useToast();

  function run(id: string, action: () => Promise<ConfigFormState>) {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      setBusyId(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      {canManage ? <NameForm key="new" noun={noun} withCode={withCode} save={save} /> : null}

      {rows.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
          No {noun}s yet.{canManage ? ` Add the first one above.` : ""}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {rows.map((row) =>
            editing === row.id ? (
              <li key={row.id} className="px-4 py-3">
                <NameForm noun={noun} withCode={withCode} save={save} row={row} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-row={row.name}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">
                    {row.name}
                    {row.code ? <span className="ml-2 font-mono text-xs text-[color:var(--color-muted-foreground)]">{row.code}</span> : null}
                  </p>
                  {row.description ? <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{row.description}</p> : null}
                </div>
                <span className="text-xs text-[color:var(--color-muted-foreground)] tabular-nums">
                  {row.employeeCount} employee{row.employeeCount === 1 ? "" : "s"}
                </span>
                {row.isActive ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}
                {canManage ? (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(row.id)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={pending && busyId === row.id}
                      disabled={pending && busyId !== row.id}
                      onClick={() => run(row.id, () => toggle(row.id, !row.isActive))}
                    >
                      {row.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                    {row.employeeCount === 0 ? (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleting(row)}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) run(row.id, () => remove(row.id));
        }}
        title={`Delete ${deleting?.name ?? ""}?`}
        description={`Nobody is filed under this ${noun}, so it can be deleted. This cannot be undone.`}
        confirmLabel="Delete"
        tone="danger"
      />
    </div>
  );
}

function NameForm({
  noun,
  withCode,
  save,
  row,
  onDone,
}: {
  noun: string;
  withCode?: boolean;
  save: (prev: ConfigFormState, form: FormData) => Promise<ConfigFormState>;
  row?: NameRow;
  onDone?: () => void;
}) {
  const [state, action, pending] = useActionState(save, {});
  const [formKey, setFormKey] = useState(0);
  const router = useRouter();

  // Submitted from onSubmit rather than <form action>: React resets an uncontrolled form after an
  // action, which would throw away what was typed whenever the server refuses it. The add form is
  // still cleared on success, by remounting it below.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startActionTransition(() => action(formData));
  }

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
    if (onDone) onDone();
    else queueMicrotask(() => setFormKey((k) => k + 1)); // clear the add form for the next entry
  }, [state, onDone, router]);

  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <div className={`grid gap-3 ${withCode ? "sm:grid-cols-[1fr_8rem]" : ""}`}>
        <Field label={row ? "Name" : `New ${noun}`} required>
          <Input name="name" defaultValue={row?.name} required maxLength={100} placeholder={`Name of the ${noun}`} />
        </Field>
        {withCode ? (
          <Field label="Code" hint="Optional, e.g. SUP">
            <Input name="code" defaultValue={row?.code ?? ""} maxLength={12} />
          </Field>
        ) : null}
      </div>
      <Field label="Description" hint="Optional.">
        <Input name="description" defaultValue={row?.description ?? ""} maxLength={500} />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {row ? "Save" : `Add ${noun}`}
        </Button>
        {onDone ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
