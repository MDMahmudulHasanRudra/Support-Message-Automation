import { prisma } from "@support-automation/db";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

const GROUP_SYNC_PROGRESS_INTERVAL = 250;

/**
 * PHASE 5.2: discovers/updates the account's monitored groups from the live
 * provider. Upsert-based on purpose — safe to call repeatedly (retries,
 * manual RESYNC_GROUPS, a future scheduled resync) without ever duplicating
 * a row or losing groups synced by an earlier, since-failed attempt.
 */
export async function syncGroups(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const groups = await provider.getGroups();
  for (const [i, group] of groups.entries()) {
    await prisma.whatsAppGroup.upsert({
      where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: group.whatsappGroupId } },
      update: { name: group.name, lastSyncedAt: new Date() },
      create: {
        accountId,
        whatsappGroupId: group.whatsappGroupId,
        name: group.name,
        lastSyncedAt: new Date(),
      },
    });
    if ((i + 1) % GROUP_SYNC_PROGRESS_INTERVAL === 0) {
      console.log(`[groupsync] GROUP_SYNC_PROGRESS ${i + 1}/${groups.length}`);
    }
  }
  return groups.length;
}

const GROUP_SYNC_TIMEOUT_MS = Number(process.env.WHATSAPP_GROUP_SYNC_TIMEOUT_MS) || 150_000;
// Bounded, same spirit as index.ts's CONNECT_RETRY_DELAYS_MS — not unlimited.
const GROUP_SYNC_RETRY_DELAYS_MS = [10_000, 30_000];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`group sync timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * PHASE 5.2 — root cause of the original crash: `getAllGroups()` on a large
 * account (~1,880 chats) hit Puppeteer's own 180s `protocolTimeout` default
 * (not something OpenWA's config exposes a way to change — confirmed by
 * reading its ConfigObject typings), and that rejection propagated all the
 * way up through index.ts's unguarded `await syncGroups(...)`, killing the
 * whole worker process — including the otherwise-healthy WhatsApp session.
 *
 * This wraps `syncGroups` with our OWN bounded timeout (fires before
 * Puppeteer's, with a clear message) plus bounded retries, and — critically —
 * never throws past its caller's control: callers decide whether a final
 * failure should surface (RESYNC_GROUPS command → FAILED, still isolated by
 * commandProcessor's own try/catch) or just be logged (initial post-connect
 * sync in index.ts, called without awaiting so it can never block message
 * processing or take the connection down with it).
 */
export async function syncGroupsWithTimeoutAndRetry(
  accountId: string,
  provider: WhatsAppProvider,
): Promise<number> {
  const attempts = GROUP_SYNC_RETRY_DELAYS_MS.length + 1;
  await logSystemEvent("INFO", "provider", "GROUP_SYNC_STARTED", { accountId });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const count = await withTimeout(syncGroups(accountId, provider), GROUP_SYNC_TIMEOUT_MS);
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_COMPLETED", { groupCount: count, attempt });
      return count;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const isTimeout = message.includes("timed out");
      const isLastAttempt = attempt === attempts;
      await logSystemEvent(
        isLastAttempt ? "ERROR" : "WARN",
        "provider",
        isTimeout ? "GROUP_SYNC_TIMEOUT" : "GROUP_SYNC_FAILED",
        { attempt, attempts, error: message },
      );
      if (isLastAttempt) throw err;
      const delayMs = GROUP_SYNC_RETRY_DELAYS_MS[attempt - 1];
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_RETRY", { nextAttempt: attempt + 1, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable: the loop above always either returns or throws on the last attempt.
  throw new Error("syncGroupsWithTimeoutAndRetry: exhausted attempts without resolving");
}

async function claimNextCommand() {
  const candidate = await prisma.workerCommand.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.workerCommand.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claim.count === 0) return null;

  return prisma.workerCommand.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Dashboard → worker actions that need the live browser session (QR fetch,
 * reconnect, group resync, an explicit live test send) travel through this
 * DB-mediated channel — never a direct HTTP call (see ARCHITECTURE.md).
 */
async function processOneCommand(accountId: string, provider: WhatsAppProvider): Promise<boolean> {
  const command = await claimNextCommand();
  if (!command) return false;

  try {
    switch (command.type) {
      case "GET_QR": {
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId },
          select: { qrCode: true, qrUpdatedAt: true },
        });
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { qrCode: account?.qrCode ?? null } },
        });
        break;
      }

      case "RECONNECT": {
        await provider.disconnect();
        await provider.connect();
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { reconnected: true } },
        });
        break;
      }

      case "RESYNC_GROUPS": {
        const count = await syncGroupsWithTimeoutAndRetry(accountId, provider);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { groupsSynced: count } },
        });
        break;
      }

      case "SEND_LIVE_TEST": {
        const payload = command.payload as { chatId?: string; body?: string } | null;
        if (!payload?.chatId || !payload?.body) {
          throw new Error("SEND_LIVE_TEST requires { chatId, body } in the command payload.");
        }
        const result = await provider.sendMessage(payload.chatId, payload.body);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: { success: result.success, error: result.error ?? null },
          },
        });
        break;
      }

      default:
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "FAILED", processedAt: new Date(), result: { error: "Unknown command type." } },
        });
    }
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: {
        status: "FAILED",
        processedAt: new Date(),
        result: { error: (err as Error).message },
      },
    });
  }

  return true;
}

export function startCommandProcessor(
  accountId: string,
  provider: WhatsAppProvider,
  intervalMs = 1500,
): NodeJS.Timeout {
  return setInterval(() => {
    processOneCommand(accountId, provider).catch((err) => {
      console.error("[commands] unexpected error processing worker command", err);
    });
  }, intervalMs);
}
