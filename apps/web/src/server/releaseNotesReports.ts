import { prisma } from "@support-automation/db";
import type { Prisma, ReleaseNoteStatus, ReleaseNoteType } from "@prisma/client";

/**
 * Server-component-only read helpers for Release Notes — no `"use server"` directive, matching
 * `dashboardSummary.ts`/`teamManagementReports.ts` next door: these are never invoked from a client
 * event handler, only from a Server Component or another server-only module.
 *
 * The one rule every function here answers to: a DRAFT is never returned to a plain viewer.
 * `getPublishedReleaseNotes()` and `getReleaseNoteForViewer()` are the only two read paths a
 * regular user's page ever calls, and both hard-code `status: { in: ["PUBLISHED", "ARCHIVED"] }` —
 * there is no flag or parameter that widens that, on purpose, so a future caller cannot accidentally
 * loosen it. The admin list (`listReleaseNotesForAdmin`) is a separate function reached only from
 * `/release-notes/manage`, itself gated on `release_notes.manage`.
 */

const AUTHOR_SELECT = { select: { name: true, username: true } } as const;

/** `"Jane Doe"` if we have a name, the login username as a fallback, "—" if the user was removed. */
export function authorLabel(user: { name: string; username: string } | null): string {
  if (!user) return "—";
  return user.name || user.username;
}

const PUBLIC_STATUSES: ReleaseNoteStatus[] = ["PUBLISHED", "ARCHIVED"];

/**
 * Everything a regular user is ever allowed to see, newest release date first. Used by both the
 * `/release-notes` list (which renders the single newest one in full and the rest as a compact
 * history) and, indirectly, by `getReleaseNoteForViewer()`'s own status check below.
 */
export async function getPublishedReleaseNotes() {
  return prisma.releaseNote.findMany({
    where: { status: { in: PUBLIC_STATUSES } },
    orderBy: [{ releaseDate: "desc" }, { createdAt: "desc" }],
    include: { createdBy: AUTHOR_SELECT, publishedBy: AUTHOR_SELECT },
  });
}

/**
 * One release, for `/release-notes/[id]`.
 *
 * `canManage` is the only thing that can widen this past PUBLISHED/ARCHIVED, and it must come from
 * a real `hasPermission(session, "release_notes.manage")` check at the call site — never a client-
 * supplied flag. That is what makes this page double as the admin's "preview before publishing":
 * the exact same render the public will eventually see, with a banner on top saying it is still a
 * draft, rather than a second preview implementation that could drift from the real thing.
 */
export async function getReleaseNoteForViewer(id: string, canManage: boolean) {
  const release = await prisma.releaseNote.findUnique({
    where: { id },
    include: { createdBy: AUTHOR_SELECT, publishedBy: AUTHOR_SELECT },
  });
  if (!release) return null;
  if (!canManage && !PUBLIC_STATUSES.includes(release.status)) return null;
  return release;
}

export interface AdminReleaseNoteFilters {
  search?: string;
  status?: ReleaseNoteStatus;
  releaseType?: ReleaseNoteType;
  page?: number;
  pageSize?: number;
}

/** The full admin list at `/release-notes/manage` — every status, paginated, newest first. */
export async function listReleaseNotesForAdmin(filters: AdminReleaseNoteFilters) {
  const pageSize = filters.pageSize ?? 25;
  const page = Math.max(1, filters.page ?? 1);

  const where: Prisma.ReleaseNoteWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.releaseType ? { releaseType: filters.releaseType } : {}),
    ...(filters.search?.trim()
      ? {
          OR: [
            { version: { contains: filters.search.trim(), mode: "insensitive" } },
            { title: { contains: filters.search.trim(), mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.releaseNote.findMany({
      where,
      orderBy: [{ releaseDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { createdBy: AUTHOR_SELECT, publishedBy: AUTHOR_SELECT },
    }),
    prisma.releaseNote.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/** For the edit page's admin view: the current row plus how many prior published edits it has. */
export async function getReleaseNoteForEditing(id: string) {
  const [release, revisionCount] = await Promise.all([
    prisma.releaseNote.findUnique({ where: { id } }),
    prisma.releaseNoteRevision.count({ where: { releaseNoteId: id } }),
  ]);
  if (!release) return null;
  return { release, revisionCount };
}
