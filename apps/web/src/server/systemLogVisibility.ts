import type { Prisma } from "@prisma/client";
import { getSession } from "@/server/auth";
import { isMainAdmin } from "@/server/projectContext";

/**
 * Which System Log entries a project's reader sees (audit MEDIUM #2).
 *
 * The scoped client returns a project's own entries PLUS every platform entry (no project): the
 * Main Admin Portal's actions — "Project access added" with the project and user it touched,
 * projects created, roles changed — and worker events raised outside any project. Those name other
 * projects and other people, so anyone with `system_logs.view` in Bizify could read ISP Digital's
 * administration. Platform entries now show only to a Main Admin, who administers the platform;
 * everybody else sees their project's own entries.
 *
 * `{ not: null }` on this nullable column compiles to IS NOT NULL, which is exactly what is meant
 * (see CLAUDE.md on `{ not: value }` — the NULL trap only bites when comparing to a value).
 */
export async function systemLogVisibility(): Promise<Prisma.SystemLogWhereInput> {
  const session = await getSession();
  if (session && (await isMainAdmin(session.userId))) return {};
  return { projectId: { not: null } };
}
