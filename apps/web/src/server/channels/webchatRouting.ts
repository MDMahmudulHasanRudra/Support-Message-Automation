import { Prisma } from "@prisma/client";
import { loadRoutingPool, noteUnrouted, readRoutingSettings, routeConversation } from "@support-automation/db";
import { businessHoursStatus, pickWebchatRoute, routingCovers } from "@support-automation/shared";
import { platformPrisma, prisma } from "@/server/db";
import { runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { tenantOfCustomer } from "@/server/tenant";
import type { PublicWidget, Visitor } from "@/server/channels/webchat";

/**
 * A website chat's first stop (WEBSITE_CHAT.md §Routing). Runs in the web app on the visitor's first message, BEFORE the
 * message is recorded for the worker: it opens the conversation itself with the rule's Team or person already set, so the
 * worker finds it held and its automatic routing leaves it alone. Nothing in the worker changes.
 *
 * With no matching rule it does nothing and the worker opens the conversation as ever. It never throws: a customer's
 * message must get through whatever happens to a routing rule.
 */
export async function routeNewWebchatConversation(widget: PublicWidget, visitor: Visitor, input: { pageUrl: string | null; now: Date }): Promise<void> {
  const rules = widget.settings.routing;
  if (!rules.some((r) => r.enabled)) return;
  try {
    const existing = await platformPrisma.channelConversation.findFirst({ where: { connectionId: widget.connectionId, externalThreadId: visitor.id }, select: { id: true } });
    if (existing) return;
    const stored = await platformPrisma.webChatVisitor.findUnique({ where: { id: visitor.id }, select: { customAnswers: true, firstPageUrl: true } });
    const answers = Array.isArray(stored?.customAnswers) ? (stored.customAnswers as Array<{ key?: string; value: string }>) : [];
    const page = input.pageUrl ?? stored?.firstPageUrl ?? null;
    let path: string | null = null;
    if (page) {
      try {
        path = new URL(page).pathname;
      } catch {
        path = null;
      }
    }
    const rule = pickWebchatRoute(rules, { path, answers, online: businessHoursStatus(widget.settings.hours, input.now).open });
    if (!rule) return;

    // A Team or person removed since the rule was saved is skipped, never an error for the visitor.
    const [team, user] = await Promise.all([
      rule.teamId ? platformPrisma.team.findFirst({ where: { id: rule.teamId, projectId: widget.projectId, status: "ACTIVE" }, select: { id: true } }) : null,
      rule.userId ? platformPrisma.projectAccess.findFirst({ where: { projectId: widget.projectId, userId: rule.userId, user: { isActive: true } }, select: { userId: true } }) : null,
    ]);
    if (!team && !user) return;

    const name = visitor.name ? (visitor.verified ? visitor.name : `${visitor.name} (unverified)`) : null;
    let conversationId: string;
    try {
      const created = await platformPrisma.channelConversation.create({
        data: {
          projectId: widget.projectId,
          connectionId: widget.connectionId,
          type: "WEBCHAT",
          externalThreadId: visitor.id,
          kind: "DIRECT",
          title: name ?? "Website visitor",
          customerExternalId: visitor.id,
          customerName: name,
          assignedTeamId: team?.id ?? null,
          assignedUserId: user?.userId ?? null,
        },
        select: { id: true },
      });
      conversationId = created.id;
    } catch (err) {
      // A second message at the same moment opened it: that one's routing stands.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      throw err;
    }

    const context = { reason: "WEBSITE_RULE", rule: rule.name };
    const base = { projectId: widget.projectId, channelConversationId: conversationId, fromValue: null, actorId: null, context };
    await platformPrisma.conversationEvent.createMany({
      data: [...(team ? [{ ...base, kind: "TEAM", toValue: team.id }] : []), ...(user ? [{ ...base, kind: "ASSIGNEE", toValue: user.userId }] : [])],
    });
    if (team && !user) await pickPersonInTeam(widget.projectId, conversationId, team.id, input.now);
  } catch (err) {
    console.error("[webchat] routing rule could not be applied", (err as Error).name);
  }
}

/**
 * A Team rule with Automatic routing switched on: the same picking as everywhere (method, capacity, on duty), from
 * this Team only. Nobody eligible leaves it with the Team, where the worker's own routing can still give it to somebody.
 */
async function pickPersonInTeam(projectId: string, conversationId: string, teamId: string, now: Date): Promise<void> {
  const row = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true } });
  if (!row) return;
  const project = { id: row.id, slug: row.slug, name: row.name, status: row.status, tenant: await tenantOfCustomer(row.customerId) };
  await runWithProject(project, async () => {
    const off = await disabledFeaturesFor(projectId);
    if (off.has("AUTO_ROUTING") || off.has("UNIFIED_INBOX_V3")) return;
    const settings = await readRoutingSettings(prisma);
    if (!settings?.enabled || !routingCovers(settings, "WEBCHAT")) return;
    const pool = await loadRoutingPool(prisma, projectId, { poolTeamIds: [teamId], poolUserIds: [] }, now);
    const result = await routeConversation(prisma, { projectId, target: { kind: "channel", conversationId }, kind: "WEBCHAT", settings, method: settings.method, pool, via: "AUTOMATIC", actorId: null, now });
    if (result.outcome === "NOBODY_ELIGIBLE") await noteUnrouted(prisma, result.reasons, now);
  });
}
