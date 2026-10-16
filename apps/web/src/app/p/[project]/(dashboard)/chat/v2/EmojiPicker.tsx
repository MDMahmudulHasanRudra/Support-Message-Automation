"use client";

import { useEffect, useRef } from "react";

/**
 * A small, dependency-free emoji grid: the set support conversations actually use, not the whole
 * Unicode catalogue. Used by the composer (inserts at the cursor) and by the reaction picker (one
 * emoji per reaction). A full picker library would add hundreds of kilobytes for a grid somebody opens
 * to find a thumbs-up.
 */
export const EMOJI_GROUPS: ReadonlyArray<{ label: string; emojis: readonly string[] }> = [
  { label: "Common", emojis: ["👍", "❤️", "😂", "😮", "😢", "🙏", "👏", "🙌", "🎉", "✅", "❌", "⚠️", "🔥", "💯", "👌", "🤝"] },
  { label: "Faces", emojis: ["😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍", "🤗", "🤔", "😐", "😕", "😟", "😔", "😭", "😡", "😴", "🤒", "😅", "😇"] },
  { label: "Support", emojis: ["📞", "📱", "💬", "📧", "📎", "📄", "🧾", "💳", "💰", "🕒", "📅", "🔧", "🛠️", "📶", "🌐", "🔌", "🔒", "🔑", "🚚", "📍"] },
  { label: "Gestures", emojis: ["👋", "✋", "👊", "✌️", "🤞", "👉", "👈", "☝️", "👇", "💪", "🙆", "🙋", "🤷", "🙇", "👀", "🫡"] },
  { label: "Symbols", emojis: ["⭐", "✨", "⚡", "💡", "📌", "🔔", "🔴", "🟢", "🟡", "🔵", "⬆️", "⬇️", "➡️", "⬅️", "🆗", "🆕"] },
];

export function EmojiPicker({
  onPick,
  onClose,
  label = "Choose an emoji",
  className = "",
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Closes on Escape and on a press outside, like every popover in this app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`z-30 w-[min(19rem,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 shadow-[var(--shadow-lg)] ${className}`}
    >
      <div className="max-h-64 overflow-y-auto pr-1">
        {EMOJI_GROUPS.map((group) => (
          <div key={group.label} className="mb-1.5">
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">{group.label}</p>
            <div className="grid grid-cols-8 gap-0.5">
              {group.emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onPick(emoji)}
                  className="flex aspect-square items-center justify-center rounded-[var(--radius-sm)] text-[18px] leading-none hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                  aria-label={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
