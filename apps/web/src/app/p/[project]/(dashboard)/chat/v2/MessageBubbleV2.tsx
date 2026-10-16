"use client";

import { AlertTriangle, Check, Clock, Copy, CornerUpLeft, Loader2, RotateCcw, SmilePlus, UserRound, X } from "lucide-react";
import Link from "@/components/ProjectLink";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { isMediaPlaceholderBody, mediaCaption, QUICK_REACTIONS } from "@support-automation/shared";
import type { ThreadEntry } from "@/server/chatInbox";
import { formatDateTime, formatTime } from "@/lib/date";
import { MoodBadge } from "@/components/MoodBadge";
import { MediaNotArchived, MessageAttachment } from "../MessageAttachment";
import { AUTHOR_BADGE, QUEUED_LABEL } from "../threadPresentation";
import { EmojiPicker } from "./EmojiPicker";
import { FormattedBody } from "./FormattedBody";
import { MessageActionSheet } from "./MessageActionSheet";
import { senderColor } from "./senderColor";

/** What the bubble shows for this account's own reaction: confirmed, still with the worker, or failed. */
function reactionView(entry: ThreadEntry, overlay: string | null) {
  const server = entry.ownReaction;
  const confirmed = server?.confirmed?.emoji ?? null;
  let latest: { emoji: string; state: "sending" | "failed"; error?: string } | null = null;
  if (server?.pending) latest = { emoji: server.pending.emoji, state: "sending" };
  else if (overlay && overlay !== confirmed && overlay !== server?.failed?.emoji) latest = { emoji: overlay, state: "sending" };
  else if (server?.failed) latest = { emoji: server.failed.emoji, state: "failed", error: server.failed.error };
  return { confirmed, latest };
}

const ACTION_BTN =
  "flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]";

