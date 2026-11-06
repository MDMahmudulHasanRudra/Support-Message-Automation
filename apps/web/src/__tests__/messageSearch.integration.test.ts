import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { EMPTY_INBOX_FILTERS, parseInboxFilterSet } from "@support-automation/shared";

/**
 * Inbox V3 WhatsApp message search (whatsAppMessageSearch.ts, V3-06 Option A). The paged results must equal a
 * brute-force answer over the WHOLE history — newest matching message per conversation, newest first, ties by
 * account then chat — whichever phase answers (the scan budget is varied so phase 1 alone, phase 2 alone and the
 * hand-over between them all run), including a run of conversations tied on one timestamp across a page boundary.
 * Also: deleted-for-everyone messages are not searched; another project's account finds nothing; short terms and
 * LIKE wildcards are handled; and the All Conversations list shows text matches only with UNIFIED_INBOX_V3 on.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { searchWhatsAppMessages, MESSAGE_SEARCH_PAGE } = await import("@/server/whatsAppMessageSearch");
const { loadInbox } = await import("@/server/channels/inbox");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const TERM = `kivabe${tag}`;
let P = { id: "", slug: `msgsearch-${tag}`, name: `Msg Search ${tag}`, status: "ACTIVE" as const };
let Q = { id: "", slug: `msgsearch-q-${tag}`, name: `Msg Search Q ${tag}`, status: "ACTIVE" as const };
const inP = <T,>(fn: () => Promise<T>) => runWithProject(P, fn);
const inQ = <T,>(fn: () => Promise<T>) => runWithProject(Q, fn);
const fx = {} as { creator: string; a1: string; a2: string; q1: string; dense: string; sparse: string; deletedChat: string; groupChat: string };
const TERM2 = `uneven${tag}`;
const DAY = 86_400_000;
const T0 = Date.now() - 60_000;

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

async function feature(key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: P.id, key } }, create: { projectId: P.id, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}

type Msg = { projectId: string; accountId: string; chatId: string; body: string; at: number; revoked?: boolean; groupId?: string };
const rows: Msg[] = [];
async function flush() {
  for (let i = 0; i < rows.length; i += 500) {
    await rawPrisma.message.createMany({
      data: rows.slice(i, i + 500).map((m) => ({
        projectId: m.projectId,
        accountId: m.accountId,
        groupId: m.groupId ?? null,
        whatsappMessageId: randomUUID(),
        chatId: m.chatId,
        senderPhone: "8801911000111",
        direction: "INCOMING" as const,
        body: m.body,
        normalizedBody: m.body.toLowerCase(),
        timestampWa: new Date(m.at),
        processingStatus: "PROCESSED" as const,
        revokedAt: m.revoked ? new Date(m.at + 1000) : null,
      })),
    });
  }
  rows.length = 0;
}

/** The answer by brute force: every match, newest per conversation, ordered as the search promises. */
async function groundTruth(projectId: string, accountIds: string[], term: string) {
  const all = await rawPrisma.message.findMany({
    where: { projectId, accountId: { in: accountIds }, body: { contains: term, mode: "insensitive" }, revokedAt: null },
    select: { id: true, accountId: true, chatId: true, timestampWa: true },
  });
  const newest = new Map<string, (typeof all)[number]>();
  const later = (a: (typeof all)[number], b: (typeof all)[number]) => a.timestampWa.getTime() - b.timestampWa.getTime() || (a.id > b.id ? 1 : -1);
  for (const m of all) {
    const k = `${m.accountId}|${m.chatId}`;
    const cur = newest.get(k);
    if (!cur || later(m, cur) > 0) newest.set(k, m);
  }
  const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  return [...newest.values()]
    .sort((a, b) => b.timestampWa.getTime() - a.timestampWa.getTime() || desc(a.accountId, b.accountId) || desc(a.chatId, b.chatId))
    .map((m) => ({ key: `${m.accountId}|${m.chatId}`, messageId: m.id }));
}

