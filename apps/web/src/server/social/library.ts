import { extractHashtags } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { SocialRefusal } from "./posts";

/**
 * Social Studio's reusable content (SOCIAL_STUDIO.md §Library): campaigns that group posts (optionally
 * linked to a sales lead), and text templates, signatures and hashtag sets. All project-scoped; nothing
 * here publishes anything.
 */

const COLOR = /^#[0-9a-f]{6}$/i;
export const SOCIAL_TEMPLATE_KINDS = ["TEMPLATE", "SIGNATURE", "HASHTAGS"] as const;
export type SocialTemplateKind = (typeof SOCIAL_TEMPLATE_KINDS)[number];
export const SOCIAL_TEMPLATE_KIND_LABELS: Record<SocialTemplateKind, string> = { TEMPLATE: "Post template", SIGNATURE: "Signature", HASHTAGS: "Hashtag set" };

export interface CampaignInput {
  name: string;
  description: string | null;
  color: string | null;
  startsOn: Date | null;
  endsOn: Date | null;
  leadId: string | null;
}

async function checkCampaign(input: CampaignInput): Promise<void> {
  if (!input.name.trim()) throw new SocialRefusal("Give the campaign a name.");
  if (input.color && !COLOR.test(input.color)) throw new SocialRefusal("Choose a colour like #4f46e5.");
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw new SocialRefusal("The campaign ends before it starts.");
  if (input.leadId) {
    // A lead link is offered only while the sales pipeline is on; the lead must be this project's.
    if ((await activeDisabledFeatures()).has("SALES_PIPELINE")) throw new SocialRefusal("The sales pipeline is switched off in this project.");
    if (!(await prisma.salesLead.findFirst({ where: { id: input.leadId }, select: { id: true } }))) throw new SocialRefusal("That lead does not exist in this project.");
  }
}

export async function createCampaign(input: CampaignInput, username: string) {
  await checkCampaign(input);
  return prisma.socialCampaign.create({
    data: { name: input.name.trim().slice(0, 120), description: input.description?.trim().slice(0, 1000) || null, color: input.color, startsOn: input.startsOn, endsOn: input.endsOn, leadId: input.leadId, createdByUsername: username },
    select: { id: true },
  });
}

export async function updateCampaign(id: string, input: CampaignInput & { status?: "ACTIVE" | "ARCHIVED" }) {
  await checkCampaign(input);
  const updated = await prisma.socialCampaign.updateMany({
    where: { id },
    data: {
      name: input.name.trim().slice(0, 120),
      description: input.description?.trim().slice(0, 1000) || null,
      color: input.color,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      leadId: input.leadId,
      ...(input.status ? { status: input.status } : {}),
    },
  });
  if (updated.count === 0) throw new SocialRefusal("That campaign no longer exists.");
}

export async function listCampaigns(opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.socialCampaign.findMany({
    where: opts.includeArchived ? {} : { status: "ACTIVE" },
    orderBy: [{ status: "asc" }, { startsOn: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 500,
    include: { lead: { select: { id: true, name: true } }, _count: { select: { posts: true } } },
  });
  const ids = rows.map((r) => r.id);
  const published = ids.length
    ? await prisma.socialPost.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, status: { in: ["PUBLISHED", "PARTIAL"] } }, _count: { _all: true } })
    : [];
  const byCampaign = new Map(published.map((p) => [p.campaignId, p._count._all]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    startsOn: r.startsOn?.toISOString() ?? null,
    endsOn: r.endsOn?.toISOString() ?? null,
    status: r.status,
    lead: r.lead,
    posts: r._count.posts,
    published: byCampaign.get(r.id) ?? 0,
    createdByUsername: r.createdByUsername,
  }));
}

export async function getCampaign(id: string) {
  return prisma.socialCampaign.findFirst({ where: { id }, include: { lead: { select: { id: true, name: true } } } });
}

// ── Templates, signatures, hashtag sets ─────────────────────────────────────────────────────────

export async function listTemplates(kind?: SocialTemplateKind) {
  return prisma.socialTemplate.findMany({ where: kind ? { kind } : {}, orderBy: [{ kind: "asc" }, { name: "asc" }], take: 500 });
}

export async function saveTemplate(input: { id?: string; kind: SocialTemplateKind; name: string; content: string }, username: string) {
  const name = input.name.trim().slice(0, 120);
  const content = input.content.trim();
  if (!name) throw new SocialRefusal("Give it a name.");
  if (!content) throw new SocialRefusal("Write its text.");
  if (content.length > 10_000) throw new SocialRefusal("The text is too long.");
  if (input.kind === "HASHTAGS" && !/#/.test(content)) throw new SocialRefusal("A hashtag set needs at least one #hashtag.");
  if (!input.id) return prisma.socialTemplate.create({ data: { kind: input.kind, name, content, createdByUsername: username }, select: { id: true } });
  const updated = await prisma.socialTemplate.updateMany({ where: { id: input.id }, data: { kind: input.kind, name, content, updatedByUsername: username } });
  if (updated.count === 0) throw new SocialRefusal("That template no longer exists.");
  return { id: input.id };
}

export async function deleteTemplate(id: string) {
  const removed = await prisma.socialTemplate.deleteMany({ where: { id } });
  if (removed.count === 0) throw new SocialRefusal("That template no longer exists.");
}

/** The hashtags this project's posts used in the last `days`, most used first. Counted, never guessed. */
export async function recentHashtags(days: number, limit: number): Promise<Array<[string, number]>> {
  const recent = await prisma.socialPost.findMany({ where: { updatedAt: { gte: new Date(Date.now() - days * 86_400_000) } }, select: { content: true, targets: { select: { contentOverride: true } } }, take: 1000, orderBy: { updatedAt: "desc" } });
  const counts = new Map<string, number>();
  for (const p of recent) {
    const tags = new Set([...extractHashtags(p.content), ...p.targets.flatMap((t) => (t.contentOverride ? extractHashtags(t.contentOverride) : []))]);
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