export function MessageBubbleV2({
  entry,
  startsRun,
  endsRun,
  isGroup,
  accountLabel,
  mentionNames,
  contactHref,
  highlighted,
  canReply,
  reactionOverlay,
  onReply,
  onReact,
  onJumpTo,
  onOpenImage,
  onResend,
  onCancelQueued,
}: {
  entry: ThreadEntry;
  startsRun: boolean;
  endsRun: boolean;
  isGroup: boolean;
  accountLabel: string;
  mentionNames: Record<string, string>;
  contactHref: (contactKey: string) => string | null;
  highlighted: boolean;
  canReply: boolean;
  reactionOverlay: string | null;
  onReply: (entry: ThreadEntry) => void;
  onReact: (entry: ThreadEntry, emoji: string) => void;
  onJumpTo: (messageId: string) => void;
  onOpenImage: (mediaId: string) => void;
  onResend: (body: string) => void;
  onCancelQueued: (outboundId: string) => void;
}) {
  const [reactOpen, setReactOpen] = useState<"quick" | "all" | null>(null);
  const [copied, setCopied] = useState(false);

  const isOutbound = entry.kind === "OUTGOING" || entry.kind === "QUEUED";
  const isStored = entry.kind === "INCOMING" || entry.kind === "OUTGOING";
  const queued = entry.kind === "QUEUED" ? QUEUED_LABEL[entry.outboundStatus ?? ""] : undefined;
  const notArchived = !entry.media && entry.kind !== "QUEUED" && isMediaPlaceholderBody(entry.body);
  const hasFile = Boolean(entry.media) || notArchived;
  const text = hasFile ? mediaCaption(entry.body, entry.media?.type ?? null) : entry.body;
  const { confirmed, latest } = reactionView(entry, reactionOverlay);
  const outboundId = entry.kind === "QUEUED" ? entry.id.replace(/^outbound-/, "") : null;
  const canCancel = entry.kind === "QUEUED" && entry.outboundStatus === "PENDING" && entry.authoredBy === "HUMAN_USER" && canReply;
  const canResend = entry.kind === "QUEUED" && queued?.tone === "bad" && entry.authoredBy === "HUMAN_USER" && canReply;
  const senderKey = entry.sender?.contactKey ?? entry.senderPhone ?? "";
  const href = entry.sender ? contactHref(entry.sender.contactKey) : null;

  async function copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(entry.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      /* clipboard refused (insecure context, permission): nothing to report beyond not showing "Copied" */
      return false;
    }
  }

  // ---- The action sheet: a long press on a touch screen, a right click with a mouse ----------------
  // Both only ever open a menu of what the buttons beside the bubble already offer. A press that moves
  // (a scroll) or ends early is not a long press, and a press on a link, button, image or media control
  // is that control's own.
  const [menu, setMenu] = useState<{ anchor: { x: number; y: number } | null } | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const hasMenu = (isStored && canReply) || (entry.body !== "" && entry.kind !== "SYSTEM") || canCancel || canResend;
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );
  const ownControl = (target: EventTarget | null) => target instanceof Element && target.closest("a, button, input, video, audio, [role='button']") !== null;
  function onTouchStart(event: ReactTouchEvent) {
    if (!hasMenu || ownControl(event.target) || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    cancelPress();
    press.current = {
      x: touch.clientX,
      y: touch.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        navigator.vibrate?.(8);
        setMenu({ anchor: null });
      }, 420),
    };
  }
  function onTouchMove(event: ReactTouchEvent) {
    const start = press.current;
    const touch = event.touches[0];
    if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8) cancelPress();
  }
  function onContextMenu(event: ReactMouseEvent) {
    if (!hasMenu || ownControl(event.target)) return;
    // Somebody who selected text and right-clicked wants the browser's own menu for it.
    if (typeof window.getSelection === "function" && window.getSelection()?.toString()) return;
    event.preventDefault();
    cancelPress();
    // A long press on Android also raises `contextmenu`; with no mouse position it is the bottom sheet.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    setMenu({ anchor: touch ? null : { x: event.clientX, y: event.clientY } });
  }
  const who = entry.kind === "OUTGOING" || entry.kind === "QUEUED" ? "You" : (entry.sender?.label ?? entry.senderName ?? entry.senderPhone ?? "");

  return (
    <div id={`msg-${entry.id}`} className={`group/bubble flex ${isOutbound ? "justify-end" : "justify-start"} scroll-mt-24`}>
      <div className={`relative flex max-w-[min(38rem,80%)] flex-col max-sm:max-w-[88%] ${isOutbound ? "items-end" : "items-start"}`}>
        {!isOutbound && startsRun ? (
          <span className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold">
            {entry.isTeamMember || entry.sender?.memberId ? <UserRound className="size-3 text-[color:var(--color-muted-foreground)]" aria-hidden /> : null}
            {href ? (
              <Link
                href={href}
                style={isGroup ? { color: senderColor(senderKey) } : undefined}
                className="rounded-[var(--radius-xs)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                title="Contact info"
              >
                {entry.sender?.label ?? entry.senderName ?? entry.senderPhone}
              </Link>
            ) : (
              <span style={isGroup ? { color: senderColor(senderKey) } : undefined}>{entry.sender?.label ?? entry.senderName ?? entry.senderPhone}</span>
            )}
            {entry.sender?.needsReview ? (
              <span
                className="rounded-[var(--radius-xs)] bg-[var(--color-warning-bg)] px-1 text-[10px] font-normal text-[color:var(--color-warning-fg)]"
                title="This WhatsApp ID matches more than one team member, so the message is credited to nobody until Team Members is corrected."
              >
                identity needs review
              </span>
            ) : null}
          </span>
        ) : null}

        <div className={`flex min-w-0 max-w-full items-start gap-1 ${isOutbound ? "flex-row-reverse" : ""}`}>
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={cancelPress}
            onTouchCancel={cancelPress}
            onContextMenu={onContextMenu}
            // Long text, URLs and phone numbers wrap inside the bubble instead of pushing it wider than
            // the screen; the press must not start a text selection or the iOS callout before the sheet.
            className={`min-w-0 [overflow-wrap:anywhere] max-sm:[-webkit-touch-callout:none] max-sm:select-none ${hasFile ? "p-1.5" : "px-3 py-2"} text-[14px] leading-[1.45] shadow-[var(--shadow-xs)] max-sm:text-[15px] transition-[box-shadow,outline-color] duration-[var(--duration-fast)] ${
              highlighted ? "outline outline-2 outline-offset-2 outline-[var(--color-accent)]" : "outline-transparent"
            } ${
              isOutbound
                ? `rounded-l-[var(--radius-xl)] rounded-br-[var(--radius-xs)] ${startsRun ? "rounded-tr-[var(--radius-xl)]" : "rounded-tr-[var(--radius-sm)]"}`
                : `rounded-r-[var(--radius-xl)] ${startsRun ? "rounded-tl-[var(--radius-xl)]" : "rounded-tl-[var(--radius-sm)]"} rounded-bl-[var(--radius-xs)]`
            } ${
              entry.kind === "QUEUED"
                ? "border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] text-[color:var(--color-neutral-fg)]"
                : isOutbound
                  ? "border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                  : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-foreground)]"
            }`}
          >
            {entry.quoted ? (
              <button
                type="button"
                onClick={() => onJumpTo(entry.quoted!.id)}
                title="Show the original message"
                className={`mb-1.5 block w-full rounded-[var(--radius-md)] border-l-[3px] border-[var(--color-accent)] px-2.5 py-1.5 text-left text-[12.5px] leading-snug ${
                  isOutbound && entry.kind !== "QUEUED" ? "bg-[var(--color-surface)]/70" : "bg-[var(--color-surface-sunken)]"
                } ${hasFile ? "mt-1" : ""} active:brightness-95 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]`}
              >
                <span className="block truncate font-semibold text-[color:var(--color-accent-fg)]">{entry.quoted.author}</span>
                <span className="line-clamp-2 opacity-80" dir="auto">
                  {entry.quoted.body}
                </span>
              </button>
            ) : null}
            {entry.media ? <MessageAttachment media={entry.media} onOpenImage={entry.media.type === "IMAGE" ? () => onOpenImage(entry.media!.id) : undefined} /> : null}
            {notArchived ? <MediaNotArchived body={entry.body} /> : null}
            {text ? (
              <div className={hasFile ? "px-2 pt-1.5 pb-0.5" : undefined}>
                <FormattedBody body={text} mentionNames={mentionNames} onDark={false} />
              </div>
            ) : null}
          </div>

          {/* The message's own actions, beside it: for a mouse (on hover) and the keyboard (on focus).
              On a touch screen they are not drawn at all — a long press opens the same actions in a sheet
              — but stay in the page for a screen reader, which has no long press either. */}
          <div className="relative flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 [@media(pointer:coarse)]:sr-only">
            {isStored && canReply ? (
              <button type="button" className={ACTION_BTN} onClick={() => onReply(entry)} aria-label="Reply">
                <CornerUpLeft className="size-3.5" aria-hidden />
              </button>
            ) : null}
            {isStored && canReply ? (
              <button type="button" className={ACTION_BTN} onClick={() => setReactOpen(reactOpen ? null : "quick")} aria-label="React" aria-expanded={reactOpen !== null}>
                <SmilePlus className="size-3.5" aria-hidden />
              </button>
            ) : null}
            {entry.body && entry.kind !== "SYSTEM" ? (
              <button type="button" className={ACTION_BTN} onClick={copy} aria-label={copied ? "Copied" : "Copy text"} title={copied ? "Copied" : "Copy text"}>
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              </button>
            ) : null}
            {canCancel && outboundId ? (
              <button type="button" className={ACTION_BTN} onClick={() => onCancelQueued(outboundId)} aria-label="Cancel this queued message" title="Cancel before it is sent">
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
            {canResend ? (
              <button type="button" className={ACTION_BTN} onClick={() => onResend(entry.body)} aria-label="Put this text back in the composer" title="Edit and send again">
                <RotateCcw className="size-3.5" aria-hidden />
              </button>
            ) : null}

            {reactOpen === "quick" ? (
              <div
                className={`absolute bottom-full z-30 mb-1 flex items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-1.5 py-1 shadow-[var(--shadow-md)] ${isOutbound ? "right-0" : "left-0"}`}
                role="menu"
                aria-label="Quick reactions"
              >
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    className="flex size-8 items-center justify-center rounded-full text-[18px] hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                    onClick={() => {
                      setReactOpen(null);
                      onReact(entry, emoji);
                    }}
                    aria-label={`React ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
                <button type="button" role="menuitem" className={ACTION_BTN} onClick={() => setReactOpen("all")} aria-label="More emoji">
                  +
                </button>
              </div>
            ) : null}
            {reactOpen === "all" ? (
              <EmojiPicker
                label="React with an emoji"
                className={`absolute bottom-full mb-1 ${isOutbound ? "right-0" : "left-0"}`}
                onClose={() => setReactOpen(null)}
                onPick={(emoji) => {
                  setReactOpen(null);
                  onReact(entry, emoji);
                }}
              />
            ) : null}
          </div>
        </div>

        {/* This account's own reaction — shown as sent only once the worker confirmed WhatsApp took it.
            Other people's reactions are not received on this connection, so none is shown. */}
        {confirmed || latest ? (
          <div className={`-mt-1 flex items-center gap-1 px-2 ${isOutbound ? "flex-row-reverse" : ""}`}>
            {confirmed && confirmed !== latest?.emoji ? (
              <span
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-1.5 py-px text-[13px] shadow-[var(--shadow-xs)]"
                title={`Your reaction from ${accountLabel} — confirmed`}
              >
                {confirmed}
              </span>
            ) : null}
            {latest ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[13px] shadow-[var(--shadow-xs)] ${
                  latest.state === "failed"
                    ? "border-[var(--color-danger-border,var(--color-border))] bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-raised)] opacity-70"
                }`}
                title={latest.state === "failed" ? `Reaction not sent: ${latest.error}` : "Sending your reaction…"}
              >
                {latest.emoji}
                {latest.state === "sending" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}
                <span className="sr-only">{latest.state === "failed" ? `not sent: ${latest.error}` : "sending"}</span>
              </span>
            ) : null}
          </div>
        ) : null}

        {entry.mood ? (
          <span className="mt-1 px-1">
            <MoodBadge mood={entry.mood.mood} confidence={entry.mood.confidence} signals={entry.mood.signals} />
          </span>
        ) : null}

        <span
          // neutral-fg, not muted: the muted slate on the sunken thread background is 4.3:1, under AA for 10 px text.
          className={`mt-1 flex max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 px-1 text-[10.5px] text-[color:var(--color-neutral-fg)] ${isOutbound ? "justify-end" : ""} ${
            endsRun || queued ? "" : "h-0 overflow-hidden opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/bubble:h-auto group-hover/bubble:opacity-100"
          }`}
          title={formatDateTime(entry.at)}
        >
          {isOutbound ? <Attribution entry={entry} accountLabel={accountLabel} /> : null}
          {queued ? (
            // The icon stays with its words when the line wraps on a narrow screen.
            <span className="inline-flex items-center gap-1">
              {queued.tone === "bad" ? <AlertTriangle className="size-3 shrink-0 text-[color:var(--color-danger)]" aria-hidden /> : <Clock className="size-3 shrink-0" aria-hidden />}
              <span className={queued.tone === "bad" ? "text-[color:var(--color-danger-fg)]" : ""}>{queued.text}</span>
            </span>
          ) : (
            <>
              <span className="tabular">{formatTime(entry.at)}</span>
              {/* One tick: stored as sent by this account. Delivery and read receipts are not recorded,
                  so no second tick is ever drawn. */}
              {entry.kind === "OUTGOING" ? <Check className="size-3" aria-label="Sent" /> : null}
            </>
          )}
        </span>

        {queued?.tone === "bad" && entry.failureReason ? (
          <span className="mt-0.5 max-w-full px-1 text-right text-[10px] leading-relaxed text-[color:var(--color-danger-fg)]">{entry.failureReason}</span>
        ) : null}
      </div>

      {menu ? (
        <MessageActionSheet
          title={`${who ? `${who} · ` : ""}${formatDateTime(entry.at)}`}
          preview={entry.body.slice(0, 160)}
          anchor={menu.anchor}
          canReply={isStored && canReply}
          canReact={isStored && canReply}
          canCopy={entry.body !== "" && entry.kind !== "SYSTEM"}
          canCancel={canCancel && Boolean(outboundId)}
          canResend={canResend}
          onReply={() => onReply(entry)}
          onReact={(emoji) => onReact(entry, emoji)}
          onCopy={copy}
          onCancel={() => outboundId && onCancelQueued(outboundId)}
          onResend={() => onResend(entry.body)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

/** "Rudra · via Primary Account", or "AI · via Primary Account". Unknown senders stay unlabelled. */
function Attribution({ entry, accountLabel }: { entry: ThreadEntry; accountLabel: string }) {
  const badge = entry.authoredBy ? AUTHOR_BADGE[entry.authoredBy] : undefined;
  const person = entry.authoredBy === "HUMAN_USER" ? entry.sentBy : null;
  if (!badge && !person) return null;
  const Icon = badge?.icon;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {person ? (
        <span className="inline-flex items-center gap-0.5 font-medium text-[color:var(--color-foreground)]" title={`Sent by ${person.name} (@${person.username})`}>
          <UserRound className="size-2.5" aria-hidden />
          {person.name}
        </span>
      ) : badge && Icon ? (
        <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1 py-px font-medium text-[color:var(--color-neutral-fg)]">
          <Icon className="size-2.5" aria-hidden />
          {badge.text}
          {entry.authoredBy === "BROADCAST" && entry.sentBy ? ` · ${entry.sentBy.name}` : ""}
        </span>
      ) : null}
      <span aria-hidden>·</span>
      <span>via {accountLabel}</span>
      <span aria-hidden>·</span>
    </span>
  );
}
