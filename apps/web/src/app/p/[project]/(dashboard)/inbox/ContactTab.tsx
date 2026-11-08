"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Unlink } from "lucide-react";
import { CONTACT_CONSENT_LABEL, CONTACT_SOURCE_LABEL, type ConversationRef } from "@support-automation/shared";
import { Alert, Badge, Button, Field, Input, Textarea, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { ContactAvatar, CopyButton, KIND_ICON, PasteValues, usePastedValues, WhatsAppMark } from "@/components/contacts/contactDisplay";
import { addContactValues, linkChatToContact, saveChatContact, saveContactNotes, searchContacts, unlinkChatFromContact } from "@/server/actions/contacts";
import type { ConversationContact } from "@/server/contacts";

const SMALL = "text-[12.5px] text-[color:var(--color-muted-foreground)]";

/**
 * The Contact tab beside every chat (CONTACTS.md). Copy a number from the conversation, paste it here and it is on this
 * chat's contact. A chat belongs to one contact; a contact can hold many numbers and many chats, on any channel.
 */
export function ContactTab({ conversation, card }: { conversation: ConversationRef; card: ConversationContact }) {
  return card.contact ? <KnownContact conversation={conversation} card={card} contact={card.contact} /> : <NoContactYet conversation={conversation} card={card} />;
}

function Notices({ error, notes }: { error: string | null; notes: string[] }) {
  return (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notes.map((n) => (
        <Alert key={n} tone="warning">
          {n}
        </Alert>
      ))}
    </>
  );
}

function NoContactYet({ conversation, card }: { conversation: ConversationRef; card: ConversationContact }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const paste = usePastedValues(card.suggestion.handleKind);
  const [name, setName] = useState(card.suggestion.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Awaited<ReturnType<typeof searchContacts>>>([]);

  if (!card.canEdit) return <p className={`p-4 ${SMALL}`}>This chat has no contact yet.</p>;

  const save = () =>
    start(async () => {
      const r = await saveChatContact(conversation, { name, values: paste.values });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setNotes(r.heldElsewhere);
      paste.clear();
      showToast({ tone: "success", title: r.created ? `${r.label} created` : `Added to ${r.label}` });
      router.refresh();
    });

  const link = (contactId: string) =>
    start(async () => {
      const r = await linkChatToContact(conversation, contactId);
      if ("error" in r) setError(r.error);
      else router.refresh();
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
          <p className="mb-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">From this chat</p>
          <ul className="space-y-1">
            {card.suggestion.values.map((v) => {
              const Icon = KIND_ICON[v.kind];
              return (
                <li key={v.normalized} className="flex items-center gap-2 text-[13px]">
                  <Icon className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  <span className="truncate">{v.value}</span>
                  {v.isWhatsApp ? <WhatsAppMark /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <Field label="Numbers, emails, social links">
        <PasteValues paste={paste} />
      </Field>
      <Notices error={error} notes={notes} />
      <Button onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save contact"}
      </Button>

      <div className="border-t border-[var(--color-border)] pt-3">
        <p className="mb-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Or add this chat to someone already saved</p>
        <Input
          value={query}
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
    </div>
  );
}

function KnownContact({ conversation, card, contact }: { conversation: ConversationRef; card: ConversationContact; contact: NonNullable<ConversationContact["contact"]> }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const paste = usePastedValues(card.suggestion.handleKind);
  const [note, setNote] = useState(contact.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const add = () =>
    start(async () => {
      const r = await addContactValues(contact.id, paste.values);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setHeld(r.heldElsewhere);
      paste.clear();
      if (r.added) showToast({ tone: "success", title: r.added === 1 ? "Added" : `${r.added} added` });
      else if (!r.heldElsewhere.length) showToast({ tone: "info", title: "Already saved on this contact" });
      router.refresh();
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
          <Field label="Add from the chat">
            <PasteValues paste={paste} />
          </Field>
          {paste.values.length ? (
            <Button variant="secondary" onClick={add} disabled={pending}>
              {pending ? "Adding…" : paste.values.length === 1 ? "Add it" : `Add ${paste.values.length}`}
            </Button>
          ) : null}
          <Field label="Notes">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} rows={3} maxLength={10000} placeholder="Anything worth remembering. Saved when you click away." />
          </Field>
        </>
      ) : contact.notes ? (
        <p className="whitespace-pre-wrap text-[13px]">{contact.notes}</p>
      ) : null}

      <Notices error={error} notes={held} />

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
