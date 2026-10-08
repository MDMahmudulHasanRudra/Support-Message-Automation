import { requireProjectPage } from "@/server/authorize";
import { runWithProject } from "@/server/projectContext";
import { ArrowLeft, Smartphone, User } from "lucide-react";
import Link from "@/components/ProjectLink";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { pageAccess } from "@/server/authorize";
import { getPersonalChatThread, getSavedReplies } from "@/server/chatInbox";
import { markPersonalChatReviewed } from "@/server/actions/chatOrganisation";
import { Composer } from "../../../../Composer";
import { MarkWaitingButton } from "../../../../MarkWaitingButton";
import { MessageThread } from "../../../../MessageThread";
import { ThreadScroller } from "../../../../ThreadScroller";
import { conversationAvatar } from "../../../../avatar";
import { accountStatusTone } from "../../../../chatAccounts";

export const metadata = { title: "WhatsApp Chat" };

/**
 * One personal (1:1) chat of ONE account: header and thread, from the messages already stored. A
 * personal chat has no row of its own, so it is found by (account, chat id); the account in the URL
 * IS the chat's account — another account's chat with the same id is simply not found here.
 *
 * Replying uses the same composer and the same single outbound queue as a group. The server only
 * queues a reply into a chat this account already has (`sendPersonalChatMessage`), and the worker
 * checks, live, that the chat exists on the account before sending (`verifyPersonalChat`) — a reply
 * continues a conversation, it never starts one.
 */
export default async function PersonalChatPage({ params }: { params: Promise<{ accountId: string; chatId: string }> }) {
  // Its own check rather than relying on the chat layout's (see the group conversation page).
  const { canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, chatId: rawChatId } = await params;
  const [thread, savedReplies] = await Promise.all([getPersonalChatThread(accountId, decodeURIComponent(rawChatId)), getSavedReplies()]);
  if (!thread) notFound();

  const { chat, entries, hasMore } = thread;

  // Opening the chat clears it from "waiting", exactly as for a group — below the notFound() guard
  // and with the project handed in, for the same reasons as there.
  const project = await requireProjectPage();
  after(() => runWithProject(project, () => markPersonalChatReviewed(chat.accountId, chat.chatId)));

  const avatar = conversationAvatar(chat.id, chat.name);
  const tone = accountStatusTone(chat.accountStatus);
  const lastEntry = entries.at(-1);
  const isUnanswered = lastEntry?.kind === "INCOMING" && !lastEntry.isTeamMember;
  const number = chat.chatId.endsWith("@c.us") ? `+${chat.chatId.split("@")[0]}` : null;

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <Link
          href={`/chat/account/${chat.accountId}?type=personal`}
          aria-label="Back to conversations"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] md:hidden"
        >
          <ArrowLeft className="size-4.5" aria-hidden />
        </Link>

        <span
          aria-hidden
          style={{ background: avatar.background, color: avatar.color }}
          className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[12px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]"
        >
          {avatar.initials}
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{chat.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px font-medium text-[color:var(--color-neutral-fg)]">
              <Smartphone className="size-3" aria-hidden />
              {chat.accountLabel}
              <span className={`size-1.5 rounded-full ${tone.dot}`} title={tone.label} aria-hidden />
            </span>
            <span className="inline-flex items-center gap-1">
              <User className="size-3" aria-hidden />
              Personal chat
            </span>
            {number && number !== chat.name ? <span className="tabular">{number}</span> : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isUnanswered ? <MarkWaitingButton accountId={chat.accountId} chatId={chat.chatId} /> : null}
        </div>
      </header>

      <ThreadScroller key={chat.id} latestEntryId={lastEntry?.id ?? null}>
        {hasMore ? (
          <p className="px-6 pt-4 text-center text-[11px] text-[color:var(--color-muted-foreground)]">
            Showing the most recent messages. Older history is on the{" "}
            <Link href="/messages" className="link">
              All Messages
            </Link>{" "}
            page.
          </p>
        ) : null}
        <MessageThread entries={entries} accountLabel={chat.accountLabel} />
      </ThreadScroller>

      <Composer
        accountId={chat.accountId}
        groupId={chat.id}
        personalChatId={chat.chatId}
        accountLabel={chat.accountLabel}
        accountPhone={chat.accountPhone}
        savedReplies={savedReplies}
        disabledReason={
          !canReply
            ? "Your role can read conversations but not reply to them. Ask an administrator for Reply in WhatsApp Chat."
            : chat.accountStatus !== "CONNECTED"
              ? `${chat.accountLabel} is ${tone.label.toLowerCase()}, so nothing can be sent from it right now. Reconnect it on WhatsApp Accounts.`
              : null
        }
      />
    </>
  );
}
