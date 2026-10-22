import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPersonalChatId } from "@support-automation/shared";
import { prisma } from "../db.js";
import { withAccountProject } from "../project/context.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { storeHistoryMessages } from "./messageUpdates.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import type { RawIncomingMessage } from "./types.js";

/**
 * One-time recovery of PERSONAL (1:1) messages that never reached the database (18 Oct 2026
 * incident). PERSONAL_MESSAGES_RUNBOOK.md is the operator's guide.
 *
 * Safe by construction:
 * - **Dry run is the default.** A write needs `mode=write` AND `confirm=WRITE`.
 * - **Store-only.** A recovered message goes through `storeHistoryMessages` — the same writer as
 *   WhatsApp Chat's "Load earlier": IGNORED, never automated, no rules, no AI, no notification, no
 *   wait or case opened. Nothing is sent.
 * - **Additive only.** Messages already stored are skipped (the `Message` unique key decides);
 *   nothing stored is rewritten or deleted — a message deleted for everyone is counted, not applied.
 * - **Bounded.** One account, a date range of at most 14 days, a cap on chats, at most a few
 *   earlier-history pages per chat, one chat at a time with a pause between them, one run per worker.
 * - **Honest.** WhatsApp Web only has what it holds or can still fetch from the phone; a chat whose
 *   read did not reach the start of the range is PARTIAL, and a message still encrypted is counted
 *   as unreadable. Nothing is invented.
 * - **Resumable.** In a write run each finished chat is checkpointed in a file beside the account's
 *   session, so a cancelled or interrupted run picks up where it stopped; a failed chat is retried on
 *   the next run. A dry run writes nothing at all — not even that file.
 *
 * Runs inside the worker (only it holds the browser), started over the worker's loopback-only
 * health port, so only somebody with `docker compose exec` on the server can start it.
 */

export const BACKFILL_LIMITS = {
  maxRangeDays: 14,
  maxChats: 2_000,
  defaultMaxChats: 500,
  maxEarlierPages: 10,
  defaultEarlierPages: 2,
  /** Between chats, so the live listener and the outbound queue keep the browser. */
  pauseMs: Number(process.env.PERSONAL_BACKFILL_PAUSE_MS ?? 500),
};

export type BackfillMode = "DRY_RUN" | "WRITE";

export interface PersonalBackfillRequest {
  accountId: string;
  from: Date;
  to: Date;
  mode: BackfillMode;
  maxChats: number;
  earlierPages: number;
}

/** One chat's outcome. Counts only. */
export interface ChatBackfillResult {
  status: "DONE" | "FAILED";
  /** Messages WhatsApp still holds for this chat inside the range (readable or not). */
  available: number;
  alreadyStored: number;
  /** Readable, in range, not stored: what a write run adds. */
  recoverable: number;
  /** Still encrypted, unreadable, or empty — WhatsApp holds them but there is nothing to store. */
  unreadable: number;
  /** Deleted for everyone: nothing left to recover. */
  deleted: number;
  /** Written by this run (always 0 in a dry run). */
  stored: number;
  /** COMPLETE when the read reached the start of the range; PARTIAL when older history was not available. */
  coverage: "COMPLETE" | "PARTIAL" | null;
  reason?: string;
}

export interface BackfillTotals {
  chatsFound: number;
  chatsInRun: number;
  chatsDone: number;
  chatsFailed: number;
  chatsPartial: number;
  chatsResumed: number;
  available: number;
  alreadyStored: number;
  recoverable: number;
  unreadable: number;
  deleted: number;
  stored: number;
}

export interface BackfillState {
  runId: string;
  accountId: string;
  from: string;
  to: string;
  mode: BackfillMode;
  status: "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  /** Chats beyond `maxChats` that this run did not look at. */
  chatsSkippedByCap: number;
  totals: BackfillTotals;
  error: string | null;
}

/** Validates the query string of a start request. Pure. */
export function parseBackfillRequest(
  params: URLSearchParams,
  now: Date,
): { ok: true; request: PersonalBackfillRequest } | { ok: false; error: string } {
  const accountId = params.get("account")?.trim();
  if (!accountId) return { ok: false, error: "account is required (the WhatsAppAccount id)." };
  const from = new Date(params.get("from") ?? "");
  const to = params.get("to") ? new Date(params.get("to")!) : now;
  if (Number.isNaN(from.getTime())) return { ok: false, error: "from is required, as an ISO date or time." };
  if (Number.isNaN(to.getTime())) return { ok: false, error: "to must be an ISO date or time." };
  if (from >= to) return { ok: false, error: "from must be before to." };
  if (to.getTime() > now.getTime() + 60_000) return { ok: false, error: "to cannot be in the future." };
  if (to.getTime() - from.getTime() > BACKFILL_LIMITS.maxRangeDays * 86_400_000) {
    return { ok: false, error: `The range is limited to ${BACKFILL_LIMITS.maxRangeDays} days.` };
  }
  const modeParam = (params.get("mode") ?? "dry-run").toLowerCase();
  if (modeParam !== "dry-run" && modeParam !== "write") return { ok: false, error: "mode is dry-run (default) or write." };
  if (modeParam === "write" && params.get("confirm") !== "WRITE") {
    return { ok: false, error: "A write run also needs confirm=WRITE." };
  }
  const bounded = (name: string, fallback: number, max: number) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : NaN;
  };
  const maxChats = bounded("maxChats", BACKFILL_LIMITS.defaultMaxChats, BACKFILL_LIMITS.maxChats);
  const earlierPages = bounded("earlierPages", BACKFILL_LIMITS.defaultEarlierPages, BACKFILL_LIMITS.maxEarlierPages);
  if (!Number.isFinite(maxChats) || maxChats < 1) return { ok: false, error: "maxChats must be a whole number from 1." };
  if (!Number.isFinite(earlierPages)) return { ok: false, error: "earlierPages must be a whole number." };
  return { ok: true, request: { accountId, from, to, mode: modeParam === "write" ? "WRITE" : "DRY_RUN", maxChats, earlierPages } };
}

