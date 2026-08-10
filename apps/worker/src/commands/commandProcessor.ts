import { prisma } from "@support-automation/db";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";

/** Discovers/updates the account's monitored groups from the live provider. */
export async function syncGroups(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const groups = await provider.getGroups();
  for (const group of groups) {
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
  }
  return groups.length;
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
        const count = await syncGroups(accountId, provider);
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
