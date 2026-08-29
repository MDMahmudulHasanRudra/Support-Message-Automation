import { requireSession } from "@/server/auth";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getChatConversations } from "@/server/chatInbox";
import { ConversationList } from "./ConversationList";

/**
 * The two-pane frame. The conversation list lives here rather than in each page so it
 * keeps its scroll position and search text as you move between conversations — the one
 * thing that separates a chat client from a list of links.
 *
 * The height is pinned to the viewport (minus the dashboard header and the page padding
 * around it) so each pane scrolls on its own, the way a mail or chat client does, instead
 * of the whole page growing with the longest conversation.
 *
 * Below `md` the sidebar is hidden and the two views become separate screens: /chat is the
 * list, /chat/[id] is the conversation. Each of those pages renders what it needs, so
 * nothing is duplicated into the DOM twice here.
 */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const conversations = await getChatConversations();

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] min-h-[30rem] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] sm:h-[calc(100dvh-8.25rem)]">
      {/* Polls the server tree so new messages and delivery-state changes appear without a
          manual reload. Four seconds sits close enough to the outbound queue's own 2s tick
          that a reply's queued → sent transition is visible almost immediately. */}
      <AutoRefresh intervalMs={4000} />

      <aside
        aria-label="Conversations"
        className="hidden w-[19rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:flex"
      >
        <ConversationList conversations={conversations} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
