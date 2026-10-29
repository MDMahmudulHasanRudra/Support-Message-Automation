import { ConversationWorkspace } from "../../../../inbox/ConversationWorkspace";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Paperclip, Settings2, Users } from "lucide-react";
import { CHANNELS, channelContentLabel, DELIVERY_STATUS_LABEL, isInboxScope } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { pageAccess, requireProjectPage } from "@/server/authorize";
import { runWithProject } from "@/server/projectContext";
import { getChannelThread, type ChannelThreadMessage } from "@/server/channels/inbox";
import { markChannelConversationRead } from "@/server/channels/replies";
import { ThreadScroller } from "../../../../chat/ThreadScroller";
import { conversationAvatar } from "../../../../chat/avatar";
import { ChannelMark } from "../../../ChannelMark";
import { ChannelComposer } from "../../../ChannelComposer";
import { ConversationControls, RetryReplyButton } from "../../../ConversationControls";

export const metadata = { title: "Conversation" };

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", weekday: "short", month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit" });

/**
 * One Messenger / Instagram / Telegram conversation: header, messages, reply box (OMNICHANNEL.md §4).
 * Everything shown is already stored — the page never calls Meta or Telegram, so it renders instantly
 * and works while a provider is having a bad day. Opening it marks it read (after the response, like
 * WhatsApp Chat, and only once the conversation is known to exist).
 */
export default async function ChannelConversationPage({ params }: { params: Promise<{ scope: string; conversationId: string }> }) {
  const { session, canManage: canReply } = await pageAccess("messages.view", "conversations.reply", "OMNICHANNEL");
  const { scope, conversationId } = await params;
  if (!isInboxScope(scope)) notFound();
  const thread = await getChannelThread(conversationId);
  if (!thread) notFound();
  const { conversation, connection, messages, hasMore } = thread;

  const project = await requireProjectPage();
  after(() => runWithProject(project, () => markChannelConversationRead(conversation.id)));

  const avatar = conversationAvatar(`ch:${conversation.id}`, conversation.title);
  const aiPaused = Boolean(conversation.aiSuppressedUntil && new Date(conversation.aiSuppressedUntil) > new Date());
  const disabledReason = !canReply ? "Your role can read conversations but not reply. Ask an administrator for “Reply on Messenger, Instagram & Telegram”." : thread.replyBlocked;
  const def = CHANNELS[conversation.type];

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <Link
          href={`/conversations/${scope}`}
          aria-label="Back to conversations"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] md:hidden"
        >
          <ArrowLeft className="size-4.5" aria-hidden />
        </Link>
        <span className="relative shrink-0">
          <span aria-hidden style={{ background: avatar.background, color: avatar.color }} className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] text-[12px] font-semibold shadow-[var(--highlight-top)]">
            {avatar.initials}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
            {conversation.kind === "GROUP" ? <Users className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Group chat" /> : null}
            <span className="truncate">{conversation.title}</span>
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            <ChannelMark channel={conversation.type} size="xs" withLabel />
            <span>via {connection.name}</span>
            {conversation.customerUsername ? <span>@{conversation.customerUsername}</span> : null}
            {conversation.assigneeName ? <span>· Assigned to {conversation.assignedUserId === session.userId ? "you" : conversation.assigneeName}</span> : null}
            {conversation.status === "CLOSED" ? <span className="rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[color:var(--color-neutral-fg)]">Closed</span> : null}
            {connection.aiAutomationEnabled && conversation.kind === "DIRECT" ? (
              <span className={`inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] px-1.5 py-px font-medium ${aiPaused ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]" : "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]"}`}>
                <Bot className="size-3" aria-hidden />
                {aiPaused ? "AI paused — a person is handling it" : "AI on"}
              </span>
            ) : null}
          </p>
        </div>
        <ConversationControls
          conversationId={conversation.id}
          status={conversation.status}
          assignedToMe={conversation.assignedUserId === session.userId}
          assigned={Boolean(conversation.assignedUserId)}
          aiPaused={aiPaused && connection.aiAutomationEnabled}
          canReply={canReply}
        />
      </header>

      <ThreadScroller key={conversation.id} latestEntryId={messages.at(-1)?.id ?? null}>
        {hasMore ? <p className="px-6 pt-4 text-center text-[11px] text-[color:var(--color-muted-foreground)]">Showing the most recent 200 messages.</p> : null}
        <ol className="space-y-1.5 px-4 py-4 sm:px-6">
          {messages.map((m, i) => {
            const day = dayFormat.format(new Date(m.occurredAt));
            const newDay = i === 0 || dayFormat.format(new Date(messages[i - 1]!.occurredAt)) !== day;
            return (
              <li key={m.id}>
                {newDay ? (
                  <div className="my-3 flex items-center gap-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
                    <span className="h-px flex-1 bg-[var(--color-border)]" />
                    {day}
                    <span className="h-px flex-1 bg-[var(--color-border)]" />
                  </div>
                ) : null}
                <Bubble message={m} channelLabel={def.label} deliveryReceipts={def.deliveryReceipts || def.readReceipts} />
              </li>
            );
          })}
        </ol>
      </ThreadScroller>

      <ChannelComposer conversationId={conversation.id} type={conversation.type} via={connection.name} disabledReason={disabledReason} humanAgentReply={thread.humanAgentReply} />
      {!canReply ? null : connection.status !== "CONNECTED" ? (
        <p className="shrink-0 px-5 pb-2 text-[11px] text-[color:var(--color-subtle-foreground)]">
          <Link href={`/settings/channels/${connection.id}`} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
            <Settings2 className="size-3" aria-hidden />
            Open {connection.name}&apos;s settings
          </Link>
        </p>
      ) : null}
      </div>
      {/* INBOX_WORKSPACE.md: notes, priority, tags, Team and the AI Copilot. */}
      <ConversationWorkspace conversation={{ kind: "channel", conversationId: conversation.id }} />
    </div>
  );
}

