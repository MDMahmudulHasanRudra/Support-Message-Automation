import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Inbox V3 WhatsApp message-text search (V3-06, Option A): the conversations whose stored messages contain the
 * term, across the WHOLE history, ordered by their newest matching message. Measured on 3.6M generated messages
 * (INBOX_WORKSPACE.md § Message search); every number below comes from that run.
 *
 * Two phases, because the expensive part is not finding matches but grouping them by chat: a term in 4% of
 * messages touches nearly every heap page, whatever the index.
 *   1. RECENT: each account's newest messages through the existing ("accountId", "timestampWa") index, a fixed
 *      budget of rows, filtered by the term. A common term fills the page from here (~35 ms) — the conversations
 *      seen first walking backwards in time ARE the ones with the newest matches, so the order is exact.
 *   2. OLDER: only when phase 1 did not fill the page — the term is rare, or sits in few chats — the trigram
 *      index "Message_body_search_idx" (migration 20261106130000_message_body_search) for the part of history
 *      older than everything phase 1 read. Rare terms take ~1 ms; the worst measured case ~250 ms.
 *
 * Bounded so a search can never become an unbounded scan: at least MIN_TERM characters (shorter has no trigram);
 * one page of MESSAGE_SEARCH_PAGE conversations; at most MAX_SEEN conversations across pages; one core
 * (no parallel workers, so no shared-memory segments on the 64 MB /dev/shm the database container has); and a
 * statement timeout — a search out of time says so, and the name search still answers.
 *
 * Paging: the cursor is the newest-match time of the page's last conversation, and the caller passes back the
 * conversations it already holds (`seen`). The next page reads at or before that time, without those — so ties on
 * a timestamp are neither repeated nor skipped. Every query names "projectId". Messages deleted for everyone are
 * not searched. Text leaves only as a short snippet around the match.
 */

export const MESSAGE_SEARCH_PAGE = 100;
export const MESSAGE_SEARCH_MIN_TERM = 3;
export const MESSAGE_SEARCH_MAX_SEEN = 1_000;
const STATEMENT_TIMEOUT_MS = 3_000;
const RECENT_BUDGET = 12_000;
const MIN_BUDGET_PER_ACCOUNT = 500;
const SNIPPET_RADIUS = 60;

export interface MessageMatch {
  accountId: string;
  chatId: string;
  messageId: string;
  at: Date;
  snippet: string;
}

export interface MessageSearchResult {
  /** "accountId|chatId" → the newest matching message in that chat, in result order. */
  matches: Map<string, MessageMatch>;
  /** Opaque cursor for the next page, or null when this page is the last (or the paging limit is reached). */
  nextCursor: string | null;
  /** The search stopped at its time limit; nothing was returned. */
  timedOut: boolean;
  /** The term was too short to search message text. */
  tooShort: boolean;
  /** MESSAGE_SEARCH_MAX_SEEN conversations were shown; the search must be narrowed to go further. */
  limitReached: boolean;
}

const empty = (extra: Partial<MessageSearchResult> = {}): MessageSearchResult => ({ matches: new Map(), nextCursor: null, timedOut: false, tooShort: false, limitReached: false, ...extra });

export const matchKey = (accountId: string, chatId: string) => `${accountId}|${chatId}`;

export function encodeSearchCursor(at: Date): string {
  return Buffer.from(JSON.stringify({ v: 1, at: at.getTime() })).toString("base64url");
}
export function decodeSearchCursor(cursor: string | null | undefined): Date | null {
  if (!cursor || cursor.length > 200) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; at?: unknown };
    return v.v === 1 && typeof v.at === "number" && Number.isFinite(v.at) ? new Date(v.at) : null;
  } catch {
    return null;
  }
}

