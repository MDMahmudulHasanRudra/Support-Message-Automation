import { Clock, MessagesSquare, PlugZap, Search, UserCheck } from "lucide-react";
import { ALL_PROJECTS_SCOPE, channelBySlug, CHANNELS, isInboxScope } from "@support-automation/shared";
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
  // The All projects inbox draws its own overview here, from the list it already holds.
  if (scope === ALL_PROJECTS_SCOPE) return null;
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
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
        <MessagesSquare className="size-5" aria-hidden />
      </span>
      <div className="max-w-xs space-y-1">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">Choose a conversation</h2>
        <p className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">Every channel opens right here, with the customer&apos;s details beside it.</p>
      </div>
      <ul className="w-full max-w-sm space-y-2 text-left">
        {[
          { icon: Clock, title: "Start with Waiting", detail: "Customers nobody has answered yet, longest wait first." },
          { icon: Search, title: "Search anything", detail: "Press / to find a name or a message." },
          { icon: UserCheck, title: "Mine is your own work", detail: "Conversations assigned to you." },
        ].map((tip) => (
          <li key={tip.title} className="flex items-start gap-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] px-3.5 py-2.5">
            <tip.icon className="mt-0.5 size-4 shrink-0 text-[color:var(--color-accent)]" aria-hidden />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[color:var(--color-foreground)]">{tip.title}</span>
              <span className="block text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">{tip.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