function Bubble({ message: m, channelLabel, deliveryReceipts }: { message: ChannelThreadMessage; channelLabel: string; deliveryReceipts: boolean }) {
  const outbound = m.direction === "OUTBOUND";
  const failed = m.deliveryStatus === "FAILED";
  const unknown = m.deliveryStatus === "UNKNOWN";
  const author =
    m.senderType === "AI" ? "AI" : m.senderType === "AGENT" ? (m.sentBy ?? "Someone here") : m.senderType === "BUSINESS" ? `Sent from ${channelLabel}'s own app` : (m.senderName ?? null);
  const StatusIcon = m.deliveryStatus === "READ" || m.deliveryStatus === "DELIVERED" ? CheckCheck : m.deliveryStatus === "SENT" ? Check : Clock;

  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[min(34rem,85%)] ${outbound ? "items-end" : "items-start"} flex flex-col`}>
        {author ? (
          <span className={`mb-0.5 inline-flex items-center gap-1 px-1 text-[10.5px] font-medium text-[color:var(--color-muted-foreground)]`}>
            {m.senderType === "AI" ? <Bot className="size-3" aria-hidden /> : null}
            {author}
            {m.messagingTag === "HUMAN_AGENT" ? <span className="font-normal text-[color:var(--color-subtle-foreground)]">· Human Agent tag</span> : null}
          </span>
        ) : null}
        <div
          className={`rounded-[var(--radius-lg)] px-3 py-2 text-[13.5px] leading-relaxed shadow-[var(--shadow-xs)] [overflow-wrap:anywhere] ${
            outbound
              ? failed
                ? "border border-dashed border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[color:var(--color-foreground)]"
                : m.deliveryStatus === "QUEUED" || m.deliveryStatus === "SENDING"
                  ? "border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[color:var(--color-foreground)]"
                  : "bg-[var(--color-primary)]/[0.08] text-[color:var(--color-foreground)] ring-1 ring-inset ring-[var(--color-primary)]/10"
              : "bg-[var(--color-surface-sunken)] text-[color:var(--color-foreground)] ring-1 ring-inset ring-[var(--color-border)]"
          }`}
        >
          {m.text ? <p className="whitespace-pre-wrap">{m.text}</p> : null}
          {m.attachments.length > 0 ? (
            <ul className={`${m.text ? "mt-1.5" : ""} space-y-1`}>
              {m.attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-muted-foreground)]">
                  <Paperclip className="size-3 shrink-0" aria-hidden />
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="link">
                      {a.name ?? channelContentLabel(a.type)}
                    </a>
                  ) : (
                    <span>
                      {a.name ?? channelContentLabel(a.type)}
                      {a.fileId ? " (open it in Telegram)" : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {!m.text && m.attachments.length === 0 ? <p className="italic text-[color:var(--color-muted-foreground)]">[{channelContentLabel(m.contentType)}]</p> : null}
        </div>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 px-1 text-[10.5px] text-[color:var(--color-subtle-foreground)]">
          <time dateTime={m.occurredAt}>{timeFormat.format(new Date(m.occurredAt))}</time>
          {outbound && m.deliveryStatus ? (
            <span className={`inline-flex items-center gap-0.5 ${failed || unknown ? "font-medium text-[color:var(--color-danger-fg)]" : ""}`}>
              {failed || unknown ? <AlertTriangle className="size-3" aria-hidden /> : <StatusIcon className="size-3" aria-hidden />}
              {/* Telegram tells bots nothing after "sent", so nothing beyond Sent is ever claimed for it. */}
              {DELIVERY_STATUS_LABEL[m.deliveryStatus === "DELIVERED" || m.deliveryStatus === "READ" ? (deliveryReceipts ? m.deliveryStatus : "SENT") : m.deliveryStatus]}
            </span>
          ) : null}
          {m.direction === "INBOUND" && m.aiOutcome && m.aiOutcome !== "REPLIED" ? (
            <span title={m.aiReason ?? undefined}>
              AI {m.aiOutcome === "HANDED_OVER" ? "handed over to the team" : "did not answer"}
              {m.aiReason ? ` — ${m.aiReason}` : ""}
            </span>
          ) : null}
        </span>
        {outbound && (failed || unknown) ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 px-1 text-[11px] text-[color:var(--color-danger-fg)]">
            {m.lastError ? <span>{m.lastError}</span> : null}
            {m.senderType !== "BUSINESS" ? <RetryReplyButton messageId={m.id} unknown={unknown} /> : null}
          </span>
        ) : m.deliveryStatus === "QUEUED" && m.lastError ? (
          <span className="mt-0.5 px-1 text-[11px] text-[color:var(--color-warning-fg)]">{m.lastError}</span>
        ) : null}
      </div>
    </div>
  );
}
