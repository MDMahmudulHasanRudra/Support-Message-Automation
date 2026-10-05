import { requireProjectPage } from "@/server/authorize";
import { runWithProject } from "@/server/projectContext";
import { ArrowLeft, Bot, ExternalLink, Smartphone, Users } from "lucide-react";
import Link from "@/components/ProjectLink";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { Badge } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { getChatThread, getOtherAccountCopies, getSavedReplies } from "@/server/chatInbox";
import { markChatReviewed } from "@/server/actions/chatOrganisation";
import { Composer } from "../../../Composer";
import { MarkWaitingButton } from "../../../MarkWaitingButton";
import { AiActiveNotice, MessageThread } from "../../../MessageThread";
import { ThreadScroller } from "../../../ThreadScroller";
import { conversationAvatar } from "../../../avatar";
import { accountStatusTone } from "../../../chatAccounts";

export const metadata = { title: "WhatsApp Chat" };

/**
 * One conversation — ONE account's copy of a WhatsApp group: header, thread, composer. Everything
 * shown here is already in the database; the page never asks the worker for anything, which is why
 * it renders instantly and works even while the WhatsApp session is reconnecting.
 *
 * The URL's account and the conversation's account are always the same. A link naming a group under
 * the wrong account (an old bookmark, a crafted URL) is redirected to the group's own account, so the
 * list beside it can never be one number's while the conversation is another's.
 */
export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ accountId: string; groupId: string }>;
}) {
  // Its own check rather than relying on the chat layout's: Next does not re-render a layout on
  // navigation within it, so a layout-only check would miss a role changed mid-session.
  const { canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, groupId } = await params;
  const [thread, savedReplies, otherCopies] = await Promise.all([
    getChatThread(groupId),
    getSavedReplies(),
    getOtherAccountCopies(groupId),
  ]);
  if (!thread) notFound();

  const { group, entries, hasMore } = thread;
  if (group.accountId !== accountId) redirect(await projectPath(`/chat/account/${group.accountId}/${group.id}`));

  // Opening the conversation is what clears it from the "waiting" list. `after()` rather than an
  // inline await: this is a side effect nobody should wait on. Registered below the notFound()
  // guard on purpose — `after` still runs when a render throws, and a group that does not exist must
  // not be stamped. It runs once the response is sent, where the request's URL (and so its project)
  // can no longer be read, so the already-authorized project is handed in explicitly.
  const project = await requireProjectPage();
  after(() => runWithProject(project, () => markChatReviewed(group.id)));

  // The same tinted monogram the list uses, from the same function, so the header reads as the row
  // that opened it.
  const avatar = conversationAvatar(group.id, group.name);
  const tone = accountStatusTone(group.accountStatus);

  const lastEntry = entries.at(-1);
  const isUnanswered = lastEntry?.kind === "INCOMING" && !lastEntry.isTeamMember;

  // First, because it is about the person rather than the conversation: nothing below matters to
  // somebody whose role cannot send at all.
  const disabledReason = !canReply
    ? "Your role can read conversations but not reply to them. Ask an administrator for Reply in WhatsApp Chat."
    : !group.isActive
      ? `${group.accountLabel} is no longer a member of ${group.name}, so nothing can be sent from it. Resync groups if it has been re-added.`
      : group.accountStatus !== "CONNECTED"
        ? `${group.accountLabel} is ${tone.label.toLowerCase()}, so nothing can be sent from it right now. Reconnect it on WhatsApp Accounts.`
        : null;

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <Link
          href={`/chat/account/${group.accountId}`}
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
          <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{group.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            {/* Which number this conversation, and every reply typed below, belongs to. */}
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px font-medium text-[color:var(--color-neutral-fg)]">
              <Smartphone className="size-3" aria-hidden />
              {group.accountLabel}
              <span className={`size-1.5 rounded-full ${tone.dot}`} title={tone.label} aria-hidden />
            </span>
            {group.participantCount !== null ? (
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" aria-hidden />
                {group.participantCount}
              </span>
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

      {/* Opens on the newest message rather than the oldest, and stays put while you read back. */}
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
        <MessageThread entries={entries} accountLabel={group.accountLabel} />
      </ThreadScroller>

      {group.aiAutomationEnabled ? <AiActiveNotice suppressedUntil={group.aiSuppressedUntil} /> : null}
      <Composer
        accountId={group.accountId}
        groupId={group.id}
        accountLabel={group.accountLabel}
        accountPhone={group.accountPhone}
        disabledReason={disabledReason}
        savedReplies={savedReplies}
        otherCopies={canReply ? otherCopies.filter((copy) => copy.connected) : []}
      />
    </>
  );
}
