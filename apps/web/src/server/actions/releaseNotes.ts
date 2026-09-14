"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { Prisma, ReleaseNoteStatus, ReleaseNoteType } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import { RELEASE_TYPES, parseBulletLines } from "@/lib/releaseNotes";

/**
 * Every write in Release Notes: create/edit a draft, publish, unpublish, archive, re-publish,
 * delete a draft. Same file layout as `server/actions/teamManagement.ts` and `rules.ts` —
 * server-action mutations only, reads live in `server/releaseNotesReports.ts`.
 *
 * Three rules hold across the whole file:
 *
 * **Every mutation checks `release_notes.manage` itself**, via the local `requireManage()` below —
 * never trusting that a page already gated the button that got here. A permission check on the
 * page is a UX nicety; the one in here is the actual security boundary.
 *
 * **A revision is written exactly when PUBLIC content changes** — publishing (the content is
 * becoming live for the first time under this `currentVersion`) or editing a row that is currently
 * PUBLISHED/ARCHIVED (already-public content is changing under a reader's feet). A pure status flip
 * with no content change (archive, unpublish, re-publish) never writes one — see the schema's own
 * comment on `ReleaseNote.currentVersion` for the full reasoning.
 *
 * **A PUBLISHED or ARCHIVED row can never be deleted**, only unpublished/archived. Only a DRAFT can
 * be deleted, and only a DRAFT has no revision history to lose by doing so.
 */

export interface ReleaseNoteFormState {
  error?: string;
}

async function requireManage(): Promise<{ userId: string } | { error: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "release_notes.manage"))) {
    return { error: "You do not have permission to manage release notes." };
  }
  return { userId: session.userId };
}

function revalidateReleaseNotes(id?: string) {
  revalidatePath("/release-notes");
  revalidatePath("/release-notes/manage");
  if (id) {
    revalidatePath(`/release-notes/${id}`);
    revalidatePath(`/release-notes/manage/${id}/edit`);
  }
}

/**
 * `<input type="date">` → the UTC-midnight `Date` a `@db.Date` column expects, or `null` for a
 * blank/invalid one. Deliberately NOT `parseDhakaDayFromInput` from `lib/supportActivityPeriod`:
 * that helper returns a Dhaka-offset RANGE boundary meant for filtering a timestamp column
 * (`gte: start`), and writing that instant directly into a `@db.Date` scalar would land on the
 * PREVIOUS calendar day once Prisma takes its UTC date part — the exact bug `toDhakaDateOnly`'s own
 * comment warns about. A release date typed into a date input has no time-of-day to convert from
 * in the first place, so it needs the plain calendar parse, not the Dhaka-instant one.
 */
function parseCalendarDate(raw: FormDataEntryValue | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-tripping through Date.UTC is what rejects "2026-02-31" — the constructor rolls it
  // forward into March, and comparing the parts back out catches that.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

interface ParsedReleaseNoteFields {
  version: string;
  title: string;
  summary: string | null;
  releaseDate: Date;
  releaseType: ReleaseNoteType;
  whatsNew: string[];
  improvements: string[];
  bugFixes: string[];
  security: string[];
  breakingChanges: string[];
  knownIssues: string[];
  technicalNotes: string[];
  affectedModules: string[];
}

/** Shared by create and update, mirroring `rules.ts`'s own `parseRuleFields`/`parseConditions` split. */
function parseReleaseNoteFields(formData: FormData): ParsedReleaseNoteFields | { error: string } {
  const version = String(formData.get("version") ?? "").trim();
  if (!version) return { error: "Enter a version." };
  if (version.length > 40) return { error: "Version is limited to 40 characters." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "Enter a title." };
  if (title.length > 200) return { error: "Title is limited to 200 characters." };

  const releaseDate = parseCalendarDate(formData.get("releaseDate"));
  if (!releaseDate) return { error: "Enter a valid release date." };

  const releaseTypeRaw = String(formData.get("releaseType") ?? "");
  const releaseType = (RELEASE_TYPES as readonly string[]).includes(releaseTypeRaw)
    ? (releaseTypeRaw as ReleaseNoteType)
    : "FEATURE";

  const summary = String(formData.get("summary") ?? "").trim() || null;

  return {
    version,
    title,
    summary,
    releaseDate,
    releaseType,
    whatsNew: parseBulletLines(formData.get("whatsNew")),
    improvements: parseBulletLines(formData.get("improvements")),
    bugFixes: parseBulletLines(formData.get("bugFixes")),
    security: parseBulletLines(formData.get("security")),
    breakingChanges: parseBulletLines(formData.get("breakingChanges")),
    knownIssues: parseBulletLines(formData.get("knownIssues")),
    technicalNotes: parseBulletLines(formData.get("technicalNotes")),
    affectedModules: formData.getAll("affectedModules").map(String).filter(Boolean),
  };
}

function friendlyVersionConflict(err: unknown, version: string): string | null {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002" &&
    ((err as { meta?: { target?: unknown } }).meta?.target as string[] | undefined)?.includes("version")
  ) {
    return `A release note with version "${version}" already exists.`;
  }
  return null;
}

