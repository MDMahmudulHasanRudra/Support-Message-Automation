"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { Archive, MapPin, Merge, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { CONTACT_CONSENT_LABEL, CONTACT_CONSENTS, CONTACT_IDENTIFIER_KINDS, CONTACT_IDENTIFIER_LABEL, CONTACT_SOURCE_LABEL, type ContactConsentValue, type ContactIdentifierKindValue } from "@support-automation/shared";
import { Alert, Button, Card, Dialog, Field, Input, RowMenu, Select, Textarea, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { CopyButton, KIND_ICON, ManualValueRow, PasteValues, usePastedValues, WhatsAppMark } from "@/components/contacts/contactDisplay";
import { addContactValues, deleteContact, linkContactToClient, mergeContacts, removeContactValue, saveContactNotes, searchClientsForContact, searchContacts, setContactArchived, setContactConsent, updateContact } from "@/server/actions/contacts";
import type { ContactProfile } from "@/server/contacts";

const MUTED = "text-[12.5px] text-[color:var(--color-muted-foreground)]";

export function ContactValuesCard({ contact, canEdit }: { contact: ContactProfile; canEdit: boolean }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const paste = usePastedValues();
  const [kind, setKind] = useState<ContactIdentifierKindValue>("FACEBOOK");
  const [typed, setTyped] = useState("");
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const groups = CONTACT_IDENTIFIER_KINDS.flatMap((k) => {
    const items = contact.values.filter((v) => v.kind === k);
    return items.length ? [{ kind: k, items }] : [];
  });

  const add = (values: Array<{ kind: ContactIdentifierKindValue; value: string }>, after: () => void) =>
    start(async () => {
      const r = await addContactValues(contact.id, values);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setHeld(r.heldElsewhere);
      after();
      if (r.added) showToast({ tone: "success", title: r.added === 1 ? "Added" : `${r.added} added` });
      router.refresh();
    });

  const remove = (id: string) =>
    start(async () => {
      const r = await removeContactValue(id);
      if ("error" in r) setError(r.error);
      else router.refresh();
    });

  return (
    <Card className="p-4">
      <h2 className="mb-2.5 text-[14px] font-semibold">Reach them on</h2>
      {groups.length === 0 ? <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No number or address yet.</p> : null}
      <div className="space-y-3">
        {groups.map((g) => {
          const Icon = KIND_ICON[g.kind];
          return (
            <div key={g.kind}>
              <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">
                <Icon className="size-3.5" aria-hidden />
                {CONTACT_IDENTIFIER_LABEL[g.kind]}
              </p>
              <ul>
                {g.items.map((v) => (
                  <li key={v.id} className="group flex items-center gap-2 rounded-[var(--radius-md)] py-0.5">
                    {v.href ? (
                      <a href={v.href} target={v.href.startsWith("https") ? "_blank" : undefined} rel="noopener noreferrer nofollow" className="min-w-0 truncate text-[14px] hover:underline">
                        {v.value}
                      </a>
                    ) : (
                      <span className="min-w-0 truncate text-[14px]">{v.value}</span>
                    )}
                    {v.isWhatsApp ? <WhatsAppMark /> : null}
                    <span className={`shrink-0 ${MUTED}`}>
                      {CONTACT_SOURCE_LABEL[v.source]}
                      {v.collectedByAi ? " · AI" : ""}
                    </span>
                    <span className="flex-1" />
                    <CopyButton value={v.value} label={CONTACT_IDENTIFIER_LABEL[g.kind]} />
                    {canEdit ? (
                      <button type="button" aria-label={`Remove ${v.value}`} disabled={pending} onClick={() => remove(v.id)} className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]">
                        <X className="size-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {canEdit ? (
        <div className="mt-4 space-y-2.5 border-t border-[var(--color-border)] pt-3.5">
          <PasteValues paste={paste} placeholder="Paste numbers, emails or profile links to add" />
          {paste.values.length ? (
            <Button size="sm" disabled={pending} onClick={() => add(paste.values, () => paste.clear())}>
              {paste.values.length === 1 ? "Add it" : `Add ${paste.values.length}`}
            </Button>
          ) : null}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ManualValueRow kind={kind} onKind={setKind} value={typed} onValue={setTyped} />
            </div>
            <Button size="sm" variant="secondary" disabled={pending || !typed.trim()} onClick={() => add([{ kind, value: typed }], () => setTyped(""))}>
              Add
            </Button>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {held.map((h) => (
            <Alert key={h} tone="warning">
              {h}. Use Merge if they are the same person.
            </Alert>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1 text-[13px]">
      <dt className="text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function ContactDetailsCard({ contact, canEdit, clientsAvailable, addedOn, lastContacted }: { contact: ContactProfile; canEdit: boolean; clientsAvailable: boolean; addedOn: string; lastContacted: string | null }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [pending, start] = useTransition();
  const [clientQuery, setClientQuery] = useState("");
  const [clients, setClients] = useState<Array<{ id: string; name: string; code: string }>>([]);
  const place = [contact.address, contact.city, contact.country].filter(Boolean).join(", ");

  return (
    <div className="min-w-0 space-y-4">
      <Card className="p-4">
        <h2 className="mb-1.5 text-[14px] font-semibold">Details</h2>
        <dl>
          {contact.company ? <Row label="Company">{contact.company}</Row> : null}
          {contact.jobTitle ? <Row label="Job title">{contact.jobTitle}</Row> : null}
          {contact.birthday ? <Row label="Birthday">{contact.birthday}</Row> : null}
          {place ? <Row label="Address">{place}</Row> : null}
          {contact.mapHref ? (
            <Row label="Map">
              <a href={contact.mapHref} target="_blank" rel="noopener noreferrer nofollow" className="link inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden />
                Open the location
              </a>
              {contact.latitude !== null ? <span className={`tabular block ${MUTED}`}>{contact.latitude}, {contact.longitude}</span> : null}
            </Row>
          ) : null}
          <Row label="Collected from">
            {CONTACT_SOURCE_LABEL[contact.source]}
            {contact.sourceDetail ? <span className={`block ${MUTED}`}>{contact.sourceDetail}</span> : null}
          </Row>
          <Row label="Added">
            {addedOn}
            {contact.createdByName ? ` by ${contact.createdByName}` : ""}
          </Row>
          <Row label="Last contacted">{lastContacted ?? "Not yet"}</Row>
        </dl>
      </Card>

      <Card className="p-4">
        <Field label="Offers and campaigns">
          <Select
            disabled={!canEdit || pending}
            defaultValue={contact.consent}
            onChange={(e) =>
              start(async () => {
                const r = await setContactConsent(contact.id, e.target.value as ContactConsentValue);
                if ("error" in r) showToast({ tone: "danger", title: r.error });
                else router.refresh();
              })
            }
          >
            {CONTACT_CONSENTS.map((c) => (
              <option key={c} value={c}>
                {CONTACT_CONSENT_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        <p className={`mt-1.5 ${MUTED}`}>Someone marked No offers is left out of every campaign.</p>
      </Card>

      <Card className="p-4">
        <Field label="Notes">
          <Textarea
            value={notes}
            disabled={!canEdit}
            rows={5}
            maxLength={10000}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if (notes === (contact.notes ?? "")) return;
              start(async () => {
                const r = await saveContactNotes(contact.id, notes);
                if ("error" in r) showToast({ tone: "danger", title: r.error });
                else showToast({ tone: "success", title: "Notes saved" });
              });
            }}
          />
        </Field>
      </Card>

      {clientsAvailable ? (
        <Card className="p-4">
          <h2 className="mb-1.5 text-[14px] font-semibold">Client record</h2>
          {contact.client ? (
            <div className="flex items-center justify-between gap-3">
              <Link href={`/clients/${contact.client.id}`} className="link min-w-0 truncate text-[13.5px] font-medium">
                {contact.client.name}
              </Link>
              {canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await linkContactToClient(contact.id, null);
                      if ("error" in r) showToast({ tone: "danger", title: r.error });
                      else router.refresh();
                    })
                  }
                >
                  Remove link
                </Button>
              ) : null}
            </div>
          ) : canEdit ? (
            <>
              <p className={`mb-2 ${MUTED}`}>Optional. A link never changes the client, its dues or its subscriptions.</p>
              <Input
                value={clientQuery}
                placeholder="Search your clients"
                onChange={(e) => {
                  const q = e.target.value;
                  setClientQuery(q);
                  if (q.trim().length < 2) setClients([]);
                  else void searchClientsForContact(q).then(setClients);
                }}
              />
              {clients.length ? (
                <ul className="mt-1.5 divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                  {clients.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const r = await linkContactToClient(contact.id, c.id);
                            if ("error" in r) showToast({ tone: "danger", title: r.error });
                            else router.refresh();
                          })
                        }
                        className="w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--color-neutral-bg)]"
                      >
                        {c.name} <span className="tabular text-[color:var(--color-muted-foreground)]">{c.code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className={MUTED}>Not linked to a client.</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}

export function ContactHeaderActions({ contact, canEdit, canDelete }: { contact: ContactProfile; canEdit: boolean; canDelete: boolean }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [, start] = useTransition();
  const archived = contact.status === "ARCHIVED";

  const run = (work: () => Promise<{ error: string } | object>, after?: () => void) =>
    start(async () => {
      const r = await work();
      if ("error" in r) showToast({ tone: "danger", title: r.error as string });
      else if (after) after();
      else router.refresh();
    });

  return (
    <div className="flex items-center gap-2">
      {canEdit ? (
        <Button variant="secondary" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
      ) : null}
      <RowMenu
        horizontal
        label="More actions"
        items={[
          { label: "Merge into another contact", icon: <Merge className="size-3.5" />, onSelect: () => setMerging(true), hidden: !canEdit },
          { label: "Archive", icon: <Archive className="size-3.5" />, onSelect: () => run(() => setContactArchived(contact.id, true)), hidden: !canEdit || archived },
          { label: "Restore", icon: <RotateCcw className="size-3.5" />, onSelect: () => run(() => setContactArchived(contact.id, false)), hidden: !canEdit || !archived },
          {
            label: "Delete for good",
            icon: <Trash2 className="size-3.5" />,
            danger: true,
            hidden: !canDelete || !archived,
            onSelect: () => {
              if (window.confirm(`Delete ${contact.displayName} for good? Their numbers, links and history go with them. This cannot be undone.`)) run(() => deleteContact(contact.id), () => router.push("/contacts"));
            },
          },
        ]}
      />
      {editing ? <EditContactDialog contact={contact} onClose={() => setEditing(false)} /> : null}
      {merging ? <MergeDialog contact={contact} onClose={() => setMerging(false)} /> : null}
    </div>
  );
}

function EditContactDialog({ contact, onClose }: { contact: ContactProfile; onClose: () => void }) {
  const router = useProjectRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (form: FormData) =>
    start(async () => {
      const r = await updateContact(contact.id, Object.fromEntries(form.entries()));
      if ("error" in r) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} size="lg" title="Edit contact">
      <form action={submit} className="space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input name="name" defaultValue={contact.name ?? ""} maxLength={200} />
          </Field>
          <Field label="Your own code (optional)">
            <Input name="code" defaultValue={contact.code ?? ""} maxLength={40} />
          </Field>
          <Field label="Company">
            <Input name="company" defaultValue={contact.company ?? ""} maxLength={200} />
          </Field>
          <Field label="Job title">
            <Input name="jobTitle" defaultValue={contact.jobTitle ?? ""} maxLength={120} />
          </Field>
          <Field label="Birthday">
            <Input name="birthday" type="date" defaultValue={contact.birthday ?? ""} />
          </Field>
          <Field label="Tags" hint="Separate with commas.">
            <Input name="tags" defaultValue={contact.tags.join(", ")} />
          </Field>
        </div>
        <Field label="Address">
          <Input name="address" defaultValue={contact.address ?? ""} maxLength={500} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="City">
            <Input name="city" defaultValue={contact.city ?? ""} maxLength={120} />
          </Field>
          <Field label="Country">
            <Input name="country" defaultValue={contact.country ?? ""} maxLength={120} />
          </Field>
        </div>
        <Field label="Map link" hint="Copy the location's link from Google Maps. Coordinates in the link are read by themselves.">
          <Input name="mapUrl" defaultValue={contact.mapUrl ?? ""} maxLength={1000} placeholder="https://maps.google.com/…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude (optional)">
            <Input name="latitude" inputMode="decimal" defaultValue={contact.latitude ?? ""} />
          </Field>
          <Field label="Longitude (optional)">
            <Input name="longitude" inputMode="decimal" defaultValue={contact.longitude ?? ""} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea name="notes" rows={3} defaultValue={contact.notes ?? ""} maxLength={10000} />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MergeDialog({ contact, onClose }: { contact: ContactProfile; onClose: () => void }) {
  const router = useProjectRouter();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Awaited<ReturnType<typeof searchContacts>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    if (query.trim().length < 2) {
      queueMicrotask(() => live && setOptions([]));
    } else {
      void searchContacts(query, contact.id).then((r) => live && setOptions(r));
    }
    return () => {
      live = false;
    };
  }, [query, contact.id]);

  const merge = (targetId: string, name: string) => {
    if (!window.confirm(`Merge ${contact.displayName} into ${name}? ${contact.label} goes away and everything it holds moves over. This cannot be undone.`)) return;
    start(async () => {
      const r = await mergeContacts(contact.id, targetId);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      router.push(`/contacts/${r.id}`);
    });
  };

  return (
    <Dialog open onClose={onClose} title="Merge into another contact" description={`Numbers, chats and notes of ${contact.displayName} move to the contact you choose.`}>
      <div className="space-y-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, number or CT number" autoFocus />
        {options.length ? (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {options.map((o) => (
              <li key={o.id}>
                <button type="button" disabled={pending} onClick={() => merge(o.id, o.name)} className="w-full px-3 py-2 text-left hover:bg-[var(--color-neutral-bg)]">
                  <span className="block truncate text-[13.5px] font-medium">
                    {o.name} <span className="tabular font-normal text-[color:var(--color-muted-foreground)]">{o.label}</span>
                  </span>
                  {o.detail ? <span className={`block truncate ${MUTED}`}>{o.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
