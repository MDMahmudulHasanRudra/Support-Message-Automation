"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import {
  addClientChannel,
  addClientNote,
  archiveClients,
  removeClientChannel,
  restoreClients,
  deleteClients,
  setClientChannelConsent,
  type ClientFormState,
} from "@/server/actions/clients";
import { CLIENT_CHANNEL_KINDS, CLIENT_CHANNEL_LABELS, CLIENT_CONSENT_LABELS, CLIENT_CONSENT_STATUSES, describeSharedKey, type ClientChannelKindValue } from "@support-automation/shared";

export interface ChannelView {
  id: string;
  kind: string;
  value: string;
  label: string | null;
  isPrimary: boolean;
  consentStatus: string;
  consentChangedAt: string | null;
  consentNote: string | null;
  /** A linked WhatsApp group's name, when this is one. */
  groupName: string | null;
}

const CONSENT_COLOR: Record<string, "gray" | "green" | "red"> = { UNKNOWN: "gray", OPTED_IN: "green", OPTED_OUT: "red" };

/** The channel references, each with its own consent. Consent is recorded for later phases; it sends and blocks nothing today. */
export function ChannelsPanel({ clientId, channels, canEdit, archived, groups }: { clientId: string; channels: ChannelView[]; canEdit: boolean; archived: boolean; groups: Array<{ whatsappGroupId: string; name: string }> }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<ClientFormState, FormData>(addClientChannel.bind(null, clientId), {});
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit && !archived;

  useEffect(() => {
    if (!state.success) return;
    formRef.current?.reset();
    showToast({ tone: "success", title: "Reference added" });
    router.refresh();
  }, [state, router, showToast]);

  function consent(id: string, status: string) {
    setError(null);
    startTransition(async () => {
      const r = await setClientChannelConsent(id, status);
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  }
  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const r = await removeClientChannel(id);
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {channels.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No channel references yet.</p> : null}
      <ul className="divide-y divide-[var(--color-border)]">
        {channels.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {CLIENT_CHANNEL_LABELS[c.kind as ClientChannelKindValue] ?? c.kind}
                {c.isPrimary ? <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">primary</span> : null}
              </div>
              <div className="truncate text-[13px]">
                {c.groupName ?? c.value}
                {c.label ? <span className="text-[color:var(--color-muted-foreground)]"> · {c.label}</span> : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge color={CONSENT_COLOR[c.consentStatus] ?? "gray"}>{CLIENT_CONSENT_LABELS[c.consentStatus as keyof typeof CLIENT_CONSENT_LABELS] ?? c.consentStatus}</Badge>
              {editable ? (
                <>
                  <Select value={c.consentStatus} disabled={busy} onChange={(e) => consent(c.id, e.target.value)} className="h-8 sm:w-36 text-xs" aria-label={`Consent for ${c.value}`}>
                    {CLIENT_CONSENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {CLIENT_CONSENT_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(c.id)}>
                    Remove
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {editable ? (
        <form ref={formRef} action={formAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <p className="text-sm font-medium">Add a reference</p>
          {state.error ? (
            <Alert tone={state.duplicates?.length ? "warning" : "danger"}>
              {state.error}
              {state.duplicates?.length ? (
                <ul className="mt-2 space-y-1">
                  {state.duplicates.map((d) => (
                    <li key={d.clientId}>
                      <Link className="link font-medium" href={`/clients/${d.clientId}`}>
                        {d.name} ({d.code})
                      </Link>{" "}
                      — {d.sharedKeys.map(describeSharedKey).join(", ")}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="Kind">
              <Select name="kind" defaultValue={state.values?.kind ?? "PHONE"}>
                {CLIENT_CHANNEL_KINDS.filter((k) => k !== "WHATSAPP_GROUP").map((k) => (
                  <option key={k} value={k}>
                    {CLIENT_CHANNEL_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" className="sm:col-span-2">
              <Input name="value" required placeholder="Number, email, handle or id" defaultValue={state.values?.value ?? ""} />
            </Field>
            <Field label="Label">
              <Input name="label" placeholder="e.g. Office" maxLength={60} defaultValue={state.values?.label ?? ""} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isPrimary" defaultChecked={state.values?.isPrimary === "on"} /> Primary for this kind
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={pending}>
              Add reference
            </Button>
            {state.duplicates?.length ? (
              <Button type="submit" size="sm" variant="secondary" name="confirmDuplicate" value="1" loading={pending}>
                Add anyway
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {editable && groups.length > 0 ? (
        <form action={formAction} className="flex flex-wrap items-end gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <input type="hidden" name="kind" value="WHATSAPP_GROUP" />
          <Field label="Link a WhatsApp group" className="min-w-64 flex-1">
            <Select name="value" defaultValue="">
              <option value="" disabled>
                Choose a group…
              </option>
              {groups.map((g) => (
                <option key={g.whatsappGroupId} value={g.whatsappGroupId}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            Link group
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function NotesPanel({ clientId, notes, canEdit }: { clientId: string; notes: Array<{ id: string; body: string; author: string | null; at: string }>; canEdit: boolean }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ClientFormState, FormData>(addClientNote.bind(null, clientId), {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.success) return;
    formRef.current?.reset();
    router.refresh();
  }, [state, router]);
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Internal. Notes are never sent to the client and are not shown in the timeline.</p>
      {canEdit ? (
        <form ref={formRef} action={formAction} className="space-y-2">
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          <Textarea name="body" rows={3} maxLength={4000} placeholder="Write a note…" required />
          <Button type="submit" size="sm" loading={pending}>
            Add note
          </Button>
        </form>
      ) : null}
      {notes.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No notes yet.</p> : null}
      <ul className="space-y-3">
        {notes.map((n) => (
          <li key={n.id} className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3.5 py-2.5">
            <p className="whitespace-pre-wrap text-sm">{n.body}</p>
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {n.author ?? "Someone"} · {n.at}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Archive / restore / permanent delete for ONE client, each confirmed. */
export function ClientLifecycle({ clientId, archived, canArchive, canDelete }: { clientId: string; archived: boolean; canArchive: boolean; canDelete: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<"archive" | "restore" | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  if (!canArchive && !canDelete) return null;
  const run = () =>
    startTransition(async () => {
      const r = open === "archive" ? await archiveClients([clientId]) : open === "restore" ? await restoreClients([clientId]) : await deleteClients([clientId]);
      setOpen(null);
      if (open === "delete" && r.ok) {
        router.push("/clients");
        return;
      }
      setMessage(r.message);
      router.refresh();
    });
  return (
    <div className="space-y-2">
      {message ? <Alert tone="info">{message}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {canArchive && !archived ? (
          <Button variant="secondary" size="sm" onClick={() => setOpen("archive")}>
            Archive
          </Button>
        ) : null}
        {canArchive && archived ? (
          <Button variant="secondary" size="sm" onClick={() => setOpen("restore")}>
            Restore
          </Button>
        ) : null}
        {canDelete && archived ? (
          <Button variant="danger" size="sm" onClick={() => setOpen("delete")}>
            Delete permanently
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        onConfirm={run}
        loading={busy}
        tone={open === "delete" ? "danger" : "primary"}
        title={open === "archive" ? "Archive this client?" : open === "restore" ? "Restore this client?" : "Permanently delete this client?"}
        description={
          open === "delete"
            ? "The client, its channels, notes, timeline and billing records are deleted. This cannot be undone."
            : open === "archive"
              ? "It is hidden from the default list. Everything is kept and you can restore it."
              : "It returns with the status it had when it was archived."
        }
        confirmLabel={open === "delete" ? "Delete permanently" : open === "archive" ? "Archive" : "Restore"}
      />
    </div>
  );
}