// --------------------------------------------------------------------------------------- create

export async function createReleaseNoteDraft(
  _prevState: ReleaseNoteFormState,
  formData: FormData,
): Promise<ReleaseNoteFormState> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const fields = parseReleaseNoteFields(formData);
  if ("error" in fields) return fields;

  let created: { id: string };
  try {
    created = await prisma.releaseNote.create({
      data: { ...fields, createdByUserId: auth.userId },
      select: { id: true },
    });
  } catch (err) {
    const conflict = friendlyVersionConflict(err, fields.version);
    if (conflict) return { error: conflict };
    throw err;
  }

  await logSystemEvent("INFO", "release-notes", `Release note draft "${fields.version}" created`, {
    userId: auth.userId,
    releaseNoteId: created.id,
  });

  revalidateReleaseNotes();
  // Straight to the edit page, not the list: a fresh draft with seven empty sections is rarely
  // finished in one submission, unlike RuleForm's single-pass form — landing back on the list would
  // just make the very next click "open it again to keep writing."
  redirect(`/release-notes/manage/${created.id}/edit`);
}

// ---------------------------------------------------------------------------------------- update

export async function updateReleaseNote(
  id: string,
  _prevState: ReleaseNoteFormState,
  formData: FormData,
): Promise<ReleaseNoteFormState> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const fields = parseReleaseNoteFields(formData);
  if ("error" in fields) return fields;

  const current = await prisma.releaseNote.findUnique({ where: { id } });
  if (!current) return { error: "That release note no longer exists." };

  const isPublic = current.status === "PUBLISHED" || current.status === "ARCHIVED";

  try {
    if (isPublic) {
      const nextVersion = current.currentVersion + 1;
      await prisma.$transaction([
        prisma.releaseNoteRevision.create({
          data: {
            releaseNoteId: id,
            version: nextVersion,
            title: fields.title,
            summary: fields.summary,
            releaseDate: fields.releaseDate,
            releaseType: fields.releaseType,
            status: current.status,
            whatsNew: fields.whatsNew,
            improvements: fields.improvements,
            bugFixes: fields.bugFixes,
            security: fields.security,
            breakingChanges: fields.breakingChanges,
            knownIssues: fields.knownIssues,
            technicalNotes: fields.technicalNotes,
            affectedModules: fields.affectedModules,
            changedByUserId: auth.userId,
          },
        }),
        prisma.releaseNote.update({ where: { id }, data: { ...fields, currentVersion: nextVersion } }),
      ]);
    } else {
      // Still a DRAFT — nothing public to protect, so a plain update with no history row.
      await prisma.releaseNote.update({ where: { id }, data: fields });
    }
  } catch (err) {
    const conflict = friendlyVersionConflict(err, fields.version);
    if (conflict) return { error: conflict };
    throw err;
  }

  await logSystemEvent("INFO", "release-notes", `Release note "${fields.version}" edited`, {
    userId: auth.userId,
    releaseNoteId: id,
    wroteRevision: isPublic,
  });

  revalidateReleaseNotes(id);
  redirect("/release-notes/manage");
}

// ----------------------------------------------------------------------------------- transitions

export type ReleaseNoteTransition = "PUBLISH" | "UNPUBLISH" | "ARCHIVE" | "REPUBLISH";

const ALLOWED_TRANSITIONS: Record<ReleaseNoteTransition, { from: ReleaseNoteStatus; to: ReleaseNoteStatus }> = {
  PUBLISH: { from: "DRAFT", to: "PUBLISHED" },
  UNPUBLISH: { from: "PUBLISHED", to: "DRAFT" },
  ARCHIVE: { from: "PUBLISHED", to: "ARCHIVED" },
  REPUBLISH: { from: "ARCHIVED", to: "PUBLISHED" },
};

