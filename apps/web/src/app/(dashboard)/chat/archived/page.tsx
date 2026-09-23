import Link from "next/link";
import { Archive } from "lucide-react";
import { requireAccess } from "@/server/authorize";
import { getArchivedChatConversations } from "@/server/chatInbox";
import { ArchivedList } from "./ArchivedList";

export const metadata = { title: "Archived conversations" };

/**
 * The archive: conversations hidden from the inbox, and the one place they can be brought back.
 *
 * Its own route rather than a filter on the main list, for the same reason the query is separate —
 * archiving means "not in my list", so folding these into the list's own data would mean fetching
 * rows that are almost always discarded, on every poll of a page that refreshes every four
 * seconds.
 */
export default async function ArchivedChatPage() {
  await requireAccess("messages.view");
  const conversations = await getArchivedChatConversations();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"
        >
          <Archive className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Archived</h1>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Hidden from the inbox. Monitoring and AI are unaffected — these conversations are still
            being handled, just not shown.
          </p>
        </div>
        <Link
          href="/chat"
          className="ml-auto shrink-0 text-[12px] text-[color:var(--color-muted-foreground)] underline-offset-2 hover:text-[color:var(--color-foreground)] hover:underline"
        >
          Back to inbox
        </Link>
      </div>

      <ArchivedList conversations={conversations} />
    </div>
  );
}