/** A short excerpt around the first case-insensitive occurrence of the term, on one line. */
export function snippetAround(body: string, term: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (at < 0) return flat.length > SNIPPET_RADIUS * 2 ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…` : flat;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

type Row = { accountId: string; chatId: string; id: string; timestampWa: Date; body: string };
const newestFirst = (a: Row, b: Row) =>
  b.timestampWa.getTime() - a.timestampWa.getTime() || (a.accountId < b.accountId ? 1 : a.accountId > b.accountId ? -1 : 0) || (a.chatId < b.chatId ? 1 : a.chatId > b.chatId ? -1 : 0) || (a.id < b.id ? 1 : -1);

export async function searchWhatsAppMessages(
  accountIds: string[],
  term: string,
  page?: { cursor?: string | null; seen?: readonly string[]; /** Tests only: phase 1 rows per account. */ recentBudget?: number },
): Promise<MessageSearchResult> {
  const text = term.trim();
  if (accountIds.length === 0) return empty();
  if ([...text].length < MESSAGE_SEARCH_MIN_TERM) return empty({ tooShort: text.length > 0 });
  const before = decodeSearchCursor(page?.cursor);
  if (page?.cursor && !before) return empty();
  const seen = new Set((page?.seen ?? []).filter((k) => typeof k === "string" && k.length <= 400).slice(0, MESSAGE_SEARCH_MAX_SEEN));
  if (seen.size >= MESSAGE_SEARCH_MAX_SEEN) return empty({ limitReached: true });

  const projectId = await activeProjectId();
  const like = `%${text.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const budget = page?.recentBudget ? Math.max(1, Math.floor(page.recentBudget)) : Math.max(MIN_BUDGET_PER_ACCOUNT, Math.floor(RECENT_BUDGET / accountIds.length));
  const notAfter = before ? Prisma.sql`AND m."timestampWa" <= ${before}` : Prisma.empty;

  try {
    const found = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
        await tx.$executeRawUnsafe(`SET LOCAL work_mem = '32MB'`);

        // Phase 1 — each account's newest `budget` messages; per account, how far back that reached.
        const recent = await tx.$queryRaw<Array<Row & { kind: "s" | "m"; n: number }>>`
          WITH scanned AS (
            SELECT r.* FROM unnest(ARRAY[${Prisma.join(accountIds)}]::text[]) AS a(id)
            CROSS JOIN LATERAL (
              SELECT m."accountId", m."chatId", m."id", m."timestampWa", m."body", m."revokedAt"
              FROM "Message" m
              WHERE m."projectId" = ${projectId} AND m."accountId" = a.id ${notAfter}
              ORDER BY m."timestampWa" DESC
              LIMIT ${budget}
            ) r
          )
          SELECT 's' AS "kind", "accountId", NULL::text AS "chatId", NULL::text AS "id", min("timestampWa") AS "timestampWa", count(*)::int AS "n", NULL::text AS "body"
          FROM scanned GROUP BY "accountId"
          UNION ALL
          SELECT 'm', "accountId", "chatId", "id", "timestampWa", 0, left("body", 4000)
          FROM scanned WHERE "body" ILIKE ${like} AND "revokedAt" IS NULL`;

        // Everything at or after `covered` was read for EVERY account; older matches from deeper accounts wait for phase 2.
        const full = recent.filter((r) => r.kind === "s" && r.n >= budget).map((r) => r.timestampWa.getTime());
        const covered = full.length ? Math.max(...full) : null;
        const chats = new Map<string, Row>();
        for (const r of recent.filter((x) => x.kind === "m" && (covered === null || x.timestampWa.getTime() >= covered)).sort(newestFirst)) {
          const k = matchKey(r.accountId, r.chatId);
          if (!seen.has(k) && !chats.has(k)) chats.set(k, r);
        }
        if (chats.size > MESSAGE_SEARCH_PAGE || covered === null) return [...chats.values()];

        // Phase 2 — the older history, through the trigram index, without what is already listed.
        const skip = [...seen, ...chats.keys()];
        const older = await tx.$queryRaw<Row[]>`
          WITH hits AS MATERIALIZED (
            SELECT DISTINCT ON (m."accountId", m."chatId") m."accountId", m."chatId", m."id", m."timestampWa"
            FROM "Message" m
            WHERE m."projectId" = ${projectId}
              AND m."body" ILIKE ${like}
              AND m."accountId" IN (${Prisma.join(accountIds)})
              AND m."revokedAt" IS NULL
              AND m."timestampWa" < ${new Date(covered)} ${notAfter}
              ${skip.length ? Prisma.sql`AND (m."accountId" || '|' || m."chatId") <> ALL(ARRAY[${Prisma.join(skip)}]::text[])` : Prisma.empty}
            ORDER BY m."accountId", m."chatId", m."timestampWa" DESC, m."id" DESC
          ), paged AS (
            SELECT h.* FROM hits h
            ORDER BY h."timestampWa" DESC, h."accountId" DESC, h."chatId" DESC
            LIMIT ${MESSAGE_SEARCH_PAGE + 1 - chats.size}
          )
          SELECT p."accountId", p."chatId", p."id", p."timestampWa", left(m."body", 4000) AS "body"
          FROM paged p
          JOIN "Message" m ON m."id" = p."id" AND m."projectId" = ${projectId}`;
        return [...chats.values(), ...older.sort(newestFirst)];
      },
      { maxWait: 5_000, timeout: 3 * STATEMENT_TIMEOUT_MS },
    );

    const pageRows = found.slice(0, MESSAGE_SEARCH_PAGE);
    const matches = new Map<string, MessageMatch>();
    for (const r of pageRows) matches.set(matchKey(r.accountId, r.chatId), { accountId: r.accountId, chatId: r.chatId, messageId: r.id, at: r.timestampWa, snippet: snippetAround(r.body, text) });
    const more = found.length > MESSAGE_SEARCH_PAGE;
    const limitReached = more && seen.size + pageRows.length >= MESSAGE_SEARCH_MAX_SEEN;
    return { matches, nextCursor: more && !limitReached ? encodeSearchCursor(pageRows[pageRows.length - 1]!.timestampWa) : null, timedOut: false, tooShort: false, limitReached };
  } catch (err) {
    // 57014 = query_canceled (the statement timeout); P2028 = the transaction's own time limit. Anything else is a real error.
    const code = (err as { code?: string; meta?: { code?: string } }).meta?.code ?? (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "57014" || code === "P2028" || /statement timeout|canceling statement/i.test(message)) return empty({ timedOut: true });
    throw err;
  }
}
