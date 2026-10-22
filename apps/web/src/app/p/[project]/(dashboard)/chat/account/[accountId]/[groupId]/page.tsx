import { requireProjectPage } from "@/server/authorize";
import { runWithProject } from "@/server/projectContext";
import { ArrowLeft, Bot, ExternalLink, Smartphone, Users } from "lucide-react";
import Link from "@/components/ProjectLink";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { Badge } from "@/components/ui";
import { MoodBadge } from "@/components/MoodBadge";
import { pageAccess } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { getChatThread, getOtherAccountCopies, getSavedReplies } from "@/server/chatInbox";
import { getContactProfile, getGroupProfile } from "@/server/chatProfiles";
import { ContactPanel, GroupPanel } from "../../../ChatInfoPanel";
import { markChatReviewed } from "@/server/actions/chatOrganisation";
import { Composer } from "../../../Composer";
import { MarkWaitingButton } from "../../../MarkWaitingButton";
import { AiActiveNotice, MessageThread } from "../../../MessageThread";
import { ThreadScroller } from "../../../ThreadScroller";
import { conversationAvatar } from "../../../avatar";
import { AvatarFace } from "../../../AvatarFace";
import { picturePaths } from "@/server/whatsappPictures";
import { ConversationV2, ThreadSearchToggle } from "../../../v2/ConversationV2";
import { PhoneChatMenu } from "../../../v2/PhoneChatMenu";
import { ChatHeaderV2, MemberCount } from "../../../v2/ChatHeaderV2";
import { MonitoringPill } from "../../../v2/MonitoringPill";
import { attachOwnReactions, isChatUiV2Enabled, mentionNamesFor } from "@/server/chatThreadV2";
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
  searchParams,
}: {
  params: Promise<{ accountId: string; groupId: string }>;
  /** `?info=group` opens the group panel, `?contact=<WhatsApp id>` a contact's (WHATSAPP_IDENTITY.md §7). */
  searchParams: Promise<{ info?: string; contact?: string }>;
}) {
  // Its own check rather than relying on the chat layout's: Next does not re-render a layout on
  // navigation within it, so a layout-only check would miss a role changed mid-session.
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, groupId } = await params;
  const { info, contact } = await searchParams;
  const [thread, savedReplies, otherCopies, v2] = await Promise.all([
    getChatThread(groupId),
    getSavedReplies(),
    getOtherAccountCopies(groupId),
    // CHAT_UI_V2.md: the new conversation view, per project, off by default.
    isChatUiV2Enabled(),
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

  // The panels are URL state: a real link opens one, the back button closes it.
  const basePath = `/chat/account/${group.accountId}/${group.id}`;
  const contactHref = (key: string) => `${basePath}?contact=${encodeURIComponent(key)}`;
  const contactKey = typeof contact === "string" && contact.length <= 200 ? contact : null;
  const [contactProfile, groupProfile] = await Promise.all([
    contactKey ? getContactProfile(session, group.accountId, contactKey) : null,
    !contactKey && info === "group" ? getGroupProfile(session, group.id) : null,
  ]);
  // Stored WhatsApp pictures for the group and an open contact (WHATSAPP_AVATARS.md); empty when off.
  const pictures = await picturePaths(group.accountId, [group.whatsappGroupId, contactProfile?.senderId ?? ""]);

  // First, because it is about the person rather than the conversation: nothing below matters to
  // somebody whose role cannot send at all.
  const disabledReason = !canReply
    ? "Your role can read conversations but not reply to them. Ask an administrator for Reply in WhatsApp Chat."
    : !group.isActive
      ? `${group.accountLabel} is no longer a member of ${group.name}, so nothing can be sent from it. Resync groups if it has been re-added.`
      : group.accountStatus !== "CONNECTED"
        ? `${group.accountLabel} is ${tone.label.toLowerCase()}, so nothing can be sent from it right now. Reconnect it on WhatsApp Accounts.`
        : null;

  // One header for both views; v2 adds its search button to it. `withSearch` is true only for v2, so
  // it also marks the v2 layout: one compact row on a phone, a round avatar, and a subline that
  // truncates instead of wrapping onto a second and third line. v1 renders exactly as before.
  const renderHeader = (withSearch: boolean) => (
      <header className={`flex shrink-0 items-center border-b border-[var(--color-border)] ${withSearch ? "gap-2 px-2 py-2 sm:gap-3 sm:px-6 sm:py-3" : "gap-3 px-4 py-3 sm:px-6"}`}>
        <Link
          href={`/chat/account/${group.accountId}`}
          aria-label="Back to conversations"
          className={`flex shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] md:hidden ${withSearch ? "size-10 active:bg-[var(--color-neutral-bg)]" : "size-8"}`}
        >
          <ArrowLeft className={withSearch ? "size-5" : "size-4.5"} aria-hidden />
        </Link>

        {/* The avatar and name open the group's info, as they do in WhatsApp. */}
        <Link
          href={`${basePath}?info=group`}
          title="Group info"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          <span
            aria-hidden
            style={{ background: avatar.background, color: avatar.color }}
            className={`relative flex shrink-0 items-center justify-center overflow-hidden text-[12px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)] ${withSearch ? "size-10 rounded-full" : "size-9 rounded-[var(--radius-lg)]"}`}
          >
            <AvatarFace path={pictures[group.whatsappGroupId]}>{avatar.initials}</AvatarFace>
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)] hover:underline">{group.name}</h1>
            <p className={`mt-0.5 flex items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)] ${withSearch ? "min-w-0 flex-nowrap overflow-hidden" : "flex-wrap"}`}>
              {/* Which number this conversation, and every reply typed below, belongs to. */}
              <span className={`inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px font-medium text-[color:var(--color-neutral-fg)] ${withSearch ? "min-w-0 shrink" : ""}`}>
                <Smartphone className={withSearch ? "size-3 shrink-0" : "size-3"} aria-hidden />
                <span className={withSearch ? "truncate" : undefined}>{group.accountLabel}</span>
                <span className={`size-1.5 rounded-full ${tone.dot} ${withSearch ? "shrink-0" : ""}`} title={tone.label} aria-hidden />
              </span>
              {group.participantCount !== null ? (
                <span className={`inline-flex items-center gap-1 ${withSearch ? "shrink-0" : ""}`}>
                  <Users className="size-3" aria-hidden />
                  {group.participantCount}
                </span>
              ) : null}
            </p>
          </div>
        </Link>

        <div className={`flex shrink-0 items-center ${withSearch ? "gap-0.5 sm:gap-2" : "gap-2"}`}>
          {group.mood ? <MoodBadge mood={group.mood} /> : null}
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
          {withSearch ? <ThreadSearchToggle /> : null}
          {withSearch ? <PhoneChatMenu conversation={{ accountId: group.accountId, groupId: group.id }} accountLabel={group.accountLabel} /> : null}
          {isUnanswered ? <MarkWaitingButton groupId={group.id} /> : null}
          <Link
            href="/groups"
            title="Open this group's settings"
            className={`flex items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] ${withSearch ? "size-10 sm:size-8" : "size-8"}`}
          >
            <ExternalLink className="size-4" aria-hidden />
            <span className="sr-only">Group settings</span>
          </Link>
        </div>
      </header>
  );

  const otherCopiesForReply = canReply ? otherCopies.filter((copy) => copy.connected) : [];
  const contactPanels = (
    <>
      {contactProfile ? <ContactPanel profile={contactProfile} accountId={group.accountId} closeHref={basePath} picturePath={pictures[contactProfile.senderId]} /> : null}
      {groupProfile ? <GroupPanel profile={groupProfile} contactHref={contactHref} closeHref={basePath} picturePath={pictures[group.whatsappGroupId]} /> : null}
    </>
  );

  if (v2) {
    const [withReactions, mentionNames] = await Promise.all([attachOwnReactions(group.accountId, entries), mentionNamesFor(entries)]);
    return (
      <div className="relative flex min-h-0 flex-1">
        <ConversationV2
          key={group.id}
          conversation={{ accountId: group.accountId, groupId: group.id }}
          isGroup
          header={
            <ChatHeaderV2
              backHref={`/chat/account/${group.accountId}`}
              infoHref={`${basePath}?info=group`}
              infoTitle="Group info"
              avatar={avatar}
              picturePath={pictures[group.whatsappGroupId]}
              isGroup
              name={group.name}
              accountLabel={group.accountLabel}
              tone={tone}
              detail={<MemberCount count={group.participantCount} />}
              actions={
                <>
                  {group.mood ? <MoodBadge mood={group.mood} /> : null}
                  {group.aiAutomationEnabled ? (
                    <span className="hidden lg:inline">
                      <Badge color="blue" dot>
                        <Bot className="size-3" aria-hidden />
                        AI
                      </Badge>
                    </span>
                  ) : null}
                  <MonitoringPill monitored={group.isMonitored} aiOn={group.aiAutomationEnabled} />
                  {isUnanswered ? <MarkWaitingButton groupId={group.id} /> : null}
                  <ThreadSearchToggle />
                  <PhoneChatMenu conversation={{ accountId: group.accountId, groupId: group.id }} accountLabel={group.accountLabel} />
                </>
              }
            />
          }
          belowThread={group.aiAutomationEnabled ? <AiActiveNotice suppressedUntil={group.aiSuppressedUntil} compact /> : null}
          entries={withReactions}
          hasMore={hasMore}
          reviewedAt={group.reviewedAt}
          mentionNames={mentionNames}
          accountLabel={group.accountLabel}
          accountPhone={group.accountPhone}
          canReply={canReply}
          disabledReason={disabledReason}
          savedReplies={savedReplies}
          otherCopies={otherCopiesForReply}
          contactHrefBase={basePath}
          draftId={group.id}
          emptyText="No messages stored for this group yet. Anything sent or received from now on appears here."
        />
        {contactPanels}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {renderHeader(false)}

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
          <MessageThread entries={entries} accountLabel={group.accountLabel} contactHref={contactHref} />
        </ThreadScroller>

        {group.aiAutomationEnabled ? <AiActiveNotice suppressedUntil={group.aiSuppressedUntil} /> : null}
        <Composer
          accountId={group.accountId}
          groupId={group.id}
          accountLabel={group.accountLabel}
          accountPhone={group.accountPhone}
          disabledReason={disabledReason}
          savedReplies={savedReplies}
          otherCopies={otherCopiesForReply}
        />
      </div>

      {contactPanels}
    </div>
  );
}
