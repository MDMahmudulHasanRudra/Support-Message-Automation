import { notFound } from "next/navigation";
import { CONTACT_CAMPAIGN_CHANNEL_LABEL, CONTACT_SOURCE_LABEL, type ContactCampaignChannelValue } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { loadContactProfile } from "@/server/contacts";
import Link from "@/components/ProjectLink";
import { Badge, Card } from "@/components/ui";
import { ContactAvatar } from "@/components/contacts/contactDisplay";
import { ContactDetailsCard, ContactHeaderActions, ContactValuesCard } from "./ContactProfileParts";

export const metadata = { title: "Contact" };

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Added",
  IMPORTED: "Imported",
  EDITED: "Edited",
  VALUE_ADDED: "Added a value",
  VALUE_REMOVED: "Removed a value",
  CHAT_LINKED: "Chat linked",
  CHAT_UNLINKED: "Chat unlinked",
  CLIENT_LINKED: "Linked to a client",
  CLIENT_UNLINKED: "Client link removed",
  ARCHIVED: "Archived",
  RESTORED: "Restored",
  MERGED: "Merged",
  CONSENT: "Offers answer changed",
  CONTACTED: "Contacted",
};

/** One contact's profile (CONTACTS.md): every number and account, every chat on every channel, and its history. */
export default async function ContactProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("contacts.view", "CONTACTS");
  const { id } = await params;
  const contact = await loadContactProfile(session, id);
  if (!contact) notFound();
  const [canEdit, canDelete, disabled, canSeeClients] = await Promise.all([hasPermission(session, "contacts.edit"), hasPermission(session, "contacts.delete"), activeDisabledFeatures(), hasPermission(session, "clients.view")]);
  const clientsAvailable = canSeeClients && !disabled.has("CLIENT_CENTER");

  return (
    <div className="min-w-0">
      <div className="mb-4 text-[13px] text-[color:var(--color-muted-foreground)]">
        <Link href="/contacts" className="hover:underline">
          Contacts
        </Link>{" "}
        / <span className="tabular">{contact.label}</span>
      </div>

      <div className="mb-4 flex flex-wrap items-start gap-3.5">
        <ContactAvatar name={contact.displayName} large />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{contact.displayName}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
            <span className="tabular font-medium">{contact.label}</span>
            {contact.code ? <span>· {contact.code}</span> : null}
            <span>
              · {CONTACT_SOURCE_LABEL[contact.source]}
              {contact.collectedByAi ? " (collected by AI)" : ""}
            </span>
            {contact.status === "ARCHIVED" ? <Badge color="yellow">Archived</Badge> : null}
          </p>
          {contact.tags.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {contact.tags.map((t) => (
                <Link key={t} href={`/contacts?tag=${encodeURIComponent(t)}`}>
                  <Badge color="gray">{t}</Badge>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        {canEdit || canDelete ? <ContactHeaderActions contact={contact} canEdit={canEdit} canDelete={canDelete} /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <ContactValuesCard contact={contact} canEdit={canEdit} />

          <Card className="p-4">
            <h2 className="mb-2.5 text-[14px] font-semibold">Chats</h2>
            {contact.conversations.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Not linked to a chat yet. Open a chat and use its Contact tab.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {contact.conversations.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium">{c.open?.label ?? c.title ?? "Chat"}</p>
                      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">{CONTACT_SOURCE_LABEL[c.source]}</p>
                    </div>
                    {c.open?.href ? (
                      <Link href={c.open.href} className="link shrink-0 text-[13px] font-medium">
                        Open
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {contact.campaigns.length ? (
            <Card className="p-4">
              <h2 className="mb-2.5 text-[14px] font-semibold">Campaigns</h2>
              <ul className="divide-y divide-[var(--color-border)]">
                {contact.campaigns.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                    <Link href={`/contacts/campaigns/${c.campaignId}`} className="min-w-0 truncate font-medium hover:underline">
                      {c.campaignName}
                    </Link>
                    <span className="shrink-0 text-[12.5px] text-[color:var(--color-muted-foreground)]">
                      {CONTACT_CAMPAIGN_CHANNEL_LABEL[c.channel as ContactCampaignChannelValue]}
                      {c.doneAt ? ` · ${DATE.format(new Date(c.doneAt))}` : c.status === "SKIPPED" ? " · Left out" : " · Waiting"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="p-4">
            <h2 className="mb-2.5 text-[14px] font-semibold">History</h2>
            <ol className="space-y-2">
              {contact.events.map((e) => (
                <li key={e.id} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 text-[13px]">
                  <time className="tabular text-[12.5px] text-[color:var(--color-muted-foreground)]">{DATE_TIME.format(new Date(e.createdAt))}</time>
                  <p className="min-w-0 break-words">
                    {EVENT_LABEL[e.kind] ?? e.kind}
                    {e.detail ? <span className="text-[color:var(--color-muted-foreground)]"> · {e.detail}</span> : null}
                    {e.actorName ? <span className="text-[color:var(--color-muted-foreground)]"> · {e.actorName}</span> : null}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <ContactDetailsCard contact={contact} canEdit={canEdit} clientsAvailable={clientsAvailable} addedOn={DATE.format(new Date(contact.createdAt))} lastContacted={contact.lastContactedAt ? DATE.format(new Date(contact.lastContactedAt)) : null} />
      </div>
    </div>
  );
}
