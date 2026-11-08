import { notFound } from "next/navigation";
import { CONTACT_CAMPAIGN_CHANNEL_LABEL } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { loadCampaign } from "@/server/contacts";
import { emailChannelReady } from "@/server/clientMessages";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Badge } from "@/components/ui";
import { CampaignRun } from "./CampaignRun";

export const metadata = { title: "Campaign" };

const STATUS_LABEL = { DRAFT: "Not started", RUNNING: "Running", FINISHED: "Finished" } as const;
const STATUS_COLOR = { DRAFT: "gray", RUNNING: "blue", FINISHED: "green" } as const;

export default async function ContactCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("contacts.campaign", "CONTACTS");
  const { id } = await params;
  const campaign = await loadCampaign(id);
  if (!campaign) notFound();
  const email = campaign.channel === "EMAIL" && campaign.status === "DRAFT" ? await emailChannelReady() : null;
  return (
    <div className="min-w-0">
      {campaign.counts.queued > 0 ? <AutoRefresh intervalMs={5000} /> : null}
      <div className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">
        <Link href="/contacts/campaigns" className="hover:underline">
          Campaigns
        </Link>{" "}
        / {campaign.name}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <h1 className="min-w-0 truncate text-[22px] font-semibold tracking-[-0.01em]">{campaign.name}</h1>
        <Badge color={STATUS_COLOR[campaign.status]}>{STATUS_LABEL[campaign.status]}</Badge>
        <span className="text-[13px] text-[color:var(--color-muted-foreground)]">{CONTACT_CAMPAIGN_CHANNEL_LABEL[campaign.channel]}</span>
      </div>
      <CampaignRun campaign={campaign} emailBlocked={email && !email.ready ? email.reason : null} />
    </div>
  );
}
