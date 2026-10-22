import { isLive, roleCanWork, SIGNAL_INTERVAL_MS, type SessionSignalKind, type SheetMemberRole } from "@support-automation/shared";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { prisma } from "@/server/db";
import { resolveSheetActor } from "@/server/google/members";
import { getGoogleSheetsSettings } from "@/server/google/settings";

/**
 * Open-sheet sessions (GOOGLE_SHEETS.md §7, Phase 7). The open page sends signals; this file records
 * them, stamped with the SERVER's clock. Time is never computed or stored here — the events are the
 * record, and `computeSheetTime` (packages/shared) reads them.
 *
 * What a signal cannot do:
 *   - add time by being sent faster: anything closer than the signal interval to the previous one of
 *     its kind is dropped, and time is built from gaps anyway, never from a count;
 *   - make a viewer a worker: a work signal from someone whose role cannot work, or who lacks the edit
 *     permission, is recorded as a view signal;
 *   - reach another person's session or sheet: a key belonging to someone else, or to another sheet,
 *     is ignored.
 */

/** A page's own random key: 16–64 URL-safe characters. */
export function isClientKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function isSignalKind(value: unknown): value is SessionSignalKind {
  return value === "START" || value === "VIEW_SIGNAL" || value === "WORK_SIGNAL" || value === "CLOSE";
}

/** Signals of a kind closer together than this are one signal (a little under the browser's 30 s). */
const MIN_GAP_MS = SIGNAL_INTERVAL_MS - 10_000;
/** A START right after another signal is the page coming back into view, not a new presence. */
const START_MIN_GAP_MS = 5_000;

export interface SignalInput {
  clientKey: string;
  spreadsheetId: string;
  kind: SessionSignalKind;
  userId: string;
  /** May this person work on the sheet right now (a working role, the edit permission, a writable project)? */
  mayWork: boolean;
  now?: Date;
}

export type SignalOutcome = "RECORDED" | "THROTTLED" | "IGNORED" | "CLOSED";

/**
 * Record one signal. The session is found by the page's key, or opened by the first signal that is
 * not a CLOSE. Never throws for a racing duplicate: the second insert of a session finds the first.
 */
