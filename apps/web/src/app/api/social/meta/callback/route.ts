import { NextResponse, type NextRequest } from "next/server";
import { platformPrisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { accessibleProjects, forgetProjectAccessDecisions, runWithProject, type ActiveProject } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { publicOrigin } from "@/server/google/oauth";
import { completeSocialMetaConnection, openSocialMetaState, socialMetaCookieOptions, SOCIAL_META_STATE_COOKIE } from "@/server/social/metaConnect";
import { SocialAccountError } from "@/server/social/accounts";

/**
 * Where Meta sends the browser back after the PUBLISHING dialog (SOCIAL_STUDIO.md §Meta). One fixed
 * address for the installation, registered in the Meta app; the project comes from the sealed state
 * cookie, never from the URL. Accepted only when the cookie opens and its state equals Meta's, the person
 * signed in now is the one who started, they may still enter that project and still hold
 * `social.manage` there with Social Studio on. The cookie is cleared on every answer, so a code is
 * redeemed at most once. Never touches the messaging connections.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const params = request.nextUrl.searchParams;
  const state = openSocialMetaState(request.cookies.get(SOCIAL_META_STATE_COOKIE)?.value);
  const finish = (slug: string | null, query: string) => {
    const target = slug ? `${origin}/p/${slug}/social/accounts?${query}` : `${origin}/open?next=${encodeURIComponent(`/social/accounts?${query}`)}`;
    const response = NextResponse.redirect(target, 303);
    response.cookies.set(SOCIAL_META_STATE_COOKIE, "", socialMetaCookieOptions(0));
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  if (!state) return finish(null, "social_error=expired");
  if (params.get("state") !== state.state) return finish(state.projectSlug, "social_error=state");
  if (params.get("error")) return finish(state.projectSlug, "social_error=denied");
  const session = await getSession();
  if (!session || session.userId !== state.userId) return finish(state.projectSlug, "social_error=session");
  const project = await enterableProject(session.userId, state.projectSlug);
  if (!project) return finish(null, "social_error=permission");
  const code = params.get("code");
  if (!code || code.length > 2000) return finish(project.slug, "social_error=denied");

  return runWithProject(project, async () => {
    const access = await checkPermission("social.manage", { feature: "SOCIAL_STUDIO", sections: ["/social/accounts"] });
    if ("denied" in access) return finish(project.slug, "social_error=permission");
    try {
      const result = await completeSocialMetaConnection({ code, username: session.username });
      await logSystemEvent("INFO", "social", "Facebook / Instagram connected for publishing", result, { actorUserId: session.userId });
      return finish(project.slug, `connected=${result.active}&attention=${result.needsAttention}`);
    } catch (err) {
      // Never the message in the URL: it can carry Meta's raw response.
      await logSystemEvent("WARN", "social", "Connecting Facebook / Instagram for publishing failed", { error: (err as Error).message.slice(0, 300) }, { actorUserId: session.userId });
      return finish(project.slug, err instanceof SocialAccountError ? "social_error=meta" : "social_error=failed");
    }
  });
}

async function enterableProject(userId: string, slug: string): Promise<ActiveProject | null> {
  forgetProjectAccessDecisions();
  const project = (await accessibleProjects(userId)).find((p) => p.slug === slug);
  if (!project) return null;
  const access = await platformPrisma.projectAccess.findUnique({ where: { projectId_userId: { projectId: project.id, userId } }, select: { level: true } });
  return { ...project, accessLevel: access?.level ?? "FULL" };
}
