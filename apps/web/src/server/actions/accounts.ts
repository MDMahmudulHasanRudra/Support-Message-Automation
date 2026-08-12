"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Every action here just inserts a WorkerCommand row — the dashboard never calls the worker
 * directly. ENGINEERING_STANDARDS.md §9: a command of the same type FOR THE SAME ACCOUNT that's
 * still PENDING/PROCESSING must not get a duplicate queued behind it (this is exactly how the
 * real incident happened — two stale RECONNECT commands queued back-to-back). Skips silently
 * rather than erroring: the existing command will still run, so there's nothing for the admin to
 * fix. Scoped by accountId now that a worker can own several accounts — a RECONNECT for account A
 * must never be skipped just because account B also has one in flight.
 */
async function enqueueCommand(
  type: "RECONNECT" | "RESYNC_GROUPS" | "LOGOUT",
  accountId: string,
  payload?: Record<string, unknown>,
) {
  const existing = await prisma.workerCommand.findFirst({
    where: { type, accountId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (existing) return;

  await prisma.workerCommand.create({
    data: { type, accountId, payload: payload as Prisma.InputJsonValue | undefined },
  });
}

export async function requestReconnect(accountId: string): Promise<void> {
  await requireSession();
  await enqueueCommand("RECONNECT", accountId);
  revalidatePath("/accounts");
}

export async function requestGroupResync(accountId: string): Promise<void> {
  await requireSession();
  await enqueueCommand("RESYNC_GROUPS", accountId);
  revalidatePath("/accounts");
  revalidatePath("/groups");
}

export interface SyncAllGroupsResult {
  accountsQueued: number;
}

/**
 * The Groups page shows groups across every account at once, so "sync" there means "resync every
 * account," not just one — unlike requestGroupResync, which the Accounts page calls per-card.
 * Reuses the same per-account dedup as everything else here: an account whose RESYNC_GROUPS is
 * already PENDING/PROCESSING is simply skipped, not queued twice.
 */
export async function requestSyncAllGroups(): Promise<SyncAllGroupsResult> {
  await requireSession();
  const accounts = await prisma.whatsAppAccount.findMany({ select: { id: true } });
  for (const account of accounts) {
    await enqueueCommand("RESYNC_GROUPS", account.id);
  }
  revalidatePath("/accounts");
  revalidatePath("/groups");
  return { accountsQueued: accounts.length };
}

/** Ends the current session so a different WhatsApp account can scan a fresh QR. See ENGINEERING_STANDARDS.md §8. */
export async function requestLogout(accountId: string): Promise<void> {
  await requireSession();
  await enqueueCommand("LOGOUT", accountId);
  revalidatePath("/accounts");
}

export interface AddAccountFormState {
  error?: string;
}

/**
 * Just creates the DB row with a label — the worker owns everything filesystem-related
 * (sessionDataPath/sessionId assignment, actually connecting) via its own account-registry sync
 * poller, since only the worker's environment knows WHATSAPP_SESSION_DIR. Never Primary by
 * default: the very first account on a fresh install is auto-promoted by the worker at startup
 * (ensurePrimaryAccountExists), so by the time an admin can click "Add Account" a Primary already
 * exists.
 */
export async function addWhatsAppAccount(formData: FormData): Promise<AddAccountFormState> {
  await requireSession();
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { error: "Label is required." };

  const account = await prisma.whatsAppAccount.create({ data: { label, status: "DISCONNECTED" } });
  await logSystemEvent("INFO", "accounts", `WhatsApp account "${label}" added`, { accountId: account.id });
  revalidatePath("/accounts");
  return {};
}

/**
 * Transactional unset-old/set-new, per the spec's explicit requirement (§1/§13) that this must
 * not rely on frontend validation alone — the database's own partial unique index on isPrimary
 * (see schema.prisma) is the real backstop; this transaction is defense-in-depth so a
 * half-applied change can never leave two Primaries even momentarily within the app's own logic.
 */
export async function setPrimaryAccount(accountId: string): Promise<void> {
  const session = await requireSession();
  const target = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  if (!target || target.isPrimary) return;

  const previousPrimary = await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } });

  await prisma.$transaction([
    prisma.whatsAppAccount.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } }),
    prisma.whatsAppAccount.update({ where: { id: accountId }, data: { isPrimary: true } }),
  ]);

  await logSystemEvent("INFO", "accounts", `Primary WhatsApp account changed to "${target.label}"`, {
    accountId,
    previousPrimaryAccountId: previousPrimary?.id ?? null,
    previousPrimaryLabel: previousPrimary?.label ?? null,
    changedBy: session.username,
  });
  revalidatePath("/accounts");
}

/**
 * Leaves the account table with zero Primary accounts, on purpose — the spec calls this out as
 * its own distinct action from setPrimaryAccount, not "set some other account Primary instead."
 * Every WhatsApp-dependent service falling back to Primary will clearly error ("No Primary
 * account configured") until an admin sets one — never silently picks a replacement.
 */
export async function removePrimaryAccount(accountId: string): Promise<void> {
  const session = await requireSession();
  const target = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  if (!target || !target.isPrimary) return;

  await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { isPrimary: false } });
  await logSystemEvent("WARN", "accounts", `Primary status removed from "${target.label}" — no account is Primary now`, {
    accountId,
    changedBy: session.username,
  });
  revalidatePath("/accounts");
}

export interface DeleteAccountResult {
  error?: string;
}

/**
 * Permanently removes the account and (via cascade) every group/message/job history tied to it —
 * genuinely destructive, so this refuses two specific unsafe states rather than trusting the
 * frontend confirmation alone: the last remaining account (would break every service with no
 * fallback left), and the current Primary (must be reassigned first, never silently promotes a
 * replacement here).
 */
export async function deleteWhatsAppAccount(accountId: string): Promise<DeleteAccountResult> {
  const session = await requireSession();
  const target = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  if (!target) return {};

  const totalAccounts = await prisma.whatsAppAccount.count();
  if (totalAccounts <= 1) {
    return { error: "Cannot delete the only WhatsApp account." };
  }
  if (target.isPrimary) {
    return { error: "This account is Primary. Set a different account as Primary first." };
  }

  await prisma.whatsAppAccount.delete({ where: { id: accountId } });
  await logSystemEvent("WARN", "accounts", `WhatsApp account "${target.label}" deleted`, {
    accountId,
    deletedBy: session.username,
  });
  revalidatePath("/accounts");
  return {};
}
