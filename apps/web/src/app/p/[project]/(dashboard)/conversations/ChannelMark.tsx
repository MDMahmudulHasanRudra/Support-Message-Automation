import { Camera, MessageCircle, MessagesSquare, Send, type LucideIcon } from "lucide-react";
import type { InboxChannel } from "@/server/channels/inbox";

/**
 * Which channel a conversation or message came from: an icon, a tint, and always a name — the tint
 * is identity (chart slots, never status colours) and is never the only signal, so the mark carries
 * an accessible label and, where there is room, the channel's name in text.
 *
 * Generic glyphs rather than the platforms' logos: the logos are trademarks, and an icon plus the
 * word is clearer at this size anyway.
 */
export const CHANNEL_PRESENTATION: Record<InboxChannel, { label: string; short: string; icon: LucideIcon; tint: string }> = {
  WHATSAPP: { label: "WhatsApp", short: "WhatsApp", icon: MessageCircle, tint: "var(--chart-3)" },
  MESSENGER: { label: "Facebook Messenger", short: "Messenger", icon: MessagesSquare, tint: "var(--chart-1)" },
  INSTAGRAM: { label: "Instagram DM", short: "Instagram", icon: Camera, tint: "var(--chart-5)" },
  TELEGRAM: { label: "Telegram", short: "Telegram", icon: Send, tint: "var(--chart-2)" },
};

export function ChannelMark({ channel, size = "sm", withLabel = false }: { channel: InboxChannel; size?: "xs" | "sm" | "md"; withLabel?: boolean }) {
  const p = CHANNEL_PRESENTATION[channel];
  const Icon = p.icon;
  const box = size === "md" ? "size-8 rounded-[var(--radius-md)]" : size === "sm" ? "size-5 rounded-[var(--radius-xs)]" : "size-4 rounded-[3px]";
  const glyph = size === "md" ? "size-4" : size === "sm" ? "size-3" : "size-2.5";
  return (
    <span className="inline-flex items-center gap-1.5" title={p.label}>
      <span
        aria-hidden
        style={{ background: `color-mix(in srgb, ${p.tint} 16%, transparent)`, color: p.tint }}
        className={`inline-flex shrink-0 items-center justify-center ${box}`}
      >
        <Icon className={glyph} strokeWidth={2.2} />
      </span>
      {withLabel ? <span className="text-[11px] font-medium text-[color:var(--color-muted-foreground)]">{p.short}</span> : <span className="sr-only">{p.label}</span>}
    </span>
  );
}