async function allPages(accountIds: string[], term: string, recentBudget?: number) {
  const out: Array<{ key: string; messageId: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const r = await inP(() => searchWhatsAppMessages(accountIds, term, { cursor, seen: out.map((o) => o.key), recentBudget }));
    expect(r.timedOut).toBe(false);
    expect(r.matches.size).toBeLessThanOrEqual(MESSAGE_SEARCH_PAGE);
    for (const [key, m] of r.matches) out.push({ key, messageId: m.messageId });
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

beforeAll(async () => {
  fx.creator = (await rawPrisma.user.create({ data: { username: `ms_${tag}`, email: `ms_${tag}@example.test`, name: "Creator", passwordHash: "x" } })).id;
  P = { ...P, id: (await createProjectWithDefaults({ name: P.name, slug: P.slug, status: "ACTIVE", creatorUserId: fx.creator }, rawPrisma)).id };
  Q = { ...Q, id: (await createProjectWithDefaults({ name: Q.name, slug: Q.slug, status: "ACTIVE", creatorUserId: fx.creator }, rawPrisma)).id };
  fx.a1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `S1 ${tag}`, status: "CONNECTED" } })).id;
  fx.a2 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `S2 ${tag}`, status: "CONNECTED" } })).id;
  fx.q1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: Q.id, label: `Q1 ${tag}`, status: "CONNECTED" } })).id;
  fx.dense = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `Dense ${tag}`, status: "CONNECTED" } })).id;
  fx.sparse = (await rawPrisma.whatsAppAccount.create({ data: { projectId: P.id, label: `Sparse ${tag}`, status: "CONNECTED" } })).id;

  // 230 conversations over two accounts. Conversation i's newest match is i minutes before T0 — except 95..104,
  // which all share one timestamp, so the tie straddles the end of page 1. Each also has older matches, newer
  // non-matching messages and noise up to 400 days back; a third have their newest match over 30 days old.
  for (let i = 0; i < 230; i++) {
    const accountId = i % 3 === 0 ? fx.a2 : fx.a1;
    const chatId = `c${String(i).padStart(3, "0")}-${tag}@g.us`;
    const old = i % 3 === 1 ? 40 * DAY + i * 3_600_000 : 0;
    const newestMatch = T0 - old - (i >= 95 && i <= 104 ? 95 : i) * 60_000;
    rows.push({ projectId: P.id, accountId, chatId, body: `vai bill ${TERM.toUpperCase()} dibo`, at: newestMatch });
    for (let k = 0; k < 3; k++) rows.push({ projectId: P.id, accountId, chatId, body: `ager ${TERM} ${k}`, at: newestMatch - (1 + rand() * 300) * DAY });
    for (let k = 0; k < 2; k++) rows.push({ projectId: P.id, accountId, chatId, body: `ok vai ${k}`, at: newestMatch + (1 + rand() * 50) * 1000 });
    rows.push({ projectId: P.id, accountId, chatId, body: "noise", at: T0 - rand() * 400 * DAY });
  }
  // A newer match that was deleted for everyone: the older one still counts, the deleted one never.
  rows.push({ projectId: P.id, accountId: fx.a1, chatId: `c001-${tag}@g.us`, body: `deleted ${TERM}`, at: T0, revoked: true });
  // A conversation whose only match was deleted.
  fx.deletedChat = `deleted-${tag}@g.us`;
  rows.push({ projectId: P.id, accountId: fx.a1, chatId: fx.deletedChat, body: `only ${TERM}`, at: T0 - 5 * DAY, revoked: true });
  // Conversations without the term at all.
  for (let i = 0; i < 40; i++) rows.push({ projectId: P.id, accountId: fx.a1, chatId: `none${i}-${tag}@g.us`, body: "router restart korsi", at: T0 - rand() * 10 * DAY });
  // The same term in another project.
  for (let i = 0; i < 5; i++) rows.push({ projectId: Q.id, accountId: fx.q1, chatId: `q${i}-${tag}@g.us`, body: `${TERM} in Q`, at: T0 - i * DAY });
  // Uneven accounts (TERM2): a busy number whose newest 300 messages are all chatter from the last hour, with its
  // matches 1–60 hours old; and a quiet number whose few messages, all matches, go back months. Phase 1 reads far
  // deeper in time on the quiet one, so only the coverage boundary keeps its old matches from outranking the busy
  // number’s newer ones.
  for (let i = 0; i < 300; i++) rows.push({ projectId: P.id, accountId: fx.dense, chatId: `busy${i % 30}-${tag}@g.us`, body: "ok vai", at: T0 - i * 10_000 });
  for (let i = 0; i < 60; i++) rows.push({ projectId: P.id, accountId: fx.dense, chatId: `busy${i % 30}-${tag}@g.us`, body: `hourly ${TERM2}`, at: T0 - (i + 1) * 3_600_000 });
  for (let i = 0; i < 60; i++) rows.push({ projectId: P.id, accountId: fx.sparse, chatId: `quiet${i}-${tag}@g.us`, body: `monthly ${TERM2}`, at: T0 - (i + 1) * 3 * DAY });
  // A literal percent sign, for the wildcard test.
  rows.push({ projectId: P.id, accountId: fx.a2, chatId: `pct-${tag}@g.us`, body: `discount 50%off${tag}`, at: T0 - DAY });
  await flush();

  // A real group, named nothing like what its messages say — for the list test.
  fx.groupChat = `listed-${tag}@g.us`;
  const g = await rawPrisma.whatsAppGroup.create({ data: { projectId: P.id, accountId: fx.a1, whatsappGroupId: fx.groupChat, name: `Plain group ${tag}`, isActive: true } });
  rows.push({ projectId: P.id, accountId: fx.a1, chatId: fx.groupChat, groupId: g.id, body: `my zebra${tag} router is down since morning`, at: T0 - 200 * DAY });
  rows.push({ projectId: P.id, accountId: fx.a1, chatId: fx.groupChat, groupId: g.id, body: "thanks", at: T0 - 1000 });
  await flush();
}, 120_000);