const emptyTotals = (): BackfillTotals => ({
  chatsFound: 0,
  chatsInRun: 0,
  chatsDone: 0,
  chatsFailed: 0,
  chatsPartial: 0,
  chatsResumed: 0,
  available: 0,
  alreadyStored: 0,
  recoverable: 0,
  unreadable: 0,
  deleted: 0,
  stored: 0,
});

interface RunHandle {
  state: BackfillState;
  cancelRequested: boolean;
  done: Promise<void>;
}

let current: RunHandle | null = null;

/** The current or last run, counts only. */
export function readPersonalBackfill(): BackfillState | null {
  if (!current) return null;
  const elapsedMs = (current.state.finishedAt ? Date.parse(current.state.finishedAt) : Date.now()) - Date.parse(current.state.startedAt);
  return { ...current.state, elapsedMs, totals: { ...current.state.totals } };
}

/** Asks a running backfill to stop after the chat it is on. */
export function cancelPersonalBackfill(): boolean {
  if (!current || current.state.status !== "RUNNING") return false;
  current.cancelRequested = true;
  return true;
}

/** Test seam: wait for the run to finish. */
export async function waitForPersonalBackfill(): Promise<void> {
  await current?.done;
}

/** Test seam. */
export function resetPersonalBackfillForTests(): void {
  current = null;
}

export function startPersonalBackfill(
  registry: ProviderRegistry,
  request: PersonalBackfillRequest,
): { ok: true; state: BackfillState } | { ok: false; error: string } {
  if (current?.state.status === "RUNNING") return { ok: false, error: "A personal backfill is already running. Check its status, or cancel it first." };
  const state: BackfillState = {
    runId: `pbf-${Date.now().toString(36)}`,
    accountId: request.accountId,
    from: request.from.toISOString(),
    to: request.to.toISOString(),
    mode: request.mode,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    chatsSkippedByCap: 0,
    totals: emptyTotals(),
    error: null,
  };
  const handle: RunHandle = { state, cancelRequested: false, done: Promise.resolve() };
  current = handle;
  handle.done = run(registry, request, handle).catch((err) => {
    handle.state.status = "FAILED";
    handle.state.error = (err as Error).message;
  }).finally(() => {
    handle.state.finishedAt = new Date().toISOString();
  });
  return { ok: true, state };
}

async function run(registry: ProviderRegistry, request: PersonalBackfillRequest, handle: RunHandle): Promise<void> {
  const { state } = handle;
  const provider = registry.get(request.accountId);
  if (!provider || provider.getConnectionStatus() !== "CONNECTED") {
    throw new Error("This account is not connected in this worker, so WhatsApp cannot be asked.");
  }
  if (!provider.listPersonalChatsSince || !provider.readChatHistory) {
    throw new Error("This WhatsApp connection cannot read chat history.");
  }
  // The account row is the authority for the project; an unknown account throws here.
  const account = await withAccountProject(request.accountId, () =>
    prisma.whatsAppAccount.findUnique({ where: { id: request.accountId }, select: { sessionDataPath: true } }),
  );
  if (!account) throw new Error("No such WhatsApp account.");

  // Checkpoints are kept for a WRITE run only: a dry run writes nothing anywhere, not even a file.
  const progressPath =
    request.mode === "WRITE" && account.sessionDataPath
      ? join(account.sessionDataPath, "personal-backfill", `write-${request.from.getTime()}-${request.to.getTime()}.json`)
      : null;
  const progress = progressPath ? await readProgress(progressPath) : {};

  const chats = (await provider.listPersonalChatsSince(request.from))
    .filter((chat) => isPersonalChatId(chat.id) && typeof chat.t === "number" && chat.t * 1000 >= request.from.getTime())
    .sort((a, b) => (b.t ?? 0) - (a.t ?? 0) || (a.id < b.id ? -1 : 1));
  state.totals.chatsFound = chats.length;
  const inRun = chats.slice(0, request.maxChats);
  state.totals.chatsInRun = inRun.length;
  state.chatsSkippedByCap = chats.length - inRun.length;

  for (const chat of inRun) {
    if (handle.cancelRequested) {
      state.status = "CANCELLED";
      break;
    }
    const previous = progress[chat.id];
    let result: ChatBackfillResult;
    if (previous?.status === "DONE") {
      result = previous;
      state.totals.chatsResumed += 1;
    } else {
      result = await backfillChatWithRetry(provider, request, chat.id);
      progress[chat.id] = result;
      if (progressPath) await writeProgress(progressPath, progress);
      if (BACKFILL_LIMITS.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, BACKFILL_LIMITS.pauseMs));
    }
    addToTotals(state.totals, result);
  }
  if (state.status === "RUNNING") state.status = "COMPLETED";

  await withAccountProject(request.accountId, () =>
    logSystemEvent("INFO", "pipeline", `Personal message backfill ${state.mode === "WRITE" ? "write" : "dry run"} ${state.status.toLowerCase()}`, {
      accountId: request.accountId,
      runId: state.runId,
      from: state.from,
      to: state.to,
      chatsSkippedByCap: state.chatsSkippedByCap,
      ...state.totals,
    }),
  ).catch(() => undefined);
}

