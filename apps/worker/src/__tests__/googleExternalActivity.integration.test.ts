import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, ORIGINAL_PROJECT_ID } from "@support-automation/db";
import { inIsp, rawPrisma } from "./helpers/projectFixtures.js";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { readSheetActivity, runGoogleExternalActivityTick } from "../googleSheets/externalActivityProcessor.js";

/**
 * Google Sheets Phase 8 — changes made in Google directly (GOOGLE_SHEETS.md §3), against the isolated
 * database and a fake Drive Activity API.
 *
 * What must hold: only monitored sheets, only through an account that granted the activity scope;
 * nothing is credited until Google is SEEN to use sign-in's account ids (an account's own change), and
 * nothing at all once it is seen not to; a credit goes only to the login that linked that Google
 * account itself, with its team member and sheet role at that moment; Google's record of the app's own
 * change is an echo, never counted twice; reading the same period again adds nothing; the bridge of
 * one project never decides another's.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ACTIVITY_SCOPE = "https://www.googleapis.com/auth/drive.activity.readonly";
const config = { clientId: "test-client", clientSecret: "test-secret" };
const T = new Date("2026-10-09T05:00:00.000Z");
const minutes = (m: number) => new Date(T.getTime() + m * 60_000);

// ── A fake Google ────────────────────────────────────────────────────────────────────────────────────
const google = {
  activities: new Map<string, unknown[]>(),
  queries: [] as Array<{ fileId: string; filter: string; token: string }>,
  refreshFailure: null as string | null,
  activityStatus: 200,
  validTokens: new Set<string>(),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.href === "https://oauth2.googleapis.com/token") {
    if (google.refreshFailure) return json({ error: google.refreshFailure }, 400);
    const token = `fresh-${randomUUID()}`;
    google.validTokens.add(token);
    return json({ access_token: token, expires_in: 3600 });
  }
  if (url.href === "https://driveactivity.googleapis.com/v2/activity:query") {
    const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace("Bearer ", "");
    if (!google.validTokens.has(token)) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    if (google.activityStatus !== 200) return json({ error: { code: google.activityStatus, status: "PERMISSION_DENIED", message: "Drive Activity API has not been used" } }, google.activityStatus);
    const body = JSON.parse(String(init?.body));
    const fileId = String(body.itemName).replace("items/", "");
    google.queries.push({ fileId, filter: body.filter, token });
    return json({ activities: google.activities.get(fileId) ?? [] });
  }
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;

const known = (sub: string, isCurrentUser = false) => ({ user: { knownUser: { personName: `people/${sub}`, isCurrentUser } } });
const act = (actors: unknown[], at: Date, detail: Record<string, unknown> = { edit: {} }) => ({ primaryActionDetail: detail, actors, timestamp: at.toISOString() });

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const ids = { users: [] as string[], role: "", bizId: "" };
const subs = { accountA: `subA-${tag}`, accountNoScope: `subN-${tag}`, borhan: `subBorhan-${tag}`, stranger: `subStranger-${tag}`, bizAccount: `subBiz-${tag}` };
let accountA = "";
let borhanUser = "";
let borhanTeam = "";
let sheet = "";
let sheetNoScope = "";
let sheetUnmonitored = "";
let bizSheet = "";
let appChange = "";

async function account(projectId: string, subject: string, scopes: string[]) {
  const token = `access-${subject}`;
  google.validTokens.add(token);
  return (
    await rawPrisma.googleIntegrationAccount.create({
      data: {
        projectId,
        googleSubject: subject,
        email: `${subject}@example.test`,
        status: "CONNECTED",
        grantedScopes: ["https://www.googleapis.com/auth/spreadsheets", ...scopes],
        refreshTokenCiphertext: encryptSecret(`refresh-${subject}`),
        accessTokenCiphertext: encryptSecret(token),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    })
  ).id;
}
async function monitoredSheet(projectId: string, name: string, accountId: string) {
  const row = await rawPrisma.googleSpreadsheet.create({
    data: { projectId, googleFileId: `${tag}-${name}`, name, isMonitored: true, monitoredAt: minutes(-60) },
  });
  await rawPrisma.googleSpreadsheetAccess.create({ data: { projectId, spreadsheetId: row.id, googleAccountId: accountId, canEdit: true } });
  return row.id;
}
const sheetRow = (id: string) =>
  rawPrisma.googleSpreadsheet.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, googleFileId: true, monitoredAt: true, firstSeenAt: true, externalActivityCheckedThrough: true } });
const external = (spreadsheetId: string) => rawPrisma.googleSheetActivity.findMany({ where: { spreadsheetId, source: "EXTERNAL_GOOGLE" }, orderBy: [{ occurredAt: "asc" }, { externalActorPersonId: "asc" }] });

beforeAll(async () => {
  const role = await rawPrisma.permissionModule.create({ data: { name: `GS external ${tag}` } });
  ids.role = role.id;
  const mk = async (name: string) => {
    const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, name, passwordHash: "x", permissionModuleId: role.id } });
    ids.users.push(u.id);
    return u.id;
  };
  borhanUser = await mk("borhan");
  const rudraUser = await mk("rudra");
  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  ids.bizId = (existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: rudraUser }, rawPrisma))).id;
  for (const projectId of [ORIGINAL_PROJECT_ID, ids.bizId]) {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } }, create: { projectId, key: "GOOGLE_SHEETS", enabled: true }, update: { enabled: true } });
  }
  resetProjectFeatureCacheForTests();
  resetProjectCachesForTests();

  borhanTeam = (await rawPrisma.internalTeamMember.create({ data: { projectId: ORIGINAL_PROJECT_ID, name: "Borhan (roster)", phoneNumber: `88017${String(Date.now()).slice(-8)}`, role: "Support", userId: borhanUser } })).id;
  // Borhan proved, by signing in, that this Google account is his.
  await rawPrisma.userGoogleIdentity.create({ data: { userId: borhanUser, googleSubject: subs.borhan, email: "borhan@gmail.test" } });

  accountA = await account(ORIGINAL_PROJECT_ID, subs.accountA, [ACTIVITY_SCOPE]);
  const accountNoScope = await account(ORIGINAL_PROJECT_ID, subs.accountNoScope, []);
  sheet = await monitoredSheet(ORIGINAL_PROJECT_ID, "followup", accountA);
  sheetNoScope = await monitoredSheet(ORIGINAL_PROJECT_ID, "noscope", accountNoScope);
  // Reachable through an account that allowed activity — but nobody chose to monitor it.
  sheetUnmonitored = await monitoredSheet(ORIGINAL_PROJECT_ID, "unmonitored", accountA);
  await rawPrisma.googleSpreadsheet.update({ where: { id: sheetUnmonitored }, data: { isMonitored: false, monitoredAt: null } });
  await rawPrisma.googleSpreadsheetMember.create({ data: { projectId: ORIGINAL_PROJECT_ID, spreadsheetId: sheet, userId: borhanUser, role: "EDITOR", startedAt: new Date("2026-01-01T00:00:00Z") } });
  // A change Rudra saved through the app, carried by account A.
  appChange = (
    await rawPrisma.googleSheetActivity.create({
      data: { projectId: ORIGINAL_PROJECT_ID, spreadsheetId: sheet, kind: "WORK", source: "APPLICATION", actionType: "CELLS_EDITED", attribution: "APPLICATION", userId: rudraUser, googleAccountId: accountA, occurredAt: minutes(30) },
    })
  ).id;

  const bizAccount = await account(ids.bizId, subs.bizAccount, [ACTIVITY_SCOPE]);
  bizSheet = await monitoredSheet(ids.bizId, "biz", bizAccount);
});

afterAll(async () => {
  const sheetIds = [sheet, sheetNoScope, sheetUnmonitored, bizSheet].filter(Boolean);
  await rawPrisma.googleSheetActivity.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSpreadsheetMember.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { id: { in: sheetIds } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.googleSheetsSettings.deleteMany({ where: { projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.userGoogleIdentity.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: borhanTeam } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  resetProjectFeatureCacheForTests();
  vi.unstubAllEnvs();
});

const read = async (id: string, now: Date, projectId = ORIGINAL_PROJECT_ID) =>
  withProject(projectId, async () => readSheetActivity(await sheetRow(id), { config, now, fetchImpl: fakeFetch }));

describe("1. which sheets are read, through which account", () => {
  it("a sheet reached only through an account that did not allow activity is not read — and says why", async () => {
    google.queries.length = 0;
    expect(await read(sheetNoScope, minutes(120))).toEqual({ added: 0 });
    expect(google.queries).toEqual([]);
    expect((await rawPrisma.googleSpreadsheet.findUnique({ where: { id: sheetNoScope } }))!.externalActivityError).toMatch(/allow/);
  });

  it("the tick does nothing without the server's OAuth client, or with the module's reading switched off", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    google.queries.length = 0;
    await runGoogleExternalActivityTick(minutes(120), fakeFetch);
    expect(google.queries).toEqual([]);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
    await rawPrisma.googleSheetsSettings.upsert({ where: { projectId: ORIGINAL_PROJECT_ID }, create: { id: "global", projectId: ORIGINAL_PROJECT_ID, externalActivityEnabled: false }, update: { externalActivityEnabled: false } });
    await runGoogleExternalActivityTick(minutes(120), fakeFetch);
    expect(google.queries.filter((q) => q.fileId.startsWith(tag) && q.fileId !== `${tag}-biz`)).toEqual([]);
    await rawPrisma.googleSheetsSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { externalActivityEnabled: true } });
  });

  it("a sheet nobody chose to monitor is never read, even through an account that allowed activity", async () => {
    // Keep the monitored follow-up sheet out of this tick (not due), so its first read stays for §2.
    await rawPrisma.googleSpreadsheet.update({ where: { id: sheet }, data: { externalActivityCheckedAt: minutes(119) } });
    google.queries.length = 0;
    await runGoogleExternalActivityTick(minutes(120), fakeFetch);
    await rawPrisma.googleSpreadsheet.update({ where: { id: sheet }, data: { externalActivityCheckedAt: null } });
    expect(google.queries.map((q) => q.fileId)).not.toContain(`${tag}-unmonitored`);
    expect((await rawPrisma.googleSpreadsheet.findUnique({ where: { id: sheetUnmonitored } }))!.externalActivityCheckedAt).toBeNull();
  });
});

describe("2. crediting changes made in Google", () => {
  it("before Google is seen to use sign-in's ids, even a linked person's change is NOT credited", async () => {
    google.activities.set(`${tag}-followup`, [act([known(subs.borhan)], minutes(10))]);
    google.queries.length = 0;
    expect(await read(sheet, minutes(20))).toEqual({ added: 1 });
    // The first read starts a little before monitoring started.
    expect(google.queries[0]!.filter).toBe(`time >= "${minutes(-70).toISOString()}"`);
    expect(await external(sheet)).toMatchObject([{ attribution: "UNATTRIBUTED", unattributedReason: "BRIDGE_UNVERIFIED", userId: null, externalActorPersonId: `people/${subs.borhan}`, kind: "WORK" }]);
  });

  it("the account's own change matching its sign-in id confirms the bridge; Google's record of the app's save is an echo; a linked person is credited with team and role", async () => {
    google.activities.set(`${tag}-followup`, [
      act([known(subs.borhan)], minutes(10)), // already read
      act([known(subs.accountA, true)], minutes(31)), // the app's own save at +30, seen by Google
      act([known(subs.borhan)], minutes(40)),
      act([known(subs.stranger)], minutes(41)),
      act([known(subs.borhan), known(subs.stranger)], minutes(42)),
      act([{ anonymous: {} }], minutes(43)),
      act([known(subs.borhan)], minutes(44), { comment: {} }),
    ]);
    google.queries.length = 0;
    expect(await read(sheet, minutes(60))).toEqual({ added: 6 });
    // The next read overlaps the last by ten minutes; duplicates are dropped by key.
    expect(google.queries[0]!.filter).toBe(`time >= "${minutes(10).toISOString()}"`);
    expect((await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: accountA } }))!.activityIdentityVerifiedAt).not.toBeNull();

    const rows = await external(sheet);
    const by = (m: number) => rows.filter((r) => r.occurredAt.getTime() === minutes(m).getTime());
    expect(by(10)).toMatchObject([{ attribution: "UNATTRIBUTED", unattributedReason: "BRIDGE_UNVERIFIED" }]); // the past is not rewritten
    expect(by(31)).toMatchObject([{ attribution: "APPLICATION_ECHO", echoOfActivityId: appChange, userId: null }]);
    expect(by(40)).toMatchObject([{ attribution: "ATTRIBUTED", userId: borhanUser, teamMemberId: borhanTeam, memberRole: "EDITOR", googleAccountId: accountA }]);
    expect(by(41)).toMatchObject([{ attribution: "UNATTRIBUTED", unattributedReason: "NO_LINKED_IDENTITY" }]);
    expect(by(42)).toMatchObject([{ attribution: "UNATTRIBUTED", unattributedReason: "SEVERAL_ACTORS", externalActorKind: "SEVERAL" }]);
    expect(by(43)).toMatchObject([{ attribution: "UNATTRIBUTED", unattributedReason: "ANONYMOUS" }]);
    expect(by(44)).toMatchObject([{ attribution: "ATTRIBUTED", actionType: "EXTERNAL_COMMENT", kind: "OTHER" }]);
    // Never a range, never a value: Google does not say which cells.
    expect(rows.every((r) => r.range === null && r.itemCount === null)).toBe(true);
  });

  it("reading the same period again adds nothing", async () => {
    const before = (await external(sheet)).length;
    expect(await read(sheet, minutes(61))).toEqual({ added: 0 });
    expect((await external(sheet)).length).toBe(before);
  });

  it("another project's mismatch stops crediting THERE, and only there", async () => {
    google.activities.set(`${tag}-biz`, [
      act([known(`not-${subs.bizAccount}`, true)], minutes(10)), // Google's id for the account's own change differs from its sign-in id
      act([known(subs.borhan)], minutes(11)), // Borhan's linked account, editing Bizify's sheet
    ]);
    await read(bizSheet, minutes(20), ids.bizId);
    const bizRows = await external(bizSheet);
    expect(bizRows.find((r) => r.externalActorPersonId === `people/${subs.borhan}`)).toMatchObject({ attribution: "UNATTRIBUTED", unattributedReason: "BRIDGE_MISMATCH" });
    expect((await rawPrisma.googleIntegrationAccount.findFirst({ where: { googleSubject: subs.bizAccount } }))!.activityIdentityMismatchAt).not.toBeNull();
    // ISP Digital's own bridge is untouched: a new change by Borhan there is still credited.
    google.activities.set(`${tag}-followup`, [act([known(subs.borhan)], minutes(70))]);
    await read(sheet, minutes(75));
    expect((await external(sheet)).at(-1)).toMatchObject({ attribution: "ATTRIBUTED", userId: borhanUser });
  });
});

describe("3. when Google refuses", () => {
  it("a refused grant marks the account for reconnecting and the sheet says so", async () => {
    await rawPrisma.googleIntegrationAccount.update({ where: { id: accountA }, data: { accessTokenExpiresAt: new Date(0) } });
    google.refreshFailure = "invalid_grant";
    await read(sheet, minutes(200));
    google.refreshFailure = null;
    expect(await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: accountA } })).toMatchObject({ status: "NEEDS_RECONNECT", refreshTokenCiphertext: null });
    expect((await rawPrisma.googleSpreadsheet.findUnique({ where: { id: sheet } }))!.externalActivityError).toMatch(/connected again/);
  });

  it("Drive Activity refusing (API not enabled) is worded, not thrown", async () => {
    google.activityStatus = 403;
    await read(bizSheet, minutes(300), ids.bizId);
    google.activityStatus = 200;
    expect((await rawPrisma.googleSpreadsheet.findUnique({ where: { id: bizSheet } }))!.externalActivityError).toMatch(/Drive Activity API/);
  });
});