afterAll(async () => {
  for (const p of [P.id, Q.id].filter(Boolean)) {
    const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
    for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, p).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id: p } });
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: fx.creator } });
  await rawPrisma.user.deleteMany({ where: { id: fx.creator } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("full-history message search", () => {
  it.each([
    ["phase 1 only (the default budget reads everything here)", undefined],
    ["phase 1 then phase 2 (25 recent rows per account)", 25],
    ["almost all phase 2 (3 recent rows per account)", 3],
  ])("pages equal the brute-force answer exactly — %s", async (_label, budget) => {
    const truth = await groundTruth(P.id, [fx.a1, fx.a2], TERM);
    expect(truth.length).toBe(230);
    const got = await allPages([fx.a1, fx.a2], TERM, budget);
    expect(got).toEqual(truth);
    expect(new Set(got.map((g) => g.key)).size).toBe(got.length);
  });

  it("finds matches far older than 30 days, and not a deleted-for-everyone message", async () => {
    const got = await allPages([fx.a1, fx.a2], TERM);
    expect(got.some((g) => g.key === `${fx.a1}|c001-${tag}@g.us`)).toBe(true);
    expect(got.some((g) => g.key.endsWith(fx.deletedChat))).toBe(false);
    // c001's deleted match was newest; the result is its older, live one.
    const c001 = (await inP(() => searchWhatsAppMessages([fx.a1], TERM))).matches.get(`${fx.a1}|c001-${tag}@g.us`);
    expect(c001?.snippet).not.toMatch(/deleted/);
    expect(c001?.snippet).toMatch(new RegExp(TERM, "i"));
  });

  it("is confined to the project: another project's account finds nothing, and each project sees its own", async () => {
    expect((await inP(() => searchWhatsAppMessages([fx.q1], TERM))).matches.size).toBe(0);
    const q = await inQ(() => searchWhatsAppMessages([fx.q1], TERM));
    expect(q.matches.size).toBe(5);
    expect([...q.matches.values()].every((m) => m.accountId === fx.q1)).toBe(true);
  });

  it.each([[20], [5], [undefined]])("ranks uneven accounts by time, not by how deep phase 1 reached (budget %s)", async (budget) => {
    const truth = await groundTruth(P.id, [fx.dense, fx.sparse], TERM2);
    expect(truth.length).toBe(90);
    expect(await allPages([fx.dense, fx.sparse], TERM2, budget)).toEqual(truth);
  });

  it("phase 2 is confined to the project too: a foreign account mixed with our own finds only ours", async () => {
    // Our own account forces phase 2 (one row covers it); the term exists only in the other project.
    expect((await inP(() => searchWhatsAppMessages([fx.a1, fx.q1], `${TERM} in Q`, { recentBudget: 1 }))).matches.size).toBe(0);
    expect((await inQ(() => searchWhatsAppMessages([fx.q1], `${TERM} in Q`))).matches.size).toBe(5);
  });

  it("searches only the accounts it is given", async () => {
    const r = await allPages([fx.a2], TERM);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((g) => g.key.startsWith(`${fx.a2}|`))).toBe(true);
  });

  it("refuses a term too short for the index, and matches LIKE wildcards literally", async () => {
    expect(await inP(() => searchWhatsAppMessages([fx.a1, fx.a2], "ok"))).toMatchObject({ tooShort: true, matches: new Map() });
    const pct = await inP(() => searchWhatsAppMessages([fx.a1, fx.a2], `50%off${tag}`));
    expect([...pct.matches.keys()]).toEqual([`${fx.a2}|pct-${tag}@g.us`]);
    expect((await inP(() => searchWhatsAppMessages([fx.a1, fx.a2], `5_%off${tag}`))).matches.size).toBe(0);
    expect((await inP(() => searchWhatsAppMessages([fx.a1, fx.a2], "%%%"))).matches.size).toBe(0);
  });

  it("refuses a cursor it did not make", async () => {
    expect((await inP(() => searchWhatsAppMessages([fx.a1], TERM, { cursor: "not-a-cursor" }))).matches.size).toBe(0);
  });
});

describe("in the All Conversations list", () => {
  const search = async (term: string) => (await inP(() => loadInbox({ scope: "all", filters: parseInboxFilterSet({ ...EMPTY_INBOX_FILTERS, search: term }), viewerId: fx.creator })));

  it("with Inbox V3 on, a conversation whose message text matches is listed with the matching snippet", async () => {
    await feature("UNIFIED_INBOX_V3", true);
    const r = await search(`zebra${tag}`);
    const row = r.items.find((i) => i.title === `Plain group ${tag}`);
    expect(row?.messageMatch?.snippet).toMatch(new RegExp(`zebra${tag} router`));
    expect(r.messageSearch).toMatchObject({ timedOut: false, tooShort: false, matched: 1 });
  });

  it("with Inbox V3 off, the list searches names only, as before", async () => {
    await feature("UNIFIED_INBOX_V3", false);
    const r = await search(`zebra${tag}`);
    expect(r.items.find((i) => i.title === `Plain group ${tag}`)).toBeUndefined();
    expect(r.messageSearch).toBeNull();
    expect((await search(`Plain group ${tag}`)).items.some((i) => i.title === `Plain group ${tag}`)).toBe(true);
  });
});
