import { NextResponse, type NextRequest } from "next/server";
import { platformPrisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { accessibleProjects, forgetProjectAccessDecisions, runWithProject, type ActiveProject } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { completeGoogleConnection, GoogleConnectionError } from "@/server/google/accounts";
import { syncAccountSpreadsheets } from "@/server/google/spreadsheets";
import { completeIdentityLink, GoogleIdentityError } from "@/server/google/identity";
import { openOAuthState, publicOrigin, STATE_COOKIE, stateCookieOptions } from "@/server/google/oauth";
import { resolveProjectGoogleClient } from "@/server/google/clientConfig";

/**
 * Where Google sends the browser back after consent (GOOGLE_SHEETS.md, Phase 1). ONE fixed address
 * for the whole installation, registered once in Google Cloud; the project comes from the sealed
 * state cookie, never from anything in the URL.
 *
 * Accepted only when ALL of these hold, and each failure lands back on the settings page with a
 * reason rather than a stack trace:
 *   - the state cookie opens (ours, unexpired, untampered) and its state equals Google's `state`;
 *   - the person signed in now is the person who pressed Connect;
 *   - they may still enter that project, and still hold `google_sheets.manage` there with the
 *     Google Sheets feature on — checked again, at their own access level, inside the project;
 *   - Google returned a code (not `access_denied`), and the grant covers what the module needs.
 * The cookie is cleared on every answer, so a code can be redeemed once.
 *
 * The sealed state also says WHY the person went to Google (Phase 4): to connect an account for the
 * project (`google_sheets.manage`), or to link their own Google identity (`google_sheets.view`, for
 * themselves only). Each lands back on its own page.
 */
export const dynamic = "force-dynamic";

const SETTINGS_PATH = "/settings/google-sheets";
const CLIENT_REFUSAL_CODE = { DISABLED: "disabled", NOT_CONFIGURED: "not_configured", INVALID: "invalid_client" } as const;
const IDENTITY_PATH = "/google-sheets/identity";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const params = request.nextUrl.searchParams;
  const state = openOAuthState(request.cookies.get(STATE_COOKIE)?.value);

  const landing = state?.purpose === "IDENTITY" ? IDENTITY_PATH : SETTINGS_PATH;
  const finish = (slug: string | null, query: string) => {
    const target = slug
      ? `${origin}/p/${slug}${landing}?${query}`
      : `${origin}/open?next=${encodeURIComponent(`${landing}?${query}`)}`;
    const response = NextResponse.redirect(target, 303);
    response.cookies.set(STATE_COOKIE, "", stateCookieOptions(0));
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  if (!state) return finish(null, "google_error=expired");
  if (params.get("state") !== state.state) return finish(state.projectSlug, "google_error=state");
  if (params.get("error")) return finish(state.projectSlug, "google_error=denied");

  const session = await getSession();
  if (!session || session.userId !== state.userId) return finish(state.projectSlug, "google_error=session");

  const project = await enterableProject(session.userId, state.projectSlug);
  if (!project) return finish(null, "google_error=permission");

  const code = params.get("code");
  if (!code) return finish(project.slug, "google_error=denied");
  // The code is redeemed with THIS project's client, read inside the project — and only if it is the
  // client the consent screen was opened with (a change meanwhile makes the code unusable).
  const client = await runWithProject(project, () => resolveProjectGoogleClient());
  if (!client.ok) return finish(project.slug, `google_error=${CLIENT_REFUSAL_CODE[client.reason]}`);
  if (state.clientId && state.clientId !== client.config.clientId) return finish(project.slug, "google_error=client_changed");
  const config = client.config;

  if (state.purpose === "IDENTITY") {
    return runWithProject(project, async () => {
      const access = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
      if ("denied" in access) return finish(project.slug, "google_error=permission");
      try {
        const identity = await completeIdentityLink({ config, code, verifier: state.verifier, userId: session.userId });
        await logSystemEvent(
          "INFO",
          "google-sheets",
          `${session.username} linked their Google identity ${identity.email}`,
          {},
          { actorUserId: session.userId, targetType: "UserGoogleIdentity", targetId: identity.id },
        );
        return finish(project.slug, `linked=${encodeURIComponent(identity.email)}`);
      } catch (err) {
        if (err instanceof GoogleIdentityError) {
          await logSystemEvent("WARN", "google-sheets", "A Google identity could not be linked", { reason: err.code, detail: err.message }, { actorUserId: session.userId });
          return finish(project.slug, `google_error=${err.code.toLowerCase()}`);
        }
        await logSystemEvent("ERROR", "google-sheets", "Linking a Google identity failed", { error: (err as Error).message }, { actorUserId: session.userId });
        return finish(project.slug, "google_error=failed");
      }
    });
  }

  return runWithProject(project, async () => {
    const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
    if ("denied" in access) return finish(project.slug, "google_error=permission");
    try {
      const account = await completeGoogleConnection({ config, code, verifier: state.verifier, userId: session.userId });
      // The spreadsheet list follows, best effort: a list Google could not give right now must not
      // lose a connection that worked. The account card shows the problem and offers Refresh.
      const listing = await syncAccountSpreadsheets(account.id, { config }).then(
        (result) => ({ spreadsheetCount: result.listed, listError: null }),
        (err: Error) => ({ spreadsheetCount: null, listError: err.message }),
      );
      await logSystemEvent(
        "INFO",
        "google-sheets",
        `Google account ${account.email} connected`,
        { connectedBy: session.username, ...listing },
        { actorUserId: session.userId, targetType: "GoogleIntegrationAccount", targetId: account.id },
      );
      return finish(project.slug, `connected=${encodeURIComponent(account.email)}`);
    } catch (err) {
      if (err instanceof GoogleConnectionError) {
        await logSystemEvent("WARN", "google-sheets", "A Google account could not be connected", { reason: err.code, detail: err.message }, { actorUserId: session.userId });
        return finish(project.slug, `google_error=${err.code.toLowerCase()}`);
      }
      // Never the message itself in the URL: it can carry Google's raw response.
      await logSystemEvent("ERROR", "google-sheets", "Connecting a Google account failed", { error: (err as Error).message }, { actorUserId: session.userId });
      return finish(project.slug, "google_error=failed");
    }
  });
}

/**
 * The project, with this person's access level in it, only if they may still enter it — the same
 * answer the normal request path gives (a Main Admin may enter any project at FULL).
 */
async function enterableProject(userId: string, slug: string): Promise<ActiveProject | null> {
  forgetProjectAccessDecisions();
  const project = (await accessibleProjects(userId)).find((p) => p.slug === slug);
  if (!project) return null;
  const access = await platformPrisma.projectAccess.findUnique({
    where: { projectId_userId: { projectId: project.id, userId } },
    select: { level: true },
  });
  return { ...project, accessLevel: access?.level ?? "FULL" };
}
