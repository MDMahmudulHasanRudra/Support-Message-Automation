import { CHANNEL_TYPES, CHANNELS, isChannelType } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Card, PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { ChannelMark } from "../../../conversations/ChannelMark";
import { SetupGuide } from "../SetupGuide";
import { ConnectChannelForm } from "../ConnectChannelForm";

export const metadata = { title: "Connect a channel" };

/** Connect a Messenger Page, an Instagram account or a Telegram bot. Editing-only, so it needs channels.manage to open. */
export default async function NewChannelPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  await requireAccess("channels.manage", "OMNICHANNEL");
  const { type: raw } = await searchParams;
  const type = isChannelType(raw) ? raw : null;

  if (!type) {
    return (
      <div>
        <PageHeader title="Connect a channel" description="Choose what to connect. You can connect several of each." />
        <div className="grid gap-3 sm:grid-cols-3">
          {CHANNEL_TYPES.map((t) => (
            <Link key={t} href={`/settings/channels/new?type=${t}`} className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-border-strong)]">
              <ChannelMark channel={t} size="md" />
              <p className="mt-3 text-[14px] font-semibold text-[color:var(--color-foreground)]">{CHANNELS[t].label}</p>
              <p className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]">{CHANNELS[t].accountNoun}</p>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const def = CHANNELS[type];
  return (
    <div>
      <PageHeader title={`Connect ${def.label}`} description={`Connect a ${def.accountNoun}. Credentials are checked with the provider before anything is saved, stored encrypted, and never shown again.`} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <h2 className="mb-3 text-[14px] font-semibold text-[color:var(--color-foreground)]">Before you start</h2>
          <SetupGuide type={type} />
          <h3 className="mb-2 mt-5 text-[13px] font-semibold text-[color:var(--color-foreground)]">What to expect</h3>
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {def.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
        <Card>
          <ConnectChannelForm type={type} />
        </Card>
      </div>
    </div>
  );
}
