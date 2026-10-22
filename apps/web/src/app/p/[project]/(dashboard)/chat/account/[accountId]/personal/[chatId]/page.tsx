import { requireProjectPage } from "@/server/authorize";
import { runWithProject } from "@/server/projectContext";
import { ArrowLeft, Smartphone, User } from "lucide-react";
import Link from "@/components/ProjectLink";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { pageAccess } from "@/server/authorize";
import { getPersonalChatThread, getSavedReplies } from "@/server/chatInbox";
import { getContactProfile } from "@/server/chatProfiles";
import { ContactPanel } from "../../../../ChatInfoPanel";
import { markPersonalChatReviewed } from "@/server/actions/chatOrganisation";
import { Composer } from "../../../../Composer";
import { MarkWaitingButton } from "../../../../MarkWaitingButton";
import { MessageThread } from "../../../../MessageThread";
import { ThreadScroller } from "../../../../ThreadScroller";
import { conversationAvatar } from "../../../../avatar";
import { ConversationV2, ThreadSearchToggle } from "../../../../v2/ConversationV2";
import { PhoneChatMenu } from "../../../../v2/PhoneChatMenu";
import { ChatHeaderV2, PersonalDetail } from "../../../../v2/ChatHeaderV2";
import { attachOwnReactions, isChatUiV2Enabled, mentionNamesFor } from "@/server/chatThreadV2";
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
export default async function PersonalChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; chatId: string }>;
  /** `?contact=1` opens this person's contact panel (WHATSAPP_IDENTITY.md §7). */
  searchParams: Promise<{ contact?: string }>;
}) {
  // Its own check rather than relying on the chat layout's (see the group conversation page).
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, chatId: rawChatId } = await params;
  const { contact } = await searchParams;
  const [thread, savedReplies, v2] = await Promise.all([
    getPersonalChatThread(accountId, decodeURIComponent(rawChatId)),
    getSavedReplies(),
    // CHAT_UI_V2.md: the new conversation view, per project, off by default.
    isChatUiV2Enabled(),
  ]);
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
  const basePath = `/chat/account/${chat.accountId}/personal/${encodeURIComponent(chat.chatId)}`;
  // A personal chat's id IS the person (`…@c.us` / `…@lid`).
  const contactProfile = contact ? await getContactProfile(session, chat.accountId, chat.chatId) : null;

  // One header for both views; v2 adds its search button to it. `withSearch` is true only for v2, so
  // it also marks the v2 layout: one compact row on a phone, a round avatar, and a subline that
  // truncates instead of wrapping onto a second and third line. v1 renders exactly as before.
  const renderHeader = (withSearch: boolean) => (
      <header className={`flex shrink-0 items-center border-b border-[var(--color-border)] ${withSearch ? "gap-2 px-2 py-2 sm:gap-3 sm:px-6 sm:py-3" : "gap-3 px-4 py-3 sm:px-6"}`}>
        <Link
          href={`/chat/account/${chat.accountId}?type=personal`}
          aria-label="Back to conversations"
          className={`flex shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] md:hidden ${withSearch ? "size-10 active:bg-[var(--color-neutral-bg)]" : "size-8"}`}
        >
          <ArrowLeft className={withSearch ? "size-5" : "size-4.5"} aria-hidden />
        </Link>

        {/* The avatar and name open the contact's info, as they do in WhatsApp. */}
        <Link
          href={`${basePath}?contact=1`}
          title="Contact info"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          <span
            aria-hidden
            style={{ background: avatar.background, color: avatar.color }}
            className={`flex shrink-0 items-center justify-center text-[12px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)] ${withSearch ? "size-10 rounded-full" : "size-9 rounded-[var(--radius-lg)]"}`}
          >
            {avatar.initials}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)] hover:underline">{chat.name}</h1>
            <p className={`mt-0.5 flex items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)] ${withSearch ? "min-w-0 flex-nowrap overflow-hidden" : "flex-wrap"}`}>
              <span className={`inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px font-medium text-[color:var(--color-neutral-fg)] ${withSearch ? "min-w-0 shrink" : ""}`}>
                <Smartphone className={withSearch ? "size-3 shrink-0" : "size-3"} aria-hidden />
                <span className={withSearch ? "truncate" : undefined}>{chat.accountLabel}</span>
                <span className={`size-1.5 rounded-full ${tone.dot} ${withSearch ? "shrink-0" : ""}`} title={tone.label} aria-hidden />
              </span>
              <span className={`inline-flex items-center gap-1 ${withSearch ? "shrink-0" : ""}`}>
                <User className="size-3" aria-hidden />
                <span className={withSearch ? "max-sm:sr-only" : undefined}>Personal chat</span>
              </span>
              {number && number !== chat.name ? <span className={`tabular ${withSearch ? "truncate" : ""}`}>{number}</span> : null}
            </p>
          </div>
        </Link>

        <div className={`flex shrink-0 items-center ${withSearch ? "gap-0.5 sm:gap-2" : "gap-2"}`}>
          {withSearch ? <ThreadSearchToggle /> : null}
          {withSearch ? <PhoneChatMenu conversation={{ accountId: chat.accountId, personalChatId: chat.chatId }} accountLabel={chat.accountLabel} /> : null}
          {isUnanswered ? <MarkWaitingButton accountId={chat.accountId} chatId={chat.chatId} /> : null}
        </div>
      </header>
  );

  const disabledReason = !canReply
    ? "Your role can read conversations but not reply to them. Ask an administrator for Reply in WhatsApp Chat."
    : chat.accountStatus !== "CONNECTED"
      ? `${chat.accountLabel} is ${tone.label.toLowerCase()}, so nothing can be sent from it right now. Reconnect it on WhatsApp Accounts.`
      : null;

  if (v2) {
    const [withReactions, mentionNames] = await Promise.all([attachOwnReactions(chat.accountId, entries), mentionNamesFor(entries)]);
    return (
      <div className="relative flex min-h-0 flex-1">
        <ConversationV2
          key={chat.id}
          conversation={{ accountId: chat.accountId, personalChatId: chat.chatId }}
          isGroup={false}
          header={
            <ChatHeaderV2
              backHref={`/chat/account/${chat.accountId}?type=personal`}
              infoHref={`${basePath}?contact=1`}
              infoTitle="Contact info"
              avatar={avatar}
              isGroup={false}
              name={chat.name}
              accountLabel={chat.accountLabel}
              tone={tone}
              detail={<PersonalDetail number={number && number !== chat.name ? number : null} />}
              actions={
                <>
                  {isUnanswered ? <MarkWaitingButton accountId={chat.accountId} chatId={chat.chatId} /> : null}
                  <ThreadSearchToggle />
                  <PhoneChatMenu conversation={{ accountId: chat.accountId, personalChatId: chat.chatId }} accountLabel={chat.accountLabel} />
                </>
              }
            />
          }
          entries={withReactions}
          hasMore={hasMore}
          reviewedAt={chat.reviewedAt}
          mentionNames={mentionNames}
          accountLabel={chat.accountLabel}
          accountPhone={chat.accountPhone}
          canReply={canReply}
          disabledReason={disabledReason}
          savedReplies={savedReplies}
          otherCopies={[]}
          contactHrefBase={null}
          draftId={chat.id}
          emptyText="No messages stored for this chat yet."
        />
        {contactProfile ? <ContactPanel profile={contactProfile} accountId={chat.accountId} closeHref={basePath} /> : null}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {renderHeader(false)}

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
          disabledReason={disabledReason}
        />
      </div>

      {contactProfile ? <ContactPanel profile={contactProfile} accountId={chat.accountId} closeHref={basePath} /> : null}
    </div>
  );
}
