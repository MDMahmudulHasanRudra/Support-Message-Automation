"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";

import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";

const SESSION_COOKIE = "support_automation_session";
const PERMISSION_DENIED_ERROR = "You do not have permission to perform this action.";

/** Cookie → UserSession row id, carrying no authorization of its own. Module-private on purpose:
 * every export in a "use server" file is a public POST endpoint, so the guarded wrapper below is
 * the only way in from outside, while the revoke actions here (which have already authenticated)
 * call this directly rather than paying for a second session lookup. */
async function readCurrentSessionId(): Promise<string | null> {
  const store = await cookies();
  const secret = store.get(SESSION_COOKIE)?.value;
  if (!secret) return null;
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const record = await prisma.userSession.findUnique({ where: { secretHash }, select: { id: true } });
  return record?.id ?? null;
}

/** Identifies which UserSession row belongs to the browser making this request, so the Active
 * Sessions page can mark it "CURRENT DEVICE" and the global revoke can optionally spare it.
 * requireSession() first, like every other export here: unguarded, this was an anonymous,
 * unrate-limited "is this cookie still live?" oracle reachable by POSTing to the action. */
export async function getCurrentSessionId(): Promise<string | null> {
  await requireSession();
  return readCurrentSessionId();
}

export async function revokeSession(sessionId: string): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.force_logout"))) return { error: PERMISSION_DENIED_ERROR };

  const target = await prisma.userSession.findUnique({ where: { id: sessionId } });
  if (!target) return { error: "Session not found." };

  await prisma.userSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
  });

  await logSystemEvent("INFO", "sessions", "SESSION_REVOKED", {
    actorId: session.userId,
    targetUserId: target.userId,
    sessionId,
  });
  revalidatePath(await projectPath(`/users/${target.userId}/sessions`));
  return {};
}

export async function revokeAllOtherSessions(userId: string): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.force_logout"))) return { error: PERMISSION_DENIED_ERROR };

  const currentSessionId = await readCurrentSessionId();

  const result = await prisma.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
  });

  await logSystemEvent("INFO", "sessions", "SESSION_REVOKED_ALL_FOR_USER", {
    actorId: session.userId,
    targetUserId: userId,
    revokedCount: result.count,
  });
  revalidatePath(await projectPath(`/users/${userId}/sessions`));
  return {};
}

/**
 * The spec's explicitly recommended safer default for the highly-privileged "sign everyone out"
 * action: excludes the acting admin's own current session so they don't lock themselves out
 * mid-action. revokeAllSessionsGlobally() below is the separate, more clearly named action for a
 * true global logout that includes the caller.
 */
export async function revokeAllSessionsExceptMine(): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.force_logout"))) return { error: PERMISSION_DENIED_ERROR };

  const currentSessionId = await readCurrentSessionId();

  const result = await prisma.userSession.updateMany({
    where: {
      revokedAt: null,
      ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED_ALL" },
  });

  await logSystemEvent("WARN", "sessions", "ALL_SESSIONS_REVOKED", {
    actorId: session.userId,
    revokedCount: result.count,
    includedCaller: false,
  });
  revalidatePath(await projectPath("/users"));
  return {};
}

/** True global logout — includes the caller's own current session. A separate, explicitly named action per the spec, never the default. */
export async function revokeAllSessionsGlobally(): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.force_logout"))) return { error: PERMISSION_DENIED_ERROR };

  const result = await prisma.userSession.updateMany({
    where: { revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED_ALL" },
  });

  await logSystemEvent("WARN", "sessions", "ALL_SESSIONS_REVOKED", {
    actorId: session.userId,
    revokedCount: result.count,
    includedCaller: true,
  });
  revalidatePath(await projectPath("/users"));
  return {};
}