export async function recordSignal(input: SignalInput): Promise<{ outcome: SignalOutcome; sessionId: string | null }> {
  const now = input.now ?? new Date();
  let session = await prisma.googleSheetWorkSession.findFirst({
    where: { clientKey: input.clientKey },
    select: { id: true, userId: true, spreadsheetId: true, canWork: true, closedAt: true, lastSignalAt: true, lastWorkAt: true },
  });
  if (session && (session.userId !== input.userId || session.spreadsheetId !== input.spreadsheetId)) return { outcome: "IGNORED", sessionId: null };
  if (session?.closedAt) return { outcome: "CLOSED", sessionId: session.id };

  if (!session) {
    if (input.kind === "CLOSE") return { outcome: "IGNORED", sessionId: null };
    const actor = await resolveSheetActor(input.spreadsheetId, input.userId, now);
    if (!actor) return { outcome: "IGNORED", sessionId: null };
    try {
      const created = await prisma.googleSheetWorkSession.create({
        data: {
          spreadsheetId: input.spreadsheetId,
          userId: input.userId,
          teamMemberId: actor.teamMemberId,
          memberRole: actor.role,
          canWork: input.mayWork && actor.canWork,
          clientKey: input.clientKey,
          startedAt: now,
          lastSignalAt: now,
          lastWorkAt: null,
        },
        select: { id: true },
      });
      const kind = input.kind === "WORK_SIGNAL" && !(input.mayWork && actor.canWork) ? "VIEW_SIGNAL" : input.kind;
      // The first signal opens presence; a work signal on open (typing at once) is both.
      await prisma.googleSheetWorkSessionEvent.createMany({
        data: kind === "START" ? [{ sessionId: created.id, kind: "START", at: now }] : [
          { sessionId: created.id, kind: "START", at: now },
          { sessionId: created.id, kind, at: now },
        ],
      });
      if (kind === "WORK_SIGNAL") await prisma.googleSheetWorkSession.update({ where: { id: created.id }, data: { lastWorkAt: now } });
      return { outcome: "RECORDED", sessionId: created.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The same page's first two signals raced: the other one opened it.
      session = await prisma.googleSheetWorkSession.findFirst({
        where: { clientKey: input.clientKey, userId: input.userId, spreadsheetId: input.spreadsheetId },
        select: { id: true, userId: true, spreadsheetId: true, canWork: true, closedAt: true, lastSignalAt: true, lastWorkAt: true },
      });
      if (!session) return { outcome: "IGNORED", sessionId: null };
    }
  }

  if (input.kind === "CLOSE") {
    await prisma.$transaction([
      prisma.googleSheetWorkSessionEvent.create({ data: { sessionId: session.id, kind: "CLOSE", at: now } }),
      prisma.googleSheetWorkSession.update({ where: { id: session.id }, data: { closedAt: now } }),
    ]);
    return { outcome: "CLOSED", sessionId: session.id };
  }

  // Whether this person may work is decided when the session opens AND now: losing the permission
  // or the role mid-session stops the work, it never starts it.
  const canWorkNow = session.canWork && input.mayWork;
  const kind: SessionSignalKind = input.kind === "WORK_SIGNAL" && !canWorkNow ? "VIEW_SIGNAL" : input.kind;
  const sinceLast = now.getTime() - session.lastSignalAt.getTime();
  const sinceWork = session.lastWorkAt ? now.getTime() - session.lastWorkAt.getTime() : Infinity;
  if (kind === "START" && sinceLast < START_MIN_GAP_MS) return { outcome: "THROTTLED", sessionId: session.id };
  if (kind === "VIEW_SIGNAL" && sinceLast < MIN_GAP_MS) return { outcome: "THROTTLED", sessionId: session.id };
  if (kind === "WORK_SIGNAL" && sinceWork < MIN_GAP_MS) return { outcome: "THROTTLED", sessionId: session.id };

  await prisma.$transaction([
    prisma.googleSheetWorkSessionEvent.create({ data: { sessionId: session.id, kind, at: now } }),
    prisma.googleSheetWorkSession.update({
      where: { id: session.id },
      data: { lastSignalAt: now, ...(kind === "WORK_SIGNAL" ? { lastWorkAt: now } : {}) },
    }),
  ]);
  return { outcome: "RECORDED", sessionId: session.id };
}

/**
 * A change saved through the app is itself a work signal (§7) — recorded by the server as part of
 * the save, so it never depends on the page sending one. Not throttled: every save is evidence.
 * Called only AFTER a save the server permitted, so it also proves the person may work now (a role
 * granted mid-session counts from this save on). Returns the session's id when the page's key named
 * one of this person's open sessions on this sheet.
 */
export async function recordSaveSignal(input: { clientKey: string | null; spreadsheetId: string; userId: string; now?: Date }): Promise<string | null> {
  if (!input.clientKey || !isClientKey(input.clientKey)) return null;
  const now = input.now ?? new Date();
  const session = await prisma.googleSheetWorkSession.findFirst({
    where: { clientKey: input.clientKey, userId: input.userId, spreadsheetId: input.spreadsheetId, closedAt: null },
    select: { id: true },
  });
  if (!session) return null;
  await prisma.$transaction([
    prisma.googleSheetWorkSessionEvent.create({ data: { sessionId: session.id, kind: "WORK_SIGNAL", at: now } }),
    prisma.googleSheetWorkSession.update({ where: { id: session.id }, data: { canWork: true, lastSignalAt: now, lastWorkAt: now } }),
  ]);
  return session.id;
}

export interface LiveSession {
  sessionId: string;
  spreadsheetId: string;
  spreadsheetName: string;
  userId: string;
  name: string;
  role: SheetMemberRole | null;
  teamMemberName: string | null;
  /** A work signal within the inactivity threshold. */
  working: boolean;
  startedAt: Date;
  lastSignalAt: Date;
}

/** Who has a sheet open right now — a signal within the inactivity threshold, not closed. */
export async function listLiveSessions(options: { spreadsheetId?: string; now?: Date } = {}): Promise<LiveSession[]> {
  const now = options.now ?? new Date();
  const { inactivityMinutes } = await getGoogleSheetsSettings();
  const since = new Date(now.getTime() - inactivityMinutes * 60_000);
  const rows = await prisma.googleSheetWorkSession.findMany({
    where: { closedAt: null, lastSignalAt: { gte: since }, ...(options.spreadsheetId ? { spreadsheetId: options.spreadsheetId } : {}) },
    orderBy: { lastSignalAt: "desc" },
    take: 200,
    select: {
      id: true,
      spreadsheetId: true,
      userId: true,
      memberRole: true,
      startedAt: true,
      lastSignalAt: true,
      lastWorkAt: true,
      spreadsheet: { select: { name: true } },
      user: { select: { name: true } },
      teamMember: { select: { name: true } },
    },
  });
  // One line per person per sheet: two tabs open is one person there.
  const seen = new Set<string>();
  const out: LiveSession[] = [];
  for (const row of rows) {
    const key = `${row.userId}:${row.spreadsheetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sessionId: row.id,
      spreadsheetId: row.spreadsheetId,
      spreadsheetName: row.spreadsheet.name,
      userId: row.userId,
      name: row.user.name,
      role: row.memberRole,
      teamMemberName: row.teamMember?.name ?? null,
      working: Boolean(row.lastWorkAt && isLive(row.lastWorkAt, now, inactivityMinutes)) && roleCanWork(row.memberRole),
      startedAt: row.startedAt,
      lastSignalAt: row.lastSignalAt,
    });
  }
  return out;
}
