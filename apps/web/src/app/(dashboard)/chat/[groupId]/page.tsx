import { ArrowLeft, Bot, ExternalLink, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Badge } from "@/components/ui";
import { getChatThread, getSavedReplies } from "@/server/chatInbox";
import { markChatReviewed } from "@/server/actions/chatOrganisation";
import { Composer } from "../Composer";
import { MarkWaitingButton } from "../MarkWaitingButton";
import { AiActiveNotice, MessageThread } from "../MessageThread";
import { ThreadScroller } from "../ThreadScroller";
import { conversationAvatar } from "../avatar";

export const metadata = { title: "WhatsApp Chat" };

/**
 * One conversation: header, thread, composer. Everything shown here is already in the
 * database — the page never asks the worker for anything, which is why it renders
 * instantly and works even while the WhatsApp session is reconnecting.
 */
export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = await params;
  const [thread, savedReplies] = await Promise.all([getChatThread(groupId), getSavedReplies()]);
  if (!thread) notFound();

  const { group, entries, hasMore } = thread;

  // Opening the conversation is what clears it from the "waiting" list. `after()` rather than an
  // inline await: this is a side effect nobody should wait on, and rendering a page must not block
  // on recording that it was rendered. It is registered below the notFound() guard on purpose —
  // `after` still runs when a render throws, and a group that does not exist must not be stamped.
  after(() => markChatReviewed(group.id));

  // Whether the customer's newest message is still unanswered. Drives the one control that would
  // otherwise be a button doing nothing: putting an already-answered conversation "back" in the
  // waiting list would put it nowhere.
  // The same tinted monogram the list uses, from the same function. A different avatar treatment
  // either side of one click makes the header read as a different object than the row that opened
  // it; identical ones make the navigation feel like the row expanded.
  const avatar = conversationAvatar(group.id, group.name);

  const lastEntry = entries.at(-1);
  const isUnanswered = lastEntry?.kind === "INCOMING" && !lastEntry.isTeamMember;

  const disabledReason = !group.isActive
    ? `This account is no longer a member of ${group.name}. Resync groups if you have been re-added.`
    : group.accountStatus !== "CONNECTED"
      ? `${group.accountLabel} is ${group.accountStatus.toLowerCase()}, so nothing can be sent right now. Reconnect it on WhatsApp Accounts.`
      : null;

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <Link
          href="/chat"
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
          <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
            {group.name}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            <span className="truncate">{group.accountLabel}</span>
            {group.participantCount !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" aria-hidden />
                  {group.participantCount}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {group.aiAutomationEnabled ? (
            <span className="hidden sm:inline">
              <Badge color="blue" dot>
                <Bot className="size-3" aria-hidden />
                AI
              </Badge>
            </span>
          ) : null}
          {!group.isMonitored ? (
            <span className="hidden sm:inline">
              <Badge color="gray">Not monitored</Badge>
            </span>
          ) : null}
          {isUnanswered ? <MarkWaitingButton groupId={group.id} /> : null}
          <Link
            href="/groups"
            title="Open this group's settings"
            className="flex size-8 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
          >
            <ExternalLink className="size-4" aria-hidden />
            <span className="sr-only">Group settings</span>
          </Link>
        </div>
      </header>

      {/* Opens on the newest message rather than the oldest, and stays put while you read back.
          See ThreadScroller. */}
      <ThreadScroller key={group.id} latestEntryId={lastEntry?.id ?? null}>
        {hasMore ? (
          <p className="px-6 pt-4 text-center text-[11px] text-[color:var(--color-muted-foreground)]">
            Showing the most recent messages. Older history is on the{" "}
            <Link href={`/messages?group=${encodeURIComponent(group.name)}`} className="link">
              All Messages
            </Link>{" "}
            page.
          </p>
        ) : null}
        <MessageThread entries={entries} />
      </ThreadScroller>

      {group.aiAutomationEnabled ? <AiActiveNotice suppressedUntil={group.aiSuppressedUntil} /> : null}
      <Composer groupId={group.id} disabledReason={disabledReason} savedReplies={savedReplies} />
    </>
  );
}
