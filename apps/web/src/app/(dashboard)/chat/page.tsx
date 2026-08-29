import { MessagesSquare } from "lucide-react";
import { requireSession } from "@/server/auth";
import { getChatConversations } from "@/server/chatInbox";
import { ConversationList } from "./ConversationList";

export const metadata = { title: "WhatsApp Chat" };

/**
 * The index. On a wide screen the conversation list already sits in the layout's sidebar,
 * so this pane just explains what to do next. Below `md` that sidebar is hidden, so the
 * list becomes this page.
 */
export default async function ChatIndexPage() {
  await requireSession();
  const conversations = await getChatConversations();

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        <ConversationList conversations={conversations} />
      </div>

      <div className="hidden flex-1 items-center justify-center p-10 md:flex">
        <div className="max-w-sm text-center">
          <span
            aria-hidden
            className="mx-auto flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]"
          >
            <MessagesSquare className="size-5" />
          </span>
          <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
            Pick a conversation
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Every group this account belongs to is on the left, most recently active first.
            Open one to read it and reply — your message goes out through the same queue the
            automation uses, so account rate limits still apply.
          </p>
        </div>
      </div>
    </>
  );
}
