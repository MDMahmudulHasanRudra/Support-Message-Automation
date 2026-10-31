import Link from "@/components/ProjectLink";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { listCampaigns } from "@/server/social/library";
import { CampaignForm } from "./CampaignForm";
import { CampaignList } from "./CampaignList";

export const metadata = { title: "Social campaigns" };

/**
 * Campaigns group posts for planning and reporting (SOCIAL_STUDIO.md §Campaigns). A campaign may be
 * linked to a sales lead — offered only while the sales pipeline is on and the person may see leads.
 */
export default async function SocialCampaignsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { session, canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const includeArchived = sp.archived === "1";
  const pipelineOn = !(await activeDisabledFeatures()).has("SALES_PIPELINE") && (await hasPermission(session, "sales.view"));
  const [campaigns, leads] = await Promise.all([
    listCampaigns({ includeArchived }),
    pipelineOn ? prisma.salesLead.findMany({ where: { stage: { notIn: ["WON", "LOST"] } }, orderBy: { updatedAt: "desc" }, take: 300, select: { id: true, name: true } }) : Promise.resolve(null),
  ]);
  return (
    <div>
      <PageHeader title="Campaigns" description="Group posts by campaign to plan them together and see how each campaign did." />
      {canEdit ? (
        <Card className="mb-6 p-4">
          <SectionHeader title="New campaign" />
          <CampaignForm value={{ name: "", description: "", color: "", startsOn: "", endsOn: "", leadId: "", status: "ACTIVE" }} leads={leads} />
        </Card>
      ) : null}
      <div className="mb-3 flex items-center justify-between">
        <SectionHeader title={includeArchived ? "All campaigns" : "Active campaigns"} />
        <Link href={includeArchived ? "/social/campaigns" : "/social/campaigns?archived=1"} className="link text-sm">
          {includeArchived ? "Hide archived" : "Show archived"}
        </Link>
      </div>
      <CampaignList campaigns={campaigns} canEdit={canEdit} leads={leads} />
    </div>
  );
}
