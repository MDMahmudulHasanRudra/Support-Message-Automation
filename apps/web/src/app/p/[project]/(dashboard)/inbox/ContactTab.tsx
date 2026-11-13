"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Plus, Sparkles, Unlink, X } from "lucide-react";
import {
  CONTACT_CONSENT_LABEL,
  CONTACT_SOURCE_LABEL,
  contactIdentifierHref,
  detectContactIdentifier,
  normalizeContactIdentifier,
  type ContactIdentifierKindValue,
  type ContactIdentifierReading,
  type ConversationRef,
} from "@support-automation/shared";
import { Alert, Badge, Button, Field, Input, Textarea, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { ContactAvatar, CopyButton, KIND_ICON, PasteValues, usePastedValues, WhatsAppMark, type PickedValue } from "@/components/contacts/contactDisplay";
import { addContactValues, linkChatToContact, saveChatContact, saveContactNotes, searchContacts, unlinkChatFromContact, type HeldElsewhere } from "@/server/actions/contacts";
import type { ConversationContact, DetectedContactValue } from "@/server/contacts";

const SMALL = "text-[12.5px] text-[color:var(--color-muted-foreground)]";
const HEADING = "text-[12px] font-medium text-[color:var(--color-muted-foreground)]";

/**
 * The Contact tab beside every chat (CONTACTS.md). A box per number, email and link, what customers already wrote in
 * this chat ready to add with one press, and a clear choice when a value is already saved on someone else. A chat
 * belongs to one contact; a contact can hold many numbers and many chats, on any channel. Nothing here sends a message.
 */
export function ContactTab({ conversation, card }: { conversation: ConversationRef; card: ConversationContact }) {
  return card.contact ? <KnownContact conversation={conversation} card={card} contact={card.contact} /> : <NoContactYet conversation={conversation} card={card} />;
}

// ── The boxes ───────────────────────────────────────────────────────────────────────────────────

type BoxKind = "PHONE" | "EMAIL" | "LINK";
type Row = { id: number; text: string; touched: boolean };

const BOXES: Array<{ kind: BoxKind; title: string; add: string; noun: string; placeholder: string; inputMode: "tel" | "email" | "url" }> = [
  { kind: "PHONE", title: "Phone numbers", add: "Add number", noun: "number", placeholder: "01XXXXXXXXX or +8801XXXXXXXXX", inputMode: "tel" },
  { kind: "EMAIL", title: "Emails", add: "Add email", noun: "email", placeholder: "name@example.com", inputMode: "email" },
  { kind: "LINK", title: "Links", add: "Add link", noun: "link", placeholder: "Facebook, Instagram, Telegram or website link", inputMode: "url" },
];

let nextRowId = 1;
const emptyRow = (): Row => ({ id: nextRowId++, text: "", touched: false });
const emptyBoxes = (): Record<BoxKind, Row[]> => ({ PHONE: [emptyRow()], EMAIL: [emptyRow()], LINK: [emptyRow()] });

/** How one box reads: a value, a short reason it is not one, or nothing typed. */
function readBox(box: BoxKind, text: string, handleKind?: ContactIdentifierKindValue): ContactIdentifierReading | { error: string } | null {
  if (!text.trim()) return null;
  if (box === "PHONE") {
    const r = normalizeContactIdentifier("PHONE", text);
    return "error" in r ? { error: "This is not a phone number. Use 8 to 15 digits." } : r;
  }
  if (box === "EMAIL") {
    const r = normalizeContactIdentifier("EMAIL", text);
    return "error" in r ? { error: "This is not an email address." } : r;
  }
  const r = detectContactIdentifier(text);
  if (r && r.kind !== "OTHER") return r;
  // A bare @name says nothing about the app; this chat's own channel is the only safe guess.
  if (r && handleKind && handleKind !== "PHONE") {
    const own = normalizeContactIdentifier(handleKind, text);
    if (!("error" in own)) return own;
  }
  return { error: "This is not a link. Paste the whole address, for example facebook.com/name." };
}

const boxOf = (kind: ContactIdentifierKindValue): BoxKind => (kind === "PHONE" ? "PHONE" : kind === "EMAIL" ? "EMAIL" : "LINK");
/** What goes back into a box for a found value: a link for an account, so the box reads it the same way again. */
const boxText = (v: { kind: ContactIdentifierKindValue; value: string }) => (v.kind === "PHONE" || v.kind === "EMAIL" ? v.value : (contactIdentifierHref(v.kind, v.value) ?? v.value));
const keyOf = (v: { kind: string; normalized: string }) => `${v.kind}:${v.normalized}`;

function useValueBoxes(handleKind?: ContactIdentifierKindValue) {
  const [rows, setRows] = useState(emptyBoxes);
  const readings = (Object.keys(rows) as BoxKind[]).flatMap((box) => rows[box].map((row) => ({ box, row, read: readBox(box, row.text, handleKind) })));
  const valid = readings.flatMap((r) => (r.read && !("error" in r.read) ? [r.read] : []));
  const update = (box: BoxKind, id: number, patch: Partial<Row>) => setRows((all) => ({ ...all, [box]: all[box].map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  return {
    rows,
    readings,
    valid,
    invalid: readings.some((r) => r.read && "error" in r.read),
    taken: new Set(valid.map(keyOf)),
    update,
    addRow: (box: BoxKind) => setRows((all) => ({ ...all, [box]: [...all[box], emptyRow()] })),
    removeRow: (box: BoxKind, id: number) => setRows((all) => ({ ...all, [box]: all[box].length > 1 ? all[box].filter((r) => r.id !== id) : [emptyRow()] })),
    touchAll: () => setRows((all) => Object.fromEntries((Object.keys(all) as BoxKind[]).map((b) => [b, all[b].map((r) => ({ ...r, touched: true }))])) as Record<BoxKind, Row[]>),
    /** Puts found values into the first empty box of their kind, adding a box when every one is filled. */
    put: (values: ReadonlyArray<{ kind: ContactIdentifierKindValue; value: string }>) =>
      setRows((all) => {
        const next = { PHONE: [...all.PHONE], EMAIL: [...all.EMAIL], LINK: [...all.LINK] };
        for (const v of values) {
          const box = boxOf(v.kind);
          const empty = next[box].findIndex((r) => !r.text.trim());
          const row = { ...emptyRow(), text: boxText(v), touched: true };
          if (empty >= 0) next[box][empty] = { ...row, id: next[box][empty]!.id };
          else next[box].push(row);
        }
        return next;
      }),
    clear: () => setRows(emptyBoxes()),
  };
}
type ValueBoxesState = ReturnType<typeof useValueBoxes>;

function ValueBoxes({ boxes }: { boxes: ValueBoxesState }) {
  return (
    <div className="space-y-3">
      {BOXES.map((b) => {
        const rows = boxes.rows[b.kind];
        return (
          <fieldset key={b.kind} className="min-w-0">
            <legend className="mb-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">{b.title}</legend>
            <div className="space-y-1.5">
              {rows.map((row, i) => {
                const read = boxes.readings.find((r) => r.row.id === row.id)?.read;
                const error = row.touched && read && "error" in read ? read.error : null;
                const errorId = `box-${row.id}-error`;
                return (
                  <div key={row.id}>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={row.text}
                        inputMode={b.inputMode}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={rows.length > 1 ? `${b.title}, ${i + 1}` : b.title}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        placeholder={b.placeholder}
                        onChange={(e) => boxes.update(b.kind, row.id, { text: e.target.value })}
                        onBlur={() => boxes.update(b.kind, row.id, { touched: true })}
                        className={`min-w-0 flex-1 ${error ? "border-[var(--color-danger)]" : ""}`}
                      />
                      {rows.length > 1 ? (
                        <button
                          type="button"
                          aria-label={`Remove this ${b.noun}`}
                          title={`Remove this ${b.noun}`}
                          onClick={() => boxes.removeRow(b.kind, row.id)}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    {error ? (
                      <p id={errorId} className="mt-1 text-[12px] font-medium text-[color:var(--color-danger)]">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => boxes.addRow(b.kind)} className="link mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium">
              <Plus className="size-3.5" aria-hidden />
              {b.add}
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}

/** The boxes, then anything pasted in the secondary box, each value once. */
function collectValues(boxes: ValueBoxesState, pasted: PickedValue[]): PickedValue[] {
  const seen = new Set<string>();
  const out: PickedValue[] = [];
  for (const v of [...boxes.valid.map((r) => ({ kind: r.kind, value: r.value })), ...pasted]) {
    const key = `${v.kind}:${v.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function PasteSeveral({ paste }: { paste: ReturnType<typeof usePastedValues> }) {
  return (
    <details className="group" open={paste.text ? true : undefined}>
      <summary className="link cursor-pointer text-[12.5px] font-medium">Paste several at once</summary>
      <div className="mt-2">
        <PasteValues paste={paste} placeholder="Paste a line from the chat. Every number, email and link in it is picked up." />
      </div>
    </details>
  );
}

// ── Found in this chat ──────────────────────────────────────────────────────────────────────────

function FoundInChat({
  detected,
  hidden,
  pending,
  hint,
  onAdd,
  onUse,
}: {
  detected: DetectedContactValue[];
  hidden: Set<string>;
  pending: boolean;
  hint: string;
  onAdd: (values: DetectedContactValue[]) => void;
  onUse: (holder: { contactId: string; name: string }) => void;
}) {
  const shown = detected.filter((d) => !hidden.has(keyOf(d)));
  if (!shown.length) return null;
  const free = shown.filter((d) => !d.heldBy);
  return (
    <section aria-label="Found in this chat" className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--color-foreground)]">
          <Sparkles className="size-3.5 text-[color:var(--color-accent)]" aria-hidden />
          Found in this chat
        </p>
        {free.length > 1 ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAdd(free)}>
            Add all {free.length}
          </Button>
        ) : null}
      </div>
      <p className={`mb-1.5 ${SMALL}`}>{hint}</p>
      <ul className="space-y-1">
        {shown.map((d) => {
          const Icon = KIND_ICON[d.kind];
          return (
            <li key={keyOf(d)} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Icon className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px]" title={d.value}>
                {d.value}
              </span>
              {d.heldBy ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => onUse(d.heldBy!)} title={`Already saved on ${d.heldBy.name} (${d.heldBy.label})`}>
                  Use {d.heldBy.label}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => onAdd([d])} aria-label={`Add ${d.value}`}>
                  <Plus className="size-3.5" aria-hidden />
                  Add
                </Button>
              )}
              {d.heldBy ? <p className={`basis-full pl-5.5 ${SMALL}`}>Already saved on {d.heldBy.name}.</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Already saved on someone else ───────────────────────────────────────────────────────────────

function HeldElsewhereList({ items, pending, onUse, onSkip }: { items: HeldElsewhere[]; pending: boolean; onUse: (h: HeldElsewhere) => void; onSkip: (h: HeldElsewhere) => void }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((h) => (
        <Alert key={`${h.kind}:${h.value}`} tone="warning">
          <p className="break-words">
            <span className="font-medium">{h.value}</span> is already saved on{" "}
            <Link href={`/contacts/${h.contactId}`} className="font-medium underline">
              {h.name} ({h.label})
            </Link>
            . A number or email can be on one contact only.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => onUse(h)}>
              Use that contact for this chat
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onSkip(h)}>
              Skip
            </Button>
          </div>
        </Alert>
      ))}
    </div>
  );
}

function useHeldElsewhere() {
  const [held, setHeld] = useState<HeldElsewhere[]>([]);
  return { held, setHeld, skip: (h: HeldElsewhere) => setHeld((all) => all.filter((x) => x !== h)) };
}

// ── Automatic collection ────────────────────────────────────────────────────────────────────────

function AutoCollectionNote({ auto }: { auto: ConversationContact["autoCollection"] }) {
  const on = auto.autoCreate || auto.ai;
  const text = !on
    ? "Automatic collection is off. Contacts are saved only when someone saves them here."
    : auto.autoCreate
      ? `Automatic collection is on. New chats are saved as contacts by themselves${auto.ai ? ", and AI picks up numbers and emails customers write" : ""}.`
      : "Automatic collection is on. AI picks up numbers and emails customers write.";
  return (
    <p className={SMALL}>
      {text}{" "}
      {auto.canOpenSettings ? (
        <Link href="/settings/contacts" className="link font-medium">
          Contact settings
        </Link>
      ) : null}
    </p>
  );
}

// ── A chat with no contact ──────────────────────────────────────────────────────────────────────

function NoContactYet({ conversation, card }: { conversation: ConversationRef; card: ConversationContact }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const boxes = useValueBoxes(card.suggestion.handleKind);
  const paste = usePastedValues(card.suggestion.handleKind);
  const [name, setName] = useState(card.suggestion.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const { held, setHeld, skip } = useHeldElsewhere();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Awaited<ReturnType<typeof searchContacts>>>([]);

  if (!card.canEdit) return <p className={`p-4 ${SMALL}`}>This chat has no contact yet.</p>;

  const save = () => {
    if (boxes.invalid) {
      boxes.touchAll();
      setError("Fix the box marked in red, or clear it, then save.");
      return;
    }
    start(async () => {
      const r = await saveChatContact(conversation, { name, values: collectValues(boxes, paste.values) });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setHeld(r.heldElsewhere);
      boxes.clear();
      paste.clear();
      showToast({ tone: "success", title: r.created ? `${r.label} created` : `Added to ${r.label}` });
      router.refresh();
    });
  };

  const link = (contactId: string, label?: string) =>
    start(async () => {
      const r = await linkChatToContact(conversation, contactId);
      if ("error" in r) setError(r.error);
      else {
        setHeld([]);
        if (label) showToast({ tone: "success", title: `This chat is now on ${label}` });
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-3.5 p-4">
      <div>
        <p className="text-[13.5px] font-semibold text-[color:var(--color-foreground)]">Save this customer</p>
        <p className={`mt-0.5 ${SMALL}`}>{card.suggestion.isGroup ? "A group counts as one contact. It can hold several numbers." : "Kept in Contacts, apart from your client and billing lists."}</p>
      </div>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Customer's name" />
      </Field>
      {card.suggestion.values.length ? (
        <div>
          <p className={`mb-1.5 ${HEADING}`}>Saved with this chat automatically</p>
          <ul className="space-y-1">
            {card.suggestion.values.map((v) => {
              const Icon = KIND_ICON[v.kind];
              return (
                <li key={v.normalized} className="flex items-center gap-2 text-[13px]">
                  <Icon className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  <span className="truncate">{v.value}</span>
                  {v.isWhatsApp ? <WhatsAppMark /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <FoundInChat
        detected={card.detected}
        hidden={boxes.taken}
        pending={pending}
        hint="Customers wrote these here. Add puts them in the boxes below."
        onAdd={(values) => boxes.put(values)}
        onUse={(h) => link(h.contactId, h.name)}
      />

      <ValueBoxes boxes={boxes} />
      <PasteSeveral paste={paste} />

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <HeldElsewhereList items={held} pending={pending} onUse={(h) => link(h.contactId, h.name)} onSkip={skip} />
      <Button onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save contact"}
      </Button>

      <div className="border-t border-[var(--color-border)] pt-3">
        <p className={`mb-1.5 ${HEADING}`}>Or add this chat to someone already saved</p>
        <Input
          value={query}
          aria-label="Search saved contacts"
          placeholder="Search name or number"
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            if (q.trim().length < 2) setOptions([]);
            else void searchContacts(q).then(setOptions);
          }}
        />
        {options.length ? (
          <ul className="mt-1.5 divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {options.map((o) => (
              <li key={o.id}>
                <button type="button" disabled={pending} onClick={() => link(o.id)} className="w-full px-3 py-2 text-left hover:bg-[var(--color-neutral-bg)]">
                  <span className="block truncate text-[13px] font-medium">
                    {o.name} <span className="tabular font-normal text-[color:var(--color-muted-foreground)]">{o.label}</span>
                  </span>
                  {o.detail ? <span className={`block truncate ${SMALL}`}>{o.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <AutoCollectionNote auto={card.autoCollection} />
    </div>
  );
}

// ── A chat with a contact ───────────────────────────────────────────────────────────────────────

function KnownContact({ conversation, card, contact }: { conversation: ConversationRef; card: ConversationContact; contact: NonNullable<ConversationContact["contact"]> }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const boxes = useValueBoxes(card.suggestion.handleKind);
  const paste = usePastedValues(card.suggestion.handleKind);
  const [note, setNote] = useState(contact.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const { held, setHeld, skip } = useHeldElsewhere();
  const [pending, start] = useTransition();
  const typed = collectValues(boxes, paste.values);

  const add = (values: PickedValue[], fromBoxes: boolean) =>
    start(async () => {
      const r = await addContactValues(contact.id, values);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setHeld(r.heldElsewhere);
      if (fromBoxes) {
        boxes.clear();
        paste.clear();
      }
      if (r.added) showToast({ tone: "success", title: r.added === 1 ? "Added" : `${r.added} added` });
      else if (!r.heldElsewhere.length) showToast({ tone: "info", title: "Already saved on this contact" });
      router.refresh();
    });

  const addTyped = () => {
    if (boxes.invalid) {
      boxes.touchAll();
      setError("Fix the box marked in red, or clear it, then add.");
      return;
    }
    if (typed.length) add(typed, true);
  };

  const moveChatTo = (contactId: string, label: string) =>
    start(async () => {
      const r = await linkChatToContact(conversation, contactId);
      if ("error" in r) setError(r.error);
      else {
        setHeld([]);
        showToast({ tone: "success", title: `This chat is now on ${label}` });
        router.refresh();
      }
    });

  const saveNote = () => {
    if (note === (contact.notes ?? "")) return;
    start(async () => {
      const r = await saveContactNotes(contact.id, note);
      if ("error" in r) setError(r.error);
      else {
        showToast({ tone: "success", title: "Notes saved" });
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-3">
        <ContactAvatar name={contact.name} />
        <div className="min-w-0 flex-1">
          <Link href={`/contacts/${contact.id}`} className="block truncate text-[14px] font-semibold text-[color:var(--color-foreground)] hover:underline">
            {contact.name}
          </Link>
          <p className={`truncate ${SMALL}`}>
            <span className="tabular">{contact.label}</span>
            {contact.company ? ` · ${contact.company}` : ""} · {CONTACT_SOURCE_LABEL[contact.source]}
          </p>
        </div>
      </div>
      {contact.archived ? <Alert tone="warning">This contact is archived.</Alert> : null}

      {contact.values.length ? (
        <ul className="-mx-1 space-y-0.5">
          {contact.values.map((v) => {
            const Icon = KIND_ICON[v.kind];
            return (
              <li key={v.id} className="flex items-center gap-2 rounded-[var(--radius-md)] px-1 py-0.5 hover:bg-[var(--color-neutral-bg)]">
                <Icon className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                {v.href ? (
                  <a href={v.href} target={v.href.startsWith("https") ? "_blank" : undefined} rel="noopener noreferrer nofollow" className="min-w-0 flex-1 truncate text-[13px] hover:underline">
                    {v.value}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[13px]">{v.value}</span>
                )}
                {v.isWhatsApp ? <WhatsAppMark /> : null}
                <CopyButton value={v.value} label="value" />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={SMALL}>No number or address yet.</p>
      )}

      {contact.tags.length || contact.consent !== "UNKNOWN" ? (
        <div className="flex flex-wrap gap-1.5">
          {contact.consent !== "UNKNOWN" ? <Badge color={contact.consent === "OPTED_IN" ? "green" : "red"}>{CONTACT_CONSENT_LABEL[contact.consent]}</Badge> : null}
          {contact.tags.map((t) => (
            <Badge key={t} color="gray">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      {card.canEdit ? (
        <>
          <FoundInChat
            detected={card.detected}
            hidden={boxes.taken}
            pending={pending}
            hint={`Customers wrote these here. Add saves them on ${contact.name}.`}
            onAdd={(values) => add(values.map((v) => ({ kind: v.kind, value: v.value })), false)}
            onUse={(h) => moveChatTo(h.contactId, h.name)}
          />
          <div className="border-t border-[var(--color-border)] pt-3">
            <p className="mb-2 text-[13.5px] font-semibold text-[color:var(--color-foreground)]">Add more</p>
            <ValueBoxes boxes={boxes} />
            <div className="mt-2">
              <PasteSeveral paste={paste} />
            </div>
            {typed.length || boxes.invalid ? (
              <Button variant="secondary" className="mt-3 w-full" onClick={addTyped} disabled={pending}>
                {pending ? "Adding…" : typed.length === 1 ? "Add it" : typed.length ? `Add ${typed.length}` : "Add"}
              </Button>
            ) : null}
          </div>
          <Field label="Notes">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} rows={3} maxLength={10000} placeholder="Anything worth remembering. Saved when you click away." />
          </Field>
        </>
      ) : contact.notes ? (
        <p className="whitespace-pre-wrap text-[13px]">{contact.notes}</p>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <HeldElsewhereList items={held} pending={pending} onUse={(h) => moveChatTo(h.contactId, h.name)} onSkip={skip} />

      {card.canEdit ? <AutoCollectionNote auto={card.autoCollection} /> : null}

      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
        <Link href={`/contacts/${contact.id}`} className="link inline-flex items-center gap-1.5 text-[12.5px] font-medium">
          <ExternalLink className="size-3.5" aria-hidden />
          Full profile
        </Link>
        {card.canEdit ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await unlinkChatFromContact(conversation);
                if ("error" in r) setError(r.error);
                else router.refresh();
              })
            }
            className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            <Unlink className="size-3.5" aria-hidden />
            Wrong contact
          </button>
        ) : null}
      </div>
    </div>
  );
}
