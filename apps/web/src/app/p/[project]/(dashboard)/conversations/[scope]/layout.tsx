import { notFound } from "next/navigation";
import { isInboxScope } from "@support-automation/shared";
import { AutoRefresh } from "@/components/AutoRefresh";
import { requireAccess } from "@/server/authorize";
import { inboxFilterOptions, loadInbox } from "@/server/channels/inbox";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import { InboxWorkspace } from "../InboxWorkspace";

/**
 * The unified inbox (OMNICHANNEL.md §4): `/conversations/all` holds every channel, and
 * `/conversations/<whatsapp|messenger|instagram|telegram>` one of them — the same rows, filtered,
 * never a copy. The scope is a path segment for the same reason WhatsApp Chat's account is: the list
 * lives in this layout, and a path segment is the only per-request state a layout can read.
 *
 * Polled every four seconds while the tab is visible (AutoRefresh pauses when it is hidden), like
 * WhatsApp Chat.
 */
export default async function InboxLayout({ children, params }: { children: React.ReactNode; params: Promise<{ scope: string }> }) {
  const session = await requireAccess("messages.view", "OMNICHANNEL");
  const { scope } = await params;
  if (!isInboxScope(scope)) notFound();
  const [inbox, filterOptions, people, disabled, canShare] = await Promise.all([
    loadInbox({ scope, viewerId: session.userId }),
    inboxFilterOptions(),
    mentionablePeople(session),
    activeDisabledFeatures(),
    hasPermission(session, "channels.manage"),
  ]);
  const options = { ...filterOptions, people: people.map((p) => ({ id: p.id, name: p.name })), collaboration: !disabled.has("INBOX_COLLABORATION"), canShare };

  return (
    <div className="flex h-[calc(100dvh_-_var(--chat-inset,6.75rem))] min-h-[30rem] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] max-sm:min-h-0 max-sm:rounded-none max-sm:border-0 max-sm:shadow-none sm:h-[calc(100dvh_-_var(--chat-inset-sm,8.25rem))]">
      <AutoRefresh intervalMs={4000} />
      <InboxWorkspace key={scope} scope={scope} items={inbox.items} counts={inbox.counts} truncated={inbox.truncated} options={options}>
        {children}
      </InboxWorkspace>
    </div>
  );
}
