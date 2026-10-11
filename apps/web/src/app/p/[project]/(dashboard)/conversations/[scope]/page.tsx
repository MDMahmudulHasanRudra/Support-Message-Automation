import { MessagesSquare, PlugZap } from "lucide-react";
import { channelBySlug, CHANNELS, isInboxScope } from "@support-automation/shared";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { connectionSummary } from "@/server/channels/inbox";
import { ChannelMark } from "../ChannelMark";

export const metadata = { title: "Conversations" };

/**
 * The right-hand pane before a conversation is chosen. For a channel nobody has connected yet it
 * says how to connect one instead — an unconfigured channel never pretends to be an empty inbox.
 */
export default async function InboxEmptyPane({ params }: { params: Promise<{ scope: string }> }) {
  const session = await requireAccess("messages.view", "OMNICHANNEL");
  const { scope } = await params;
  if (!isInboxScope(scope)) notFound();
  const type = channelBySlug(scope);
  const connections = await connectionSummary();
  const canManage = await hasPermission(session, "channels.manage");

  if (type && connections[type].total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <ChannelMark channel={type} size="md" />
        <div className="max-w-sm space-y-1.5">
          <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{CHANNELS[type].label} is not connected</h2>
          <p className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Connect a {CHANNELS[type].accountNoun} and its conversations appear here and under All, beside WhatsApp.
          </p>
        </div>
        {canManage ? (
          <ButtonLink href={`/settings/channels/new?type=${type}`} variant="primary" size="md">
            <PlugZap className="size-4" aria-hidden />
            Connect {CHANNELS[type].label}
          </ButtonLink>
        ) : (
          <p className="text-[12px] text-[color:var(--color-subtle-foreground)]">Ask someone who can manage Messaging Channels to connect it.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]">
        <MessagesSquare className="size-5" aria-hidden />
      </span>
      <p className="max-w-xs text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        Choose a conversation. WhatsApp conversations open in WhatsApp Chat; Messenger, Instagram and Telegram open here.
      </p>
    </div>
  );
}
