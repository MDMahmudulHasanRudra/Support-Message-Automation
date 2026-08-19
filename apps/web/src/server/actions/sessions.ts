"use server";

import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";

const SESSION_COOKIE = "support_automation_session";
const PERMISSION_DENIED_ERROR = "You do not have permission to perform this action.";

/** Identifies which UserSession row belongs to the browser making this request, so the Active
 * Sessions page can mark it "CURRENT DEVICE" and the global revoke can optionally spare it. */
export async function getCurrentSessionId(): Promise<string | null> {
  const store = await cookies();
  const secret = store.get(SESSION_COOKIE)?.value;
  if (!secret) return null;
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const record = await prisma.userSession.findUnique({ where: { secretHash }, select: { id: true } });
  return record?.id ?? null;
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
  revalidatePath(`/users/${target.userId}/sessions`);
  return {};
}

export async function revokeAllOtherSessions(userId: string): Promise<{ error?: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "users.force_logout"))) return { error: PERMISSION_DENIED_ERROR };

  const currentSessionId = await getCurrentSessionId();

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
  revalidatePath(`/users/${userId}/sessions`);
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

  const currentSessionId = await getCurrentSessionId();

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
  revalidatePath("/users");
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
  revalidatePath("/users");
  return {};
}
