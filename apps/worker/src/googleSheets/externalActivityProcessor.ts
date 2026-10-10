import { decryptSecret, encryptSecret } from "@support-automation/db";
import { actionKind, CLIENT_CHANGED_MESSAGE, decideGoogleClient, roleAt, tokensIssuedTo } from "@support-automation/shared";
import { platformPrisma, prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { DRIVE_ACTIVITY_SCOPE, GoogleApiError, MAX_ACTIVITY_PAGES, queryDriveActivity, refreshAccessToken, type FetchImpl } from "./api.js";
import {
  bridgeEvidence,
  decideAttribution,
  echoAccountCandidate,
  parseDriveActivity,
  type DriveActivityRecord,
  type IdentityBridge,
} from "./driveActivity.js";

/**
 * Changes made in Google directly (GOOGLE_SHEETS.md §3, Phase 8). Reads Drive Activity for each
 * MONITORED, reachable spreadsheet — a few per tick, each at most every POLL_INTERVAL — and adds one
 * EXTERNAL_GOOGLE row per change Google reports to the activity log.
 *
 * Never more than Google says: an edit at a time, by an actor, sometimes. Never which cells, never for
 * how long — so these rows count as "edits in Google" and never as work time. Credited to a person
 * only through `decideAttribution`'s conservative rule; Google's own record of a change the APP made
 * (its connected account, within moments of an application change on the same sheet) is linked to
 * that change as an echo and never counted twice.
 *
 * Idempotent: every row carries a deterministic `externalKey`, unique per project, and each read
 * overlaps the last by READ_OVERLAP_MS, so nothing is missed at the edge and nothing is doubled.
 * Off for a project whose feature is off, whose Google integration is switched off or has no usable
 * OAuth client (its own, or the server's environment fallback — `decideGoogleClient`, the same rule
 * the dashboard applies), or whose manager switched external reading off in the module's settings.
 */

const LOOP_NAME = "google-external-activity";
/** How often one sheet is read. */
export const POLL_INTERVAL_MS = 15 * 60_000;
/** Sheets read per tick, per project. */
const SHEETS_PER_TICK = 3;
/** Each read starts this much before where the last one ended. */
const READ_OVERLAP_MS = 10 * 60_000;
/** The first read of a newly monitored sheet goes back at most this far. */
const FIRST_READ_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** An application change and Google's record of it are this close in time. */
const ECHO_WINDOW_MS = 3 * 60_000;

export function startGoogleExternalActivityProcessor(intervalMs = 60_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void runGoogleExternalActivityTick()
      .catch((err) => console.error("[google-sheets] unexpected error reading Google activity", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

/** One pass over every operating project. Exported for tests. */
export async function runGoogleExternalActivityTick(now: Date = new Date(), fetchImpl: FetchImpl = fetch): Promise<void> {
  await forEachProject(LOOP_NAME, async () => {
    if (!(await projectHasFeature("GOOGLE_SHEETS"))) return;
    const config = await projectClient();
    if (!config) return;
    const settings = await prisma.googleSheetsSettings.findUnique({ where: { id: "global" }, select: { externalActivityEnabled: true } });
    if (settings && !settings.externalActivityEnabled) return;
    const due = await prisma.googleSpreadsheet.findMany({
      where: {
        isMonitored: true,
        removedAt: null,
        OR: [{ externalActivityCheckedAt: null }, { externalActivityCheckedAt: { lt: new Date(now.getTime() - POLL_INTERVAL_MS) } }],
      },
      orderBy: [{ externalActivityCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: SHEETS_PER_TICK,
      select: { id: true, name: true, googleFileId: true, monitoredAt: true, firstSeenAt: true, externalActivityCheckedThrough: true },
    });
    for (const sheet of due) {
      try {
        await readSheetActivity(sheet, { config, now, fetchImpl });
      } catch (err) {
        console.error(`[google-sheets] reading Google activity for sheet ${sheet.id} failed`, err);
        await prisma.googleSpreadsheet.update({
          where: { id: sheet.id },
          data: { externalActivityCheckedAt: now, externalActivityError: "Reading changes made in Google failed unexpectedly. It is tried again later." },
        });
      }
    }
  });
}

/** This project's OAuth client, or null when its integration is off or has no usable client. */
async function projectClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await prisma.googleIntegrationConfig.findUnique({
    where: { id: "global" },
    select: { enabled: true, clientId: true, clientSecretCiphertext: true, validationStatus: true },
  });
  const decision = decideGoogleClient(row, { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET });
  if (!decision.ok) return null;
  if (decision.source === "ENVIRONMENT") return { clientId: decision.clientId, clientSecret: decision.secret };
  try {
    return { clientId: decision.clientId, clientSecret: decryptSecret(decision.secretCiphertext) };
  } catch {
    console.error("[google-sheets] this project's OAuth client secret could not be decrypted; skipping");
    return null;
  }
}

type Sheet = { id: string; name: string; googleFileId: string; monitoredAt: Date | null; firstSeenAt: Date; externalActivityCheckedThrough: Date | null };
type Context = { config: { clientId: string; clientSecret: string }; now: Date; fetchImpl: FetchImpl };

class AccountUnavailable extends Error {}

/** A working access token for a connected account, refreshed when needed. Same rules as the dashboard's. */
async function accessToken(accountId: string, ctx: Context): Promise<string> {
  const row = await prisma.googleIntegrationAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, status: true, oauthClientId: true, refreshTokenCiphertext: true, accessTokenCiphertext: true, accessTokenExpiresAt: true },
  });
  if (!row || row.status !== "CONNECTED" || !row.refreshTokenCiphertext) throw new AccountUnavailable("The Google account needs to be connected again.");
  // Tokens another OAuth client issued cannot be used with this one (the project changed its client).
  if (!tokensIssuedTo(row, ctx.config.clientId, process.env.GOOGLE_OAUTH_CLIENT_ID)) {
    await prisma.googleIntegrationAccount.update({
      where: { id: row.id },
      data: { status: "NEEDS_RECONNECT", refreshTokenCiphertext: null, accessTokenCiphertext: null, accessTokenExpiresAt: null, lastError: CLIENT_CHANGED_MESSAGE },
    });
    throw new AccountUnavailable(`${row.email} needs to be connected again.`);
  }
  if (row.accessTokenCiphertext && row.accessTokenExpiresAt && row.accessTokenExpiresAt > ctx.now) return decryptSecret(row.accessTokenCiphertext);
  try {
    const tokens = await refreshAccessToken(ctx.config, decryptSecret(row.refreshTokenCiphertext), ctx.fetchImpl);
    await prisma.googleIntegrationAccount.update({
      where: { id: row.id },
      data: {
        accessTokenCiphertext: encryptSecret(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        ...(tokens.refreshToken ? { refreshTokenCiphertext: encryptSecret(tokens.refreshToken) } : {}),
        lastError: null,
      },
    });
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.needsReconnect) {
      await prisma.googleIntegrationAccount.update({
        where: { id: row.id },
        data: {
          status: "NEEDS_RECONNECT",
          refreshTokenCiphertext: null,
          accessTokenCiphertext: null,
          accessTokenExpiresAt: null,
          lastError: "Google no longer accepts this connection (access was removed, it expired, or the password changed). Connect the account again.",
        },
      });
      throw new AccountUnavailable(`${row.email} needs to be connected again.`);
    }
    throw err;
  }
}

/** The project's identity bridge, from what its accounts have shown so far. A mismatch anywhere wins. */
async function identityBridge(): Promise<IdentityBridge> {
  const accounts = await prisma.googleIntegrationAccount.findMany({ select: { activityIdentityVerifiedAt: true, activityIdentityMismatchAt: true } });
  if (accounts.some((a) => a.activityIdentityMismatchAt)) return "MISMATCH";
  return accounts.some((a) => a.activityIdentityVerifiedAt) ? "VERIFIED" : "UNVERIFIED";
}

/** Read one sheet's activity since the last read and add what is new to the log. */
export async function readSheetActivity(sheet: Sheet, ctx: Context): Promise<{ added: number }> {
  const path = await prisma.googleSpreadsheetAccess.findFirst({
    where: { spreadsheetId: sheet.id, removedAt: null, googleAccount: { status: "CONNECTED", grantedScopes: { has: DRIVE_ACTIVITY_SCOPE } } },
    orderBy: { firstSeenAt: "asc" },
    select: { googleAccount: { select: { id: true, email: true, googleSubject: true } } },
  });
  const fail = (message: string) =>
    prisma.googleSpreadsheet.update({ where: { id: sheet.id }, data: { externalActivityCheckedAt: ctx.now, externalActivityError: message } }).then(() => ({ added: 0 }));
  if (!path) {
    return fail("No connected Google account that reaches this spreadsheet allows reading changes made in Google. Connect the account again and allow “activity” on Google's screen.");
  }
  const account = path.googleAccount;

  const since = sheet.externalActivityCheckedThrough
    ? new Date(sheet.externalActivityCheckedThrough.getTime() - READ_OVERLAP_MS)
    : new Date(Math.max((sheet.monitoredAt ?? sheet.firstSeenAt).getTime() - READ_OVERLAP_MS, ctx.now.getTime() - FIRST_READ_LOOKBACK_MS));

  let raw: { activities: unknown[]; complete: boolean };
  try {
    let token = await accessToken(account.id, ctx);
    try {
      raw = await queryDriveActivity(token, sheet.googleFileId, since, ctx.fetchImpl);
    } catch (err) {
      if (!(err instanceof GoogleApiError) || err.status !== 401) throw err;
      await prisma.googleIntegrationAccount.update({ where: { id: account.id }, data: { accessTokenExpiresAt: new Date(0) } });
      token = await accessToken(account.id, ctx);
      raw = await queryDriveActivity(token, sheet.googleFileId, since, ctx.fetchImpl);
    }
  } catch (err) {
    if (err instanceof AccountUnavailable) return fail(`${account.email} needs to be connected again before changes made in Google can be read.`);
    if (err instanceof GoogleApiError) {
      if (err.status === 403) return fail(`Google refused to show this spreadsheet's activity to ${account.email}. Check that the Drive Activity API is enabled in Google Cloud and that the account still has access.`);
      if (err.status === 429) return fail("Google is limiting requests just now; it is tried again later.");
      return fail("Google could not show this spreadsheet's activity just now; it is tried again later.");
    }
    throw err;
  }

  const records = raw.activities.map((a) => parseDriveActivity(a, sheet.googleFileId)).filter((r): r is DriveActivityRecord => r !== null);

  // The account's own changes prove (or disprove) that Google's actor ids are sign-in ids.
  const evidence = records.map((r) => bridgeEvidence(r, account.googleSubject)).filter(Boolean);
  if (evidence.includes("MISMATCH")) {
    const already = await prisma.googleIntegrationAccount.findUnique({ where: { id: account.id }, select: { activityIdentityMismatchAt: true } });
    if (!already?.activityIdentityMismatchAt) {
      await prisma.googleIntegrationAccount.update({ where: { id: account.id }, data: { activityIdentityMismatchAt: ctx.now } });
      await logSystemEvent("WARN", "google-sheets", `Google's activity ids did not match sign-in for ${account.email}; changes made in Google will not be credited to anyone`, {}, { targetType: "GoogleIntegrationAccount", targetId: account.id });
    }
  } else if (evidence.includes("MATCH")) {
    await prisma.googleIntegrationAccount.updateMany({ where: { id: account.id, activityIdentityVerifiedAt: null }, data: { activityIdentityVerifiedAt: ctx.now } });
  }
  const bridge = await identityBridge();

  const personIds = [...new Set(records.flatMap((r) => r.actors.map((a) => (a.kind === "KNOWN_USER" ? a.personId : null)).filter((id): id is string => Boolean(id))))];
  const [identityRows, accounts, links, periods] = await Promise.all([
    personIds.length ? platformPrisma.userGoogleIdentity.findMany({ where: { googleSubject: { in: personIds } }, select: { googleSubject: true, userId: true } }) : Promise.resolve([]),
    prisma.googleIntegrationAccount.findMany({ select: { id: true, googleSubject: true } }),
    prisma.internalTeamMember.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true } }),
    prisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId: sheet.id }, select: { userId: true, role: true, startedAt: true, endedAt: true } }),
  ]);
  const identities = new Map(identityRows.map((i) => [i.googleSubject, i.userId]));
  const accountsBySubject = new Map(accounts.map((a) => [a.googleSubject, a.id]));
  const teamMemberByUser = new Map(links.map((l) => [l.userId as string, l.id]));

  const known = new Set(
    (
      await prisma.googleSheetActivity.findMany({
        where: { spreadsheetId: sheet.id, externalKey: { in: records.map((r) => r.key) } },
        select: { externalKey: true },
      })
    ).map((r) => r.externalKey),
  );

  const rows = [];
  for (const record of records) {
    if (known.has(record.key)) continue;
    const echoAccount = echoAccountCandidate(record, { pollingAccountId: account.id, bridge, accountsBySubject });
    let echoOf: string | null = null;
    if (echoAccount && actionKind(record.actionType) === "WORK") {
      const appChange = await prisma.googleSheetActivity.findFirst({
        where: {
          spreadsheetId: sheet.id,
          source: "APPLICATION",
          kind: "WORK",
          googleAccountId: echoAccount,
          occurredAt: { gte: new Date(record.occurredAt.getTime() - ECHO_WINDOW_MS), lte: new Date(record.occurredAt.getTime() + ECHO_WINDOW_MS) },
        },
        orderBy: { occurredAt: "desc" },
        select: { id: true },
      });
      echoOf = appChange?.id ?? null;
    }
    const actor = record.actors.length === 1 ? record.actors[0]! : null;
    const base = {
      spreadsheetId: sheet.id,
      kind: actionKind(record.actionType),
      source: "EXTERNAL_GOOGLE" as const,
      actionType: record.actionType,
      googleAccountId: account.id,
      occurredAt: record.occurredAt,
      externalKey: record.key,
      externalActorPersonId: actor?.kind === "KNOWN_USER" && actor.personId ? `people/${actor.personId}` : null,
      externalActorKind: record.actors.length === 1 ? actor!.kind : record.actors.length === 0 ? "NONE" : "SEVERAL",
    };
    if (echoOf) {
      rows.push({ ...base, attribution: "APPLICATION_ECHO" as const, echoOfActivityId: echoOf });
      continue;
    }
    const decision = decideAttribution(record, { bridge, identities });
    if (decision.attribution === "ATTRIBUTED") {
      rows.push({
        ...base,
        attribution: "ATTRIBUTED" as const,
        userId: decision.userId,
        teamMemberId: teamMemberByUser.get(decision.userId) ?? null,
        memberRole: roleAt(periods, decision.userId, record.occurredAt),
      });
    } else {
      rows.push({ ...base, attribution: "UNATTRIBUTED" as const, unattributedReason: decision.reason });
    }
  }

  if (rows.length > 0) await prisma.googleSheetActivity.createMany({ data: rows, skipDuplicates: true });
  await prisma.googleSpreadsheet.update({
    where: { id: sheet.id },
    data: {
      externalActivityCheckedThrough: ctx.now,
      externalActivityCheckedAt: ctx.now,
      // Google lists newest first, so a read cut short is missing the OLDEST changes of the period.
      // Said, not hidden: re-reading from the same point would only stop at the same place again.
      externalActivityError: raw.complete ? null : `Google listed more than ${(MAX_ACTIVITY_PAGES * 100).toLocaleString("en-US")} changes since the last read; the oldest of them were not read.`,
    },
  });
  return { added: rows.length };
}
