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

export interface GroupSetupCandidate {
  accountId: string;
  label: string;
  phoneNumber: string | null;
  /** Groups on this account that carry setup worth moving. */
  configuredGroups: number;
  /** How many of those the target account is also in — the number that would actually carry. */
  wouldCarry: number;
}

/**
 * Which other accounts have group setup that could be adopted, and how much of it would land.
 *
 * `wouldCarry` is the honest number and the reason this is a preview rather than a one-click
 * action: a WhatsApp group is per-account (`@@unique([accountId, whatsappGroupId])`), so setup can
 * only carry to a group the target account is ALSO in. A new number is in nothing until somebody
 * adds it, and "0 of 1,848 would carry" is the answer that actually explains what to do next.
 */
export async function getGroupSetupCandidates(targetAccountId: string): Promise<GroupSetupCandidate[]> {
  await requireSession();

  const targetGroupIds = new Set(
    (
      await prisma.whatsAppGroup.findMany({
        where: { accountId: targetAccountId },
        select: { whatsappGroupId: true },
      })
    ).map((g) => g.whatsappGroupId),
  );

  const others = await prisma.whatsAppAccount.findMany({
    where: { id: { not: targetAccountId } },
    select: { id: true, label: true, phoneNumber: true },
  });

  const candidates: GroupSetupCandidate[] = [];
  for (const account of others) {
    // "Configured" means somebody made a decision about this group. A row left entirely at its
    // defaults carries nothing, and counting it would promise work that does not exist.
    const configured = await prisma.whatsAppGroup.findMany({
      where: {
        accountId: account.id,
        OR: [
          { isMonitored: true },
          { aiAutomationEnabled: true },
          { aiAutomationExcluded: true },
          { testModeEnabled: true },
          { priority: { not: null } },
          { assignedTeamMemberId: { not: null } },
        ],
      },
      select: { whatsappGroupId: true },
    });
    if (configured.length === 0) continue;

    candidates.push({
      accountId: account.id,
      label: account.label,
      phoneNumber: account.phoneNumber,
      configuredGroups: configured.length,
      wouldCarry: configured.filter((g) => targetGroupIds.has(g.whatsappGroupId)).length,
    });
  }

  return candidates.sort((a, b) => b.wouldCarry - a.wouldCarry);
}

export interface AdoptGroupSetupResult {
  error?: string;
  updated?: number;
  /** Configured groups the target account is not in — it cannot be given setup for those. */
  notShared?: number;
}

/**
 * Copies the operational setup of every shared group from one account onto another.
 *
 * The case this exists for: replacing the number that serves your customers. The groups resync
 * under the new account as fresh rows with every flag at its default, so without this an operator
 * re-picks monitoring, AI, priority tier and assigned member on every group by hand — which for a
 * roster in the hundreds is not a real option, and half-finished is worse than not started.
 *
 * Deliberately an explicit action rather than something that fires on connect. Two accounts
 * running side by side is a supported arrangement, so "a new account appeared" cannot be read as
 * "it is replacing that one" — and guessing wrong turns monitoring on for hundreds of groups under
 * a second number, which means every customer gets answered twice.
 *
 * Copies decisions only. Not copied, on purpose: the knowledge-build watermarks (they mark a
 * position in THIS account's own stored messages), `aiSuppressedUntil` (a live human-takeover
 * timer, not a setting), and sync bookkeeping.
 */
