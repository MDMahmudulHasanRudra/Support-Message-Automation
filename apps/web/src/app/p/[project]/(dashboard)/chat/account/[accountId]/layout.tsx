import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getChatAccounts, getChatCategories, getChatInbox } from "@/server/chatInbox";
import { ChatWorkspace } from "../../ConversationList";

/**
 * The chat workspace for ONE WhatsApp account: the account selector, search and filters across the
 * top, the account's conversations on the left, the open conversation on the right.
 *
 * The account is a URL segment because it has to be: the conversation list lives in this layout (so
 * it keeps its scroll and search as you move between conversations), and a path segment is the only
 * per-request state a layout can read. A cookie would be shared by every tab, so one tab switching
 * account would silently repaint another tab's inbox with the other number — exactly the
 * cross-account mix this structure exists to prevent. Changing account changes the segment, which
 * remounts the workspace: selection, filter and search start clean.
 *
 * Every figure below is computed for this account on the server. The scoped client confines the
 * account lookup to the URL's project, so another project's account id is a 404.
 *
 * The height is pinned to the viewport (minus the dashboard header and the page padding around it —
 * `--chat-inset`, which the Main Admin Workspace raises to make room for its project tabs) so each
 * pane scrolls on its own, the way a mail or chat client does.
 */
export default async function ChatAccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const accounts = await getChatAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) notFound();

  const [inbox, categories] = await Promise.all([getChatInbox(account.id), getChatCategories(account.id)]);

  return (
    <div className="flex h-[calc(100dvh_-_var(--chat-inset,6.75rem))] min-h-[30rem] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] sm:h-[calc(100dvh_-_var(--chat-inset-sm,8.25rem))]">
      {/* Polls the server tree so new messages and delivery-state changes appear without a
          manual reload. Four seconds sits close enough to the outbound queue's own 2s tick
          that a reply's queued → sent transition is visible almost immediately. */}
      <AutoRefresh intervalMs={4000} />
      <ChatWorkspace
        key={account.id}
        account={account}
        accounts={accounts}
        conversations={inbox.conversations}
        counts={inbox.counts}
        categories={categories}
      >
        {children}
      </ChatWorkspace>
    </div>
  );
}