const TRANSITION_VERB: Record<ReleaseNoteTransition, string> = {
  PUBLISH: "published",
  UNPUBLISH: "unpublished",
  ARCHIVE: "archived",
  REPUBLISH: "re-published",
};

export interface TransitionResult {
  error?: string;
  updated?: boolean;
}

/**
 * The one place every status change goes through — a single whitelist rather than four separate
 * guards that could quietly drift out of sync with each other over time.
 */
export async function transitionReleaseNoteStatus(
  id: string,
  transition: ReleaseNoteTransition,
): Promise<TransitionResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const rule = ALLOWED_TRANSITIONS[transition];
  const current = await prisma.releaseNote.findUnique({ where: { id } });
  if (!current) return { error: "That release note no longer exists." };
  if (current.status !== rule.from) {
    return {
      error: `Cannot ${transition.toLowerCase()} a release note that is currently ${current.status.toLowerCase()}.`,
    };
  }

  if (transition === "PUBLISH") {
    const hasAnyContent =
      current.whatsNew.length > 0 ||
      current.improvements.length > 0 ||
      current.bugFixes.length > 0 ||
      current.security.length > 0 ||
      current.breakingChanges.length > 0 ||
      current.knownIssues.length > 0 ||
      current.technicalNotes.length > 0;
    if (!hasAnyContent) {
      return { error: "Add at least one change under any section before publishing." };
    }

    const nextVersion = current.currentVersion + 1;
    const data: Prisma.ReleaseNoteUpdateInput = {
      status: "PUBLISHED",
      currentVersion: nextVersion,
      publishedAt: new Date(),
      publishedBy: { connect: { id: auth.userId } },
    };
    await prisma.$transaction([
      prisma.releaseNoteRevision.create({
        data: {
          releaseNoteId: id,
          version: nextVersion,
          title: current.title,
          summary: current.summary,
          releaseDate: current.releaseDate,
          releaseType: current.releaseType,
          status: "PUBLISHED",
          whatsNew: current.whatsNew,
          improvements: current.improvements,
          bugFixes: current.bugFixes,
          security: current.security,
          breakingChanges: current.breakingChanges,
          knownIssues: current.knownIssues,
          technicalNotes: current.technicalNotes,
          affectedModules: current.affectedModules,
          changedByUserId: auth.userId,
        },
      }),
      prisma.releaseNote.update({ where: { id }, data }),
    ]);
  } else {
    // ARCHIVE / UNPUBLISH / REPUBLISH: a pure visibility change, content untouched, so no revision.
    // publishedAt/publishedByUserId are deliberately left exactly as they are — see the schema
    // comment on those columns.
    await prisma.releaseNote.update({ where: { id }, data: { status: rule.to } });
  }

  await logSystemEvent("INFO", "release-notes", `Release note "${current.version}" ${TRANSITION_VERB[transition]}`, {
    userId: auth.userId,
    releaseNoteId: id,
  });

  revalidateReleaseNotes(id);
  return { updated: true };
}

// ---------------------------------------------------------------------------------------- delete

export interface DeleteResult {
  error?: string;
  deleted?: boolean;
}

/**
 * Only a DRAFT can ever be deleted. A PUBLISHED or ARCHIVED release is refused outright — there is
 * deliberately no override, matching Phase 10's "must never accidentally disappear because of a
 * frontend action": the safest version of that rule is one with no code path that can do it at all.
 */
export async function deleteReleaseNoteDraft(id: string): Promise<DeleteResult> {
  const auth = await requireManage();
  if ("error" in auth) return auth;

  const current = await prisma.releaseNote.findUnique({ where: { id }, select: { status: true, version: true } });
  if (!current) return { deleted: true }; // already gone — deleting a second time is a no-op, not an error

  if (current.status !== "DRAFT") {
    return {
      error: `"${current.version}" is ${current.status.toLowerCase()} and cannot be deleted. Unpublish or archive it instead.`,
    };
  }

  await prisma.releaseNote.delete({ where: { id } });

  await logSystemEvent("INFO", "release-notes", `Release note draft "${current.version}" deleted`, {
    userId: auth.userId,
    releaseNoteId: id,
  });

  revalidateReleaseNotes();
  return { deleted: true };
}