export async function adoptGroupSetupFromAccount(
  targetAccountId: string,
  sourceAccountId: string,
): Promise<AdoptGroupSetupResult> {
  const session = await requireSession();
  if (targetAccountId === sourceAccountId) return { error: "Pick a different account to copy from." };

  const [target, source] = await Promise.all([
    prisma.whatsAppAccount.findUnique({ where: { id: targetAccountId }, select: { id: true, label: true } }),
    prisma.whatsAppAccount.findUnique({ where: { id: sourceAccountId }, select: { id: true, label: true } }),
  ]);
  if (!target || !source) return { error: "That account no longer exists." };

  const configured = await prisma.whatsAppGroup.findMany({
    where: {
      accountId: sourceAccountId,
      OR: [
        { isMonitored: true },
        { aiAutomationEnabled: true },
        { aiAutomationExcluded: true },
        { testModeEnabled: true },
        { priority: { not: null } },
        { assignedTeamMemberId: { not: null } },
      ],
    },
    select: {
      whatsappGroupId: true,
      isMonitored: true,
      aiAutomationEnabled: true,
      aiAutomationExcluded: true,
      testModeEnabled: true,
      escalationMonitoringEnabled: true,
      priority: true,
      assignedTeamMemberId: true,
    },
  });

  let updated = 0;
  let notShared = 0;

  for (const group of configured) {
    // updateMany rather than update: it matches nothing and moves on when the target account is
    // not in this group, which is the ordinary case rather than an error.
    const { count } = await prisma.whatsAppGroup.updateMany({
      where: { accountId: targetAccountId, whatsappGroupId: group.whatsappGroupId },
      data: {
        isMonitored: group.isMonitored,
        aiAutomationEnabled: group.aiAutomationEnabled,
        aiAutomationExcluded: group.aiAutomationExcluded,
        testModeEnabled: group.testModeEnabled,
        escalationMonitoringEnabled: group.escalationMonitoringEnabled,
        priority: group.priority,
        assignedTeamMemberId: group.assignedTeamMemberId,
      },
    });
    if (count > 0) updated += count;
    else notShared += 1;
  }

  await logSystemEvent("WARN", "accounts", `Group setup copied from "${source.label}" to "${target.label}"`, {
    targetAccountId,
    sourceAccountId,
    updated,
    notShared,
    copiedBy: session.username,
  });

  revalidatePath("/accounts");
  revalidatePath("/groups");
  revalidatePath("/chat");
  return { updated, notShared };
}

export interface PairingMethodResult {
  error?: string;
}

/**
 * Choose how this account links to WhatsApp, then start the attempt.
 *
 * Both methods are official WhatsApp Web flows and the worker's library supports both; this only
 * records which one the operator wants and kicks off a connection so the code — QR image or
 * nine-character link code — is produced under it.
 *
 * Writing the preference and queuing the RECONNECT together is deliberate. They are one intention
 * ("link this account by phone number"), and a saved preference that needed a second, separate
 * button press to take effect is the shape that leaves somebody staring at a QR code wondering why
 * their choice did nothing.
 *
 * The number is stored DIGITS ONLY, into `pairingPhoneNumber` and never into `phoneNumber`. The
 * latter is what WhatsApp reports once a session is live, and overwriting it here would put an
 * unverified, typed-in value where every other screen reads a confirmed one.
 */
export async function setPairingMethod(
  accountId: string,
  method: "QR_CODE" | "PHONE_CODE",
  phoneNumber?: string,
): Promise<PairingMethodResult> {
  await requireSession();

  let pairingPhoneNumber: string | null = null;
  if (method === "PHONE_CODE") {
    const digits = (phoneNumber ?? "").replace(/\D/g, "");
    // Checked here rather than only in the worker so the operator finds out now, on the form they
    // are looking at, instead of by watching a connection attempt quietly fall back to a QR.
    if (digits.length < 8) {
      return { error: "Enter the full number including its country code, digits only." };
    }
    if (digits.length > 15) {
      // E.164's ceiling. Longer than this is a paste of something that is not a phone number.
      return { error: "That is longer than any phone number — check for extra digits." };
    }
    pairingPhoneNumber = digits;
  }

  const account = await prisma.whatsAppAccount.update({
    where: { id: accountId },
    data: {
      pairingMethod: method,
      pairingPhoneNumber,
      // The previous attempt's code belongs to the previous method and cannot be used to link
      // under this one. Clearing it stops the dialog rendering a stale QR for a moment while the
      // worker starts a link-code attempt, which reads as the choice having been ignored.
      qrCode: null,
      qrUpdatedAt: null,
    },
    select: { label: true },
  });

  await logSystemEvent("INFO", "accounts", "Pairing method changed", {
    accountId,
    label: account.label,
    method,
    // The number itself is not logged. It identifies a person, the log is readable by anyone with
    // dashboard access, and knowing WHICH method was chosen is the whole diagnostic value here.
    hasNumber: pairingPhoneNumber !== null,
  });

  await enqueueCommand("RECONNECT", accountId);
  revalidatePath("/accounts");
  return {};
}
