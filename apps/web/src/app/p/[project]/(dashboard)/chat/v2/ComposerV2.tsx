"use client";

import { ArrowRight, AtSign, CornerUpLeft, Info, SendHorizontal, Smartphone, Smile, X } from "lucide-react";
import Link from "@/components/ProjectLink";
import { useActionState, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MentionCandidate } from "@support-automation/shared";
import { Alert, Button, Textarea } from "@/components/ui";
import { sendChatMessage, sendPersonalChatMessage, type ChatSendState } from "@/server/actions/chat";
import { getChatMentionCandidates } from "@/server/actions/chatThread";
import type { OtherAccountCopy } from "@/server/chatInbox";
import type { ConversationRef } from "@/server/chatThreadV2";
import { SavedReplyManager } from "../SavedReplyManager";
import { SavedReplyPicker, type SavedReplyOption } from "../SavedReplyPicker";
import { EmojiPicker } from "./EmojiPicker";
import { RichComposer } from "./RichComposer";

/**
 * The v2 composer (CHAT_UI_V2.md). Everything the v1 composer does — drafts per conversation, saved
 * replies at the cursor, Enter sends / Shift+Enter breaks, phone-keyboard behaviour, the "Sending from"
 * line, the offline state with the other accounts in the group — plus:
 *   - a quoted reply: the banner above the box, and `replyTo` posted with the text;
 *   - @mentions in groups: a picker of people provably reachable by number (chatMentions.ts), the
 *     chosen ids posted as `mentions`, re-checked by the server;
 *   - an emoji picker that inserts at the cursor.
 * It still only ever writes one OutboundMessage through the same Server Action; the worker sends it.
 */