function addToTotals(totals: BackfillTotals, result: ChatBackfillResult): void {
  if (result.status === "FAILED") {
    totals.chatsFailed += 1;
    return;
  }
  totals.chatsDone += 1;
  if (result.coverage === "PARTIAL") totals.chatsPartial += 1;
  totals.available += result.available;
  totals.alreadyStored += result.alreadyStored;
  totals.recoverable += result.recoverable;
  totals.unreadable += result.unreadable;
  totals.deleted += result.deleted;
  totals.stored += result.stored;
}

async function backfillChatWithRetry(provider: WhatsAppProvider, request: PersonalBackfillRequest, chatId: string): Promise<ChatBackfillResult> {
  const first = await backfillChat(provider, request, chatId).catch((err): ChatBackfillResult => failed((err as Error).message));
  if (first.status === "DONE") return first;
  return backfillChat(provider, request, chatId).catch((err): ChatBackfillResult => failed((err as Error).message));
}

const failed = (reason: string): ChatBackfillResult => ({
  status: "FAILED",
  available: 0,
  alreadyStored: 0,
  recoverable: 0,
  unreadable: 0,
  deleted: 0,
  stored: 0,
  coverage: null,
  reason,
});

/** One chat: what WhatsApp holds in the range, what is stored, and (in a write run) store the rest. */
export async function backfillChat(provider: WhatsAppProvider, request: PersonalBackfillRequest, chatId: string): Promise<ChatBackfillResult> {
  const read = await provider.readChatHistory!(chatId, request.from, { earlierPages: request.earlierPages });
  if (!read.ok) return failed(read.reason);

  const inRange = (m: RawIncomingMessage) =>
    m.chatId === chatId && m.accountId === request.accountId && m.timestampWa >= request.from && m.timestampWa <= request.to;
  const held = read.messages.filter(inRange);
  const deleted = held.filter((m) => m.revoked).length;
  const readable = held.filter((m) => !m.revoked && m.body.trim().length > 0);
  const empty = held.length - deleted - readable.length;

  const storedIds = new Set(
    readable.length === 0
      ? []
      : (
          await withAccountProject(request.accountId, () =>
            prisma.message.findMany({
              where: { accountId: request.accountId, whatsappMessageId: { in: readable.map((m) => m.whatsappMessageId) } },
              select: { whatsappMessageId: true },
            }),
          )
        ).map((row) => row.whatsappMessageId),
  );
  const missing = readable.filter((m) => !storedIds.has(m.whatsappMessageId));

  let stored = 0;
  if (request.mode === "WRITE" && missing.length > 0) {
    // Store-only (no rules, AI, waits, cases or notifications); revoked messages were left out above,
    // so nothing already stored is touched.
    stored = (await storeHistoryMessages(request.accountId, chatId, missing)).stored;
  }

  return {
    status: "DONE",
    available: held.length + read.undecrypted,
    alreadyStored: storedIds.size,
    recoverable: missing.length,
    unreadable: read.undecrypted + empty,
    deleted,
    stored,
    coverage: read.reachedSince ? "COMPLETE" : "PARTIAL",
  };
}

type Progress = Record<string, ChatBackfillResult>;

async function readProgress(path: string): Promise<Progress> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Progress) : {};
  } catch {
    return {};
  }
}

/** Written to a temporary file and renamed, so an interrupted write never leaves half a checkpoint. */
async function writeProgress(path: string, progress: Progress): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(progress), "utf8");
    await rename(tmp, path);
  } catch (err) {
    // A checkpoint that cannot be written costs only a resume, never the run.
    console.warn("[backfill] could not write the progress file", err);
  }
}
