import { NextResponse, type NextRequest } from "next/server";
import { isReadOnlyProjectStatus } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { requireActiveProject } from "@/server/projectContext";
import { publicOrigin } from "@/server/google/oauth";
import { sheetEditorAccess } from "@/server/google/editorAccess";
import { isClientKey, isSignalKind, recordSignal } from "@/server/google/sessions";

/**
 * Signals from an open sheet page (GOOGLE_SHEETS.md §7, Phase 7): START, VIEW_SIGNAL, WORK_SIGNAL,
 * CLOSE. A Route Handler rather than a Server Action because the CLOSE is sent with
 * `navigator.sendBeacon` as the page goes away, which a Server Action cannot receive.
 *
 * Same-origin only (a beacon carries the session cookie, so a page elsewhere must not be able to
 * send one), the view key and the feature, and the sheet's own rule for who opens it. The server's
 * clock stamps every signal; the body carries no time. Answers 204 whatever happened to the signal —
 * the page has nothing to do differently.
 */
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000;

function sameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = publicOrigin() ?? new URL(request.url).origin;
  return origin === expected;
}

const empty = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(request)) return empty(403);
  const session = await getSession();
  if (!session) return empty(401);
  const viewer = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
  if ("denied" in viewer) return empty(403);

  const text = await request.text();
  if (text.length > MAX_BODY) return empty(413);
  let body: { clientKey?: unknown; spreadsheetId?: unknown; kind?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return empty(400);
  }
  if (!isClientKey(body.clientKey) || !isSignalKind(body.kind) || typeof body.spreadsheetId !== "string" || body.spreadsheetId.length > 64) return empty(400);

  const access = await sheetEditorAccess(body.spreadsheetId, viewer.session);
  if (!access?.canOpen) return empty(403);
  // A suspended or archived project records nothing (its database writes are refused anyway).
  if (isReadOnlyProjectStatus((await requireActiveProject()).status)) return empty(204);

  await recordSignal({ clientKey: body.clientKey, spreadsheetId: body.spreadsheetId, kind: body.kind, userId: viewer.session.userId, mayWork: access.mayWork });
  return empty(204);
}