const INITIAL: ChatSendState = {};
const draftKey = (key: string) => `chat-draft:${key}`;
const MAX_COMPOSER_PX = 168;
const PHONE_QUERY = "(max-width: 639.98px)";

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function usePhoneWidth(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

export interface ReplyTarget {
  id: string;
  author: string;
  preview: string;
}

/** The "@query" being typed right before the caret, if any. */
function mentionQueryAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

export function ComposerV2({
  conversation,
  draftId,
  accountLabel,
  accountPhone,
  disabledReason,
  savedReplies,
  otherCopies = [],
  isGroup,
  replyTarget,
  onClearReply,
  insertRequest,
  onSent,
}: {
  conversation: ConversationRef;
  /** The key a draft is kept under — the same key v1 uses, so a draft survives switching views. */
  draftId: string;
  accountLabel: string;
  accountPhone: string | null;
  disabledReason?: string | null;
  savedReplies: SavedReplyOption[];
  otherCopies?: OtherAccountCopy[];
  isGroup: boolean;
  replyTarget: ReplyTarget | null;
  onClearReply: () => void;
  /** Text to put into the box (e.g. "edit and send again"), with a nonce so the same text can be asked twice. */
  insertRequest: { text: string; nonce: number } | null;
  /** Told after a send was queued, so the thread can follow it. */
  onSent: () => void;
}) {
  const send = conversation.personalChatId
    ? sendPersonalChatMessage.bind(null, conversation.accountId, conversation.personalChatId)
    : sendChatMessage.bind(null, conversation.accountId, conversation.groupId ?? "");
  const [state, formAction, pending] = useActionState(send, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [managingReplies, setManagingReplies] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const phone = usePhoneWidth();

  // Mentions: the chosen people, and the picker's state.
  const [mentions, setMentions] = useState<MentionCandidate[]>([]);
  const [candidates, setCandidates] = useState<{ list: MentionCandidate[]; unmentionable: number } | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const conflict = Boolean(replyTarget) && mentions.length > 0;

  const autoGrow = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_COMPOSER_PX)}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_COMPOSER_PX ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    autoGrow();
  }, [phone, autoGrow]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    try {
      textarea.value = window.localStorage.getItem(draftKey(draftId)) ?? "";
    } catch {
      /* private mode: a composer without drafts still works */
    }
    autoGrow();
  }, [draftId, autoGrow]);

  // Replying focuses the box, the way WhatsApp does.
  useEffect(() => {
    if (replyTarget) textareaRef.current?.focus();
  }, [replyTarget]);

  useEffect(() => {
    if (!insertRequest) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.value = insertRequest.text;
    textarea.focus();
    autoGrow();
    rememberDraft(insertRequest.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per request (nonce), by design
  }, [insertRequest?.nonce]);

  useEffect(() => {
    // Cleared only once the action resolved — resetting in onSubmit would empty the box before
    // React reads its FormData.
    if (!state.sentAt) return;
    formRef.current?.reset();
    autoGrow();
    try {
      window.localStorage.removeItem(draftKey(draftId));
    } catch {
      /* see above */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to the server's answer, once per send
    setMentions([]);
    onClearReply();
    onSent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per completed send
  }, [state.sentAt]);

  function rememberDraft(value: string) {
    try {
      if (value.trim()) window.localStorage.setItem(draftKey(draftId), value);
      else window.localStorage.removeItem(draftKey(draftId));
    } catch {
      /* see above */
    }
  }

  function insertAtCursor(insert: string, { pad = true } = {}) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const separator = pad && before && !/\s$/.test(before) ? " " : "";
    textarea.value = `${before}${separator}${insert}${after}`;
    const caret = before.length + separator.length + insert.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    autoGrow();
    rememberDraft(textarea.value);
  }

  async function ensureCandidates() {
    if (candidates || !isGroup) return;
    const result = await getChatMentionCandidates(conversation);
    if ("error" in result) setCandidateError(result.error);
    else setCandidates({ list: result.candidates, unmentionable: result.unmentionable });
  }

  const filtered = useMemo(() => {
    if (!mentionQuery || !candidates) return [];
    const q = mentionQuery.query.toLowerCase();
    return candidates.list
      .filter((c) => !mentions.some((m) => m.jid === c.jid))
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.jid.startsWith(q))
      .slice(0, 8);
  }, [mentionQuery, candidates, mentions]);

  function pickMention(candidate: MentionCandidate) {
    const textarea = textareaRef.current;
    if (!textarea || !mentionQuery) return;
    const digits = candidate.jid.split("@")[0]!;
    const caret = textarea.selectionStart ?? textarea.value.length;
    textarea.value = `${textarea.value.slice(0, mentionQuery.start)}@${digits} ${textarea.value.slice(caret)}`;
    const next = mentionQuery.start + digits.length + 2;
    textarea.focus();
    textarea.setSelectionRange(next, next);
    autoGrow();
    rememberDraft(textarea.value);
    setMentions((list) => [...list, candidate]);
    setMentionQuery(null);
  }

  function syncFromText(value: string, caret: number) {
    // A tag whose @number was deleted from the text is no longer a tag.
    setMentions((list) => list.filter((m) => value.includes(`@${m.jid.split("@")[0]}`)));
    if (!isGroup || replyTarget) {
      setMentionQuery(null);
      return;
    }
    const query = mentionQueryAt(value, caret);
    setMentionQuery(query);
    setActiveIndex(0);
    if (query) void ensureCandidates();
  }

  if (disabledReason) {
    return (
      <div className="border-t border-[var(--color-border)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        <Alert tone="warning">{disabledReason}</Alert>
        {otherCopies.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--color-muted-foreground)]">
            <span>Also in this group:</span>
            {otherCopies.map((copy) => (
              <Link
                key={copy.groupRowId}
                href={`/chat/account/${copy.accountId}/${copy.groupRowId}`}
                className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-medium text-[color:var(--color-foreground)] hover:border-[var(--color-border-strong)]"
              >
                Reply from {copy.accountLabel}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:px-2.5 sm:px-6 sm:py-3.5">
      {state.error ? (
        <div className="mb-3">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}

      <p className="mb-2 flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-[color:var(--color-muted-foreground)]">
        <Smartphone className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0">Sending from</span>
        <strong className="min-w-0 truncate font-semibold text-[color:var(--color-foreground)]">{accountLabel}</strong>
        {accountPhone ? <span className="tabular max-sm:hidden">· +{accountPhone.replace(/^\+/, "")}</span> : null}
      </p>

      {replyTarget ? (
        <div className="mb-2 flex items-start gap-2 rounded-[var(--radius-lg)] border-l-[3px] border-[var(--color-accent)] bg-[var(--color-surface-sunken)] px-3 py-2 animate-fade-in-rise">
          <CornerUpLeft className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-accent)]" aria-hidden />
          <div className="min-w-0 flex-1 text-[12px] leading-snug">
            <p className="truncate font-semibold text-[color:var(--color-accent-fg)]">Replying to {replyTarget.author}</p>
            <p className="line-clamp-2 text-[color:var(--color-muted-foreground)]" dir="auto">
              {replyTarget.preview || "Media"}
            </p>
          </div>
          <button type="button" onClick={onClearReply} className="-my-1 -mr-1.5 flex size-9 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] active:bg-[var(--color-neutral-bg)] sm:size-7" aria-label="Cancel reply">
            <X className="size-4 sm:size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {mentions.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <AtSign className="size-3 text-[color:var(--color-muted-foreground)]" aria-hidden />
          {mentions.map((m) => (
            <span key={m.jid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-bg,var(--color-neutral-bg))] px-2 py-0.5 font-medium">
              {m.label}
              <button type="button" onClick={() => setMentions((list) => list.filter((x) => x.jid !== m.jid))} aria-label={`Remove tag ${m.label}`} className="opacity-70 hover:opacity-100">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {conflict ? (
        <p className="mb-2 text-[11px] text-[color:var(--color-warning-fg)]">
          A quoted reply cannot also tag people on this WhatsApp connection. Remove the quote or the tags to send.
        </p>
      ) : null}

      <form ref={formRef} action={formAction} className="flex items-end gap-1.5 sm:gap-2">
        <label htmlFor="chat-body-v2" className="sr-only">
          Message
        </label>
        <input type="hidden" name="replyTo" value={replyTarget?.id ?? ""} />
        <input type="hidden" name="mentions" value={mentions.length ? JSON.stringify(mentions.map((m) => m.jid)) : ""} />


        {/* A poll, location or sticker: its own queued send, never part of this text (CHAT_RICH_MESSAGING.md §5). */}
        <RichComposer conversation={conversation} isGroup={isGroup} onSent={onSent} />

        {/* Hidden on a phone, where the keyboard has its own emoji key and the attach button needs the room. */}
        <div className="relative max-sm:hidden">
          <button
            type="button"
            onClick={() => setEmojiOpen((v) => !v)}
            className="flex size-11 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:bg-[var(--color-neutral-bg)] sm:size-11 sm:border sm:border-[var(--color-border)] sm:bg-[var(--color-surface)] sm:hover:border-[var(--color-border-strong)]"
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
          >
            <Smile className="size-4.5" aria-hidden />
          </button>
          {emojiOpen ? (
            <EmojiPicker
              className="absolute bottom-full left-0 mb-2"
              onClose={() => setEmojiOpen(false)}
              onPick={(emoji) => {
                insertAtCursor(emoji, { pad: false });
                setEmojiOpen(false);
              }}
            />
          ) : null}
        </div>

        <SavedReplyPicker quiet replies={savedReplies} onInsert={(body) => insertAtCursor(body)} onManage={() => setManagingReplies(true)} />

        <div className="relative min-w-0 flex-1">
          {mentionQuery && (filtered.length || candidateError || candidates) ? (
            <div
              role="listbox"
              aria-label="People to tag"
              className="absolute bottom-full left-0 z-30 mb-2 w-[min(20rem,100%)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-lg)]"
            >
              {candidateError ? <p className="px-3 py-2 text-[12px] text-[color:var(--color-danger-fg)]">{candidateError}</p> : null}
              {filtered.map((c, i) => (
                <button
                  key={c.jid}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickMention(c)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] ${i === activeIndex ? "bg-[var(--color-neutral-bg)]" : "hover:bg-[var(--color-neutral-bg)]"}`}
                >
                  <span className="truncate font-medium">{c.label}</span>
                  <span className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]">{c.source === "TEAM_MEMBER" ? "Team" : "Wrote here"}</span>
                </button>
              ))}
              {candidates && filtered.length === 0 && !candidateError ? (
                <p className="px-3 py-2 text-[12px] text-[color:var(--color-muted-foreground)]">Nobody matching who can be tagged.</p>
              ) : null}
              {candidates && candidates.unmentionable > 0 ? (
                <p className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10.5px] leading-snug text-[color:var(--color-muted-foreground)]">
                  {candidates.unmentionable} other {candidates.unmentionable === 1 ? "person" : "people"} in this group cannot be tagged: WhatsApp shows them by a private id, not a number.
                </p>
              ) : null}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            id="chat-body-v2"
            name="body"
            rows={1}
            required
            maxLength={4096}
            placeholder={phone ? "Message" : isGroup ? "Type a message…  (@ to tag, Shift+Enter for a new line)" : "Type a message…  (Shift+Enter for a new line)"}
            enterKeyHint={phone ? "enter" : "send"}
            className="min-h-10 w-full resize-none py-2.5 transition-[height] duration-[var(--duration-fast)] ease-[var(--ease-out)] max-sm:min-h-11 max-sm:rounded-[22px] max-sm:px-4 max-sm:py-3 max-sm:text-base sm:min-h-12 sm:rounded-[var(--radius-lg)] sm:px-4 sm:py-3 sm:text-[14px] focus-visible:border-[var(--wa-green)] focus-visible:ring-[var(--wa-green)]/15"
            onChange={(event) => {
              autoGrow();
              rememberDraft(event.target.value);
              syncFromText(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyDown={(event) => {
              if (mentionQuery && filtered.length) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((i) => (i + (event.key === "ArrowDown" ? 1 : filtered.length - 1)) % filtered.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  pickMention(filtered[activeIndex] ?? filtered[0]!);
                  return;
                }
              }
              if (event.key === "Escape") {
                if (mentionQuery) setMentionQuery(null);
                else if (replyTarget) onClearReply();
                return;
              }
              if (pending || conflict) {
                if (event.key === "Enter" && !event.shiftKey) event.preventDefault();
                return;
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                formRef.current?.requestSubmit();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !phone) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />
        </div>

        <Button type="submit" loading={pending} disabled={pending || conflict} aria-label="Send message" className="h-10 shrink-0 self-end px-3.5 !bg-[var(--wa-green-strong)] !text-[var(--wa-on-green)] hover:!bg-[var(--wa-green-hover)] max-sm:size-11 max-sm:rounded-full max-sm:px-0 sm:h-12 sm:rounded-[var(--radius-lg)] sm:px-5">
          {pending ? null : <SendHorizontal className="size-4" aria-hidden />}
        </Button>
      </form>

      <p className="mt-2.5 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--wa-green-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[color:var(--color-foreground)] max-sm:hidden">
        <Info className="mt-0.5 size-3.5 shrink-0 text-[color:var(--wa-green-strong)]" aria-hidden />
        <span>Sent through the same outbound queue as automated replies, so account rate limits still apply. A reply quotes the original on WhatsApp once it is delivered.</span>
      </p>

      <SavedReplyManager open={managingReplies} onClose={() => setManagingReplies(false)} replies={savedReplies} />
    </div>
  );
}
