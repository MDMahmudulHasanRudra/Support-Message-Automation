"use client";

import { Check, Copy, CornerUpLeft, Forward, RotateCcw, SmilePlus, Star, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { QUICK_REACTIONS } from "@support-automation/shared";
import { EmojiPicker } from "./EmojiPicker";

/**
 * The actions of one message, opened by a long press on a touch screen or a right click with a mouse
 * (the buttons beside the bubble stay for hover and keyboard). On a phone it is a bottom sheet; with a
 * mouse it is a small menu at the pointer.
 *
 * Presentation only: it renders what the bubble already allows and calls the same handlers the inline
 * buttons call — no action exists here that the bubble did not offer, and the server still decides.
 * Rendered through a portal, because the page wrapper keeps a `transform` after its entrance animation
 * and a transformed ancestor turns `position: fixed` into "fixed to that ancestor".
 */
export interface MessageActionSheetProps {
  /** A line naming the message: who and when. */
  title: string;
  /** The first words of it, so a long press on the wrong bubble is noticed. */
  preview: string;
  /** Where a mouse opened it; null = the bottom sheet. */
  anchor: { x: number; y: number } | null;
  canReply: boolean;
  canReact: boolean;
  canCopy: boolean;
  canCancel: boolean;
  canResend: boolean;
  canForward?: boolean;
  canStar?: boolean;
  starred?: boolean;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => Promise<boolean>;
  onCancel: () => void;
  onResend: () => void;
  onForward?: () => void;
  onStar?: () => void;
  onClose: () => void;
}

const ITEM =
  "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-3 text-left text-[14px] text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:bg-[var(--color-neutral-bg)]";

export function MessageActionSheet(props: MessageActionSheetProps) {
  const { anchor, onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // Lifting the finger after a long press can raise a click on whatever is now under it — the backdrop
  // just drawn. Ignore backdrop presses for a moment, or the sheet closes the instant it opens.
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  // A mouse menu opens at the pointer, kept inside the window.
  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const { width, height } = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8)),
    });
  }, [anchor, all]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sheet = anchor === null;
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const body: ReactNode = all ? (
    <EmojiPicker
      label="React with an emoji"
      className="!w-full !border-0 !shadow-none"
      onClose={() => setAll(false)}
      onPick={(emoji) => {
        onClose();
        props.onReact(emoji);
      }}
    />
  ) : (
    <>
      {props.canReact ? (
        <div className="flex items-center justify-between gap-1 px-1 pb-2 pt-1" role="group" aria-label="Quick reactions">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={act(() => props.onReact(emoji))}
              aria-label={`React ${emoji}`}
              className="flex size-11 items-center justify-center rounded-full text-[24px] leading-none transition-transform hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:scale-90"
            >
              {emoji}
            </button>
          ))}
          <button type="button" onClick={() => setAll(true)} aria-label="More emoji" className="flex size-11 items-center justify-center rounded-full bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:scale-90">
            <SmilePlus className="size-5" aria-hidden />
          </button>
        </div>
      ) : null}
      <div className="flex flex-col">
        {props.canReply ? (
          <button type="button" className={ITEM} onClick={act(props.onReply)}>
            <CornerUpLeft className="size-[18px] text-[color:var(--color-muted-foreground)]" aria-hidden />
            Reply
          </button>
        ) : null}
        {props.canForward && props.onForward ? (
          <button type="button" className={ITEM} onClick={act(props.onForward)}>
            <Forward className="size-[18px] text-[color:var(--color-muted-foreground)]" aria-hidden />
            Forward
          </button>
        ) : null}
        {props.canStar && props.onStar ? (
          <button type="button" className={ITEM} onClick={act(props.onStar)}>
            <Star className={`size-[18px] ${props.starred ? "fill-current text-[color:var(--color-warning)]" : "text-[color:var(--color-muted-foreground)]"}`} aria-hidden />
            {props.starred ? "Unstar" : "Star"}
          </button>
        ) : null}
        {props.canCopy ? (
          <button
            type="button"
            className={ITEM}
            onClick={async () => {
              const ok = await props.onCopy();
              if (ok) {
                setCopied(true);
                setTimeout(onClose, 700);
              } else onClose();
            }}
          >
            {copied ? <Check className="size-[18px] text-[color:var(--color-success)]" aria-hidden /> : <Copy className="size-[18px] text-[color:var(--color-muted-foreground)]" aria-hidden />}
            {copied ? "Copied" : "Copy text"}
          </button>
        ) : null}
        {props.canResend ? (
          <button type="button" className={ITEM} onClick={act(props.onResend)}>
            <RotateCcw className="size-[18px] text-[color:var(--color-muted-foreground)]" aria-hidden />
            Edit and send again
          </button>
        ) : null}
        {props.canCancel ? (
          <button type="button" className={`${ITEM} text-[color:var(--color-danger-fg)]`} onClick={act(props.onCancel)}>
            <X className="size-[18px]" aria-hidden />
            Cancel before it is sent
          </button>
        ) : null}
      </div>
    </>
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[80]" onContextMenu={(e) => e.preventDefault()}>
      {/* The backdrop is the only thing that closes it by touch; it swallows the press so nothing under it fires. */}
      <div
        className={`absolute inset-0 ${sheet ? "bg-black/35 animate-sheet-fade" : ""}`}
        onClick={() => {
          if (Date.now() - openedAt.current > 400) onClose();
        }}
        onTouchMove={(e) => e.preventDefault()}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        style={sheet ? undefined : { left: position?.left ?? anchor.x, top: position?.top ?? anchor.y, visibility: position ? "visible" : "hidden" }}
        className={
          sheet
            ? "absolute inset-x-0 bottom-0 mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-[22px] border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 pt-2 shadow-[var(--shadow-lg)] animate-sheet-up pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            : "absolute w-64 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)] animate-scale-in"
        }
      >
        {sheet ? <span className="mx-auto mb-2 block h-1 w-9 rounded-full bg-[var(--color-border-strong)]" aria-hidden /> : null}
        <div className="px-3 pb-2 pt-1">
          <p className="truncate text-[11.5px] font-medium text-[color:var(--color-muted-foreground)]">{props.title}</p>
          {props.preview ? (
            <p className="mt-0.5 line-clamp-2 text-[13px] text-[color:var(--color-foreground)]" dir="auto">
              {props.preview}
            </p>
          ) : null}
        </div>
        <div className="mx-2 mb-1 h-px bg-[var(--color-border)]" aria-hidden />
        {body}
      </div>
    </div>,
    document.body,
  );
}
