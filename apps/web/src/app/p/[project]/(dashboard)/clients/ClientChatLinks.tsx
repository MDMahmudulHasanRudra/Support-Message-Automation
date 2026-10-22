"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, Select } from "@/components/ui";
import { linkWhatsAppChat, searchLinkableChats, unlinkWhatsAppChat } from "@/server/actions/clientChatLinks";
import type { LinkableChat } from "@/server/clientChatLinks";

export interface ChatLinkRow {
  id: string;
  accountLabel: string;
  chatLabel: string;
  chatId: string;
  linkedBy: string | null;
  linkedAt: string;
}

/** The number shown beside a chat's name: only `@c.us` carries one; a hidden-number chat shows none. */
const numberOf = (chatId: string) => (chatId.endsWith("@c.us") ? `+${chatId.split("@")[0]}` : "hidden number");

/**
 * A client's linked WhatsApp chats. Anyone who can open the client sees them; linking and unlinking
 * need `clients.link_whatsapp_chat` (`canLink`). Linking is one chat at a time and always confirmed:
 * a chat whose number equals the client's is only marked "Suggested".
 */
export function ChatLinksPanel({ clientId, clientName, links, accounts, canLink, archived }: { clientId: string; clientName: string; links: ChatLinkRow[]; accounts: Array<{ id: string; label: string }>; canLink: boolean; archived: boolean }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState("");
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<LinkableChat[] | null>(null);
  const [pending, setPending] = useState<LinkableChat | null>(null);
  const [removing, setRemoving] = useState<ChatLinkRow | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  const editable = canLink && !archived;

  function search(nextAccount = accountId, nextQuery = query) {
    if (!nextAccount) return setChats(null);
    startTransition(async () => setChats(await searchLinkableChats(clientId, nextAccount, nextQuery)));
  }
  function confirmLink() {
    const chat = pending;
    if (!chat) return;
    startTransition(async () => {
      const r = await linkWhatsAppChat(clientId, accountId, chat.chatId);
      setPending(null);
      setMessage({ tone: r.ok ? "info" : "danger", text: r.message });
      if (r.ok) setChats(null);
      router.refresh();
    });
  }
  function confirmUnlink() {
    const link = removing;
    if (!link) return;
    startTransition(async () => {
      const r = await unlinkWhatsAppChat(link.id);
      setRemoving(null);
      setMessage({ tone: r.ok ? "info" : "danger", text: r.message });
      router.refresh();
    });
  }

  const accountLabel = accounts.find((a) => a.id === accountId)?.label ?? "";
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
        A link says that an existing one-to-one chat on one of your WhatsApp accounts is this client. It is made by hand, one chat at a time, and never from a number match. Nothing is sent because of a link.
      </p>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {links.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No chat is linked to this client.</p> : null}
      <ul className="divide-y divide-[var(--color-border)]">
        {links.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{l.chatLabel}</div>
              <div className="text-[13px] text-[color:var(--color-muted-foreground)]">
                {numberOf(l.chatId)} · on {l.accountLabel} · linked {l.linkedAt}
                {l.linkedBy ? ` by ${l.linkedBy}` : ""}
              </div>
            </div>
            {editable ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(l)}>
                Remove link
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {editable ? (
        <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <p className="text-sm font-medium">Link a chat</p>
          {accounts.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">This project has no WhatsApp account.</p> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="WhatsApp account">
              <Select
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  search(e.target.value, query);
                }}
              >
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Find a chat (name or number)" className="sm:col-span-2">
              <Input
                value={query}
                placeholder="Search this account's chats"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    search();
                  }
                }}
              />
            </Field>
          </div>
          <Button type="button" size="sm" variant="secondary" disabled={!accountId} loading={busy && !pending && !removing} onClick={() => search()}>
            Search
          </Button>
          {chats && chats.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">No individual chat found on this account. Only chats the account already has can be linked.</p> : null}
          <ul className="divide-y divide-[var(--color-border)]">
            {(chats ?? []).map((c) => (
              <li key={c.chatId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {c.label}
                    {c.suggested ? <Badge color="blue">Suggested: same number</Badge> : null}
                  </div>
                  <div className="text-[13px] text-[color:var(--color-muted-foreground)]">{numberOf(c.chatId)}</div>
                </div>
                {c.linkedTo ? (
                  <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
                    Already linked to{" "}
                    <Link className="link" href={`/clients/${c.linkedTo.clientId}`}>
                      {c.linkedTo.name}
                    </Link>
                  </span>
                ) : (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending(c)}>
                    Link to this client
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmLink}
        loading={busy}
        title="Link this chat?"
        description={pending ? `${pending.label} (${numberOf(pending.chatId)}) on ${accountLabel} will be linked to ${clientName}. Check that this is the same person: a wrong link means a later message could be addressed to the wrong client.` : ""}
        confirmLabel="Link chat"
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={confirmUnlink}
        loading={busy}
        title="Remove this link?"
        description={removing ? `${removing.chatLabel} will no longer be linked to ${clientName}. The chat and its messages are not touched.` : ""}
        confirmLabel="Remove link"
      />
    </div>
  );
}
