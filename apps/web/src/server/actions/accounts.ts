"use server";

import { revalidatePath } from "next/cache";
import {
  prisma,
  encryptSecret,
  countAccountHistory,
  reconcileAttendanceAfterAccountRemoval,
} from "@support-automation/db";
import type { AccountHistoryImpact } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { normalizePhoneNumber } from "@support-automation/shared";
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

  // Drop the stored code first. A reconnect tears the session down and builds a new one, so
  // whatever is on screen belongs to the attempt being replaced and cannot be scanned any more —
  // leaving it there is how "Request a new code" looked like it had done nothing while the worker
  // was in fact restarting Chromium. `setPairingMethod` has always cleared it for the same reason.
  // Harmless on a connected account, where it is already null.
  await prisma.whatsAppAccount.updateMany({
    where: { id: accountId },
    data: { qrCode: null, qrUpdatedAt: null },
  });

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

/** Everything the linking dialog needs to narrate an attempt, and nothing else. */
export interface LinkState {
  status: string;
  connectionStage: string | null;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  pairingMethod: "QR_CODE" | "PHONE_CODE";
  pairingPhoneNumber: string | null;
  /** Only known once a session is live — what the dialog confirms back on success. */
  phoneNumber: string | null;
  /**
   * When the worker last checked in, for anything on this account.
   *
   * Carried because a stage is only as current as the process that wrote it. With the worker down
   * the poll keeps answering, keeps answering the same thing, and the dialog would go on saying
   * "waiting for WhatsApp to hand over a code" indefinitely about a process that stopped — the
   * exact failure the Accounts page has an alert for, hidden behind the modal sitting on top of it.
   */
  lastHeartbeatAt: string | null;
}

/**
 * One account's linking state, for the dialog's own poll.
 *
 * The page already refreshes itself while something is in flight, but a whole-page refresh is the
 * wrong instrument for this particular moment: it re-runs every query on the Accounts page —
 * including the group-setup preview, which reads every group row of the connected account — so
 * running it fast enough to feel live would multiply the heaviest thing on the page by the rate.
 * Scanning a code is the one interaction here measured in the seconds a person spends waiting, and
 * a three-second page poll is long enough that a successful scan reads as no reaction at all.
 *
 * So the dialog polls THIS instead, roughly once a second while it is open: a single indexed row
 * read of seven columns, costing less than one of the queries the page refresh runs. The page's own
 * refresh is left exactly as it was and still owns the card behind the dialog.
 *
 * A Server Action rather than a Route Handler, matching `readGroupParticipants` — this app has
 * three Route Handlers and each is a file download, which is the one thing an action cannot do.
 */
export async function readLinkState(accountId: string): Promise<LinkState | null> {
  await requireSession();
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: {
      status: true,
      connectionStage: true,
      qrCode: true,
      qrUpdatedAt: true,
      pairingMethod: true,
      pairingPhoneNumber: true,
      phoneNumber: true,
      lastHeartbeatAt: true,
    },
  });
  if (!account) return null;
  return {
    status: account.status,
    connectionStage: account.connectionStage,
    qrCode: account.qrCode,
    qrUpdatedAt: account.qrUpdatedAt?.toISOString() ?? null,
    pairingMethod: account.pairingMethod,
    pairingPhoneNumber: account.pairingPhoneNumber,
    phoneNumber: account.phoneNumber,
    lastHeartbeatAt: account.lastHeartbeatAt?.toISOString() ?? null,
  };
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
  /** Present on a refusal, so the dialog can print what it is asking about. */
  impact?: AccountHistoryImpact;
  /** Present on a successful delete, so the toast can say what actually went. */
  destroyed?: AccountHistoryImpact;
}

/**
 * What this delete would actually take with it, for the dialog to print before anybody agrees.
 *
 * Read-only. Separate from the delete itself so the confirmation can name real numbers rather than
 * a generic warning — a confirmation that misdescribes what it is about to do is worse than none,
 * and "synced groups and message history" described about a third of the fourteen cascading
 * relations hanging off this row.
 */
export async function getAccountDeletionImpact(accountId: string): Promise<AccountHistoryImpact> {
  await requireSession();
  return countAccountHistory(accountId);
}

export async function deleteWhatsAppAccount(
  accountId: string,
  /**
   * Set only after the operator has been shown `getAccountDeletionImpact`'s real figures and said
   * yes to them. Without it an account carrying history is refused rather than silently destroyed.
   */
  confirmDestroyHistory = false,
): Promise<DeleteAccountResult> {
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

  const impact = await countAccountHistory(accountId);
  if (impact.hasHistory && !confirmDestroyHistory) {
    // Not a hard refusal — the operator may genuinely be retiring a number — but it does not
    // happen on one click, and the caller has to have seen the figures to get past this.
    return { error: "This account still holds history. Confirm what would be destroyed first.", impact };
  }

  // Collected BEFORE the delete: TeamAttendanceGroup cascades with the account, so afterwards
  // there is nothing left naming which days it contributed to.
  const affectedAttendanceDays = impact.attendanceEvidence
    ? (
        await prisma.teamAttendanceGroup.findMany({
          where: { accountId },
          select: { attendanceDayId: true },
        })
      ).map((row) => row.attendanceDayId)
    : [];

  await prisma.whatsAppAccount.delete({ where: { id: accountId } });

  // The day rows survive the cascade holding totals that counted the evidence just destroyed.
  // Recomputing them is what stops a duty row claiming messages nothing can show.
  const reconciledDays = await reconcileAttendanceAfterAccountRemoval(affectedAttendanceDays);

  await logSystemEvent("WARN", "accounts", `WhatsApp account "${target.label}" deleted`, {
    accountId,
    deletedBy: session.username,
    destroyed: impact,
    reconciledAttendanceDays: reconciledDays,
  });
  revalidatePath("/accounts");
  revalidatePath("/team-management/attendance");
  return { destroyed: impact };
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

/**
 * The most recent CREATE_GROUP / JOIN_GROUP / UPDATE_PROFILE command's outcome for one account —
 * one poll function shared by all three, since all three follow the same "queue it, then check
 * back" shape and none of them can meaningfully overlap on a single account (the underlying
 * browser session is one thing at a time regardless).
 */
export interface AccountCommandStatus {
  status: "IDLE" | "PENDING" | "DONE" | "FAILED";
  result?: Record<string, unknown>;
  error?: string;
}

async function readLatestAccountCommand(
  accountId: string,
  type: "CREATE_GROUP" | "JOIN_GROUP" | "UPDATE_PROFILE",
): Promise<AccountCommandStatus> {
  await requireSession();
  const command = await prisma.workerCommand.findFirst({
    where: { type, accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!command) return { status: "IDLE" };
  if (command.status === "PENDING" || command.status === "PROCESSING") return { status: "PENDING" };
  if (command.status === "FAILED") {
    return {
      status: "FAILED",
      error: (command.result as { error?: string } | null)?.error ?? "The worker could not complete this action.",
    };
  }
  return { status: "DONE", result: (command.result as Record<string, unknown> | null) ?? {} };
}

export interface CreateGroupResult {
  error?: string;
}

/**
 * Queues a new WhatsApp group creation from this account. The group is NOT written into
 * `WhatsAppGroup` here -- the next sync discovers it like any other new group, at its default
 * (unmonitored) flags, so an admin still has to opt it in deliberately.
 */
export async function requestCreateGroup(
  accountId: string,
  groupName: string,
  contactPhoneNumbersRaw: string,
): Promise<CreateGroupResult> {
  await requireSession();

  const trimmedName = groupName.trim();
  if (!trimmedName) return { error: "Give the group a name." };

  // One number per line or comma -- the same loose format bulk-entry fields in this app already
  // accept, rather than asking for a single delimiter format nobody remembers.
  const rawNumbers = contactPhoneNumbersRaw.split(/[,\n]+/).map((n) => n.trim()).filter(Boolean);
  const digits = rawNumbers.map((n) => normalizePhoneNumber(n)).filter((d): d is string => d !== null);
  if (digits.length === 0) {
    return { error: "Enter at least one valid phone number, one per line or comma-separated." };
  }

  const existing = await prisma.workerCommand.findFirst({
    where: { type: "CREATE_GROUP", accountId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (existing) return { error: "A group creation is already in progress for this account." };

  await prisma.workerCommand.create({
    data: { type: "CREATE_GROUP", accountId, payload: { groupName: trimmedName, contactPhoneNumbers: digits } },
  });
  revalidatePath("/accounts");
  return {};
}

export async function readCreateGroupResult(accountId: string): Promise<AccountCommandStatus> {
  return readLatestAccountCommand(accountId, "CREATE_GROUP");
}

export interface JoinGroupResult {
  error?: string;
}

/** Queues joining a group via its invite link, from this account. Same non-write behaviour as requestCreateGroup. */
export async function requestJoinGroup(accountId: string, inviteLink: string): Promise<JoinGroupResult> {
  await requireSession();

  const trimmed = inviteLink.trim();
  if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/.test(trimmed)) {
    return { error: "That does not look like a WhatsApp invite link (https://chat.whatsapp.com/...)." };
  }

  const existing = await prisma.workerCommand.findFirst({
    where: { type: "JOIN_GROUP", accountId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (existing) return { error: "Already trying to join a group with this account." };

  await prisma.workerCommand.create({ data: { type: "JOIN_GROUP", accountId, payload: { inviteLink: trimmed } } });
  revalidatePath("/accounts");
  return {};
}

export async function readJoinGroupResult(accountId: string): Promise<AccountCommandStatus> {
  return readLatestAccountCommand(accountId, "JOIN_GROUP");
}

export interface UpdateProfileResult {
  error?: string;
}

/**
 * Queues an update to this account's own WhatsApp profile. A partial update -- a field the
 * operator left blank in the form is omitted from the payload entirely, not sent as an empty
 * string, so a blank "About" field means "leave it as it is", never "clear it".
 */
export async function requestUpdateProfile(
  accountId: string,
  fields: { displayName?: string; about?: string; pictureDataUrl?: string },
): Promise<UpdateProfileResult> {
  await requireSession();

  const payload: Record<string, string> = {};
  if (fields.displayName?.trim()) payload.displayName = fields.displayName.trim();
  if (fields.about?.trim()) payload.about = fields.about.trim();
  if (fields.pictureDataUrl?.trim()) payload.pictureDataUrl = fields.pictureDataUrl.trim();
  if (Object.keys(payload).length === 0) return { error: "Change at least one field before saving." };

  const existing = await prisma.workerCommand.findFirst({
    where: { type: "UPDATE_PROFILE", accountId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (existing) return { error: "A profile update is already in progress for this account." };

  await prisma.workerCommand.create({ data: { type: "UPDATE_PROFILE", accountId, payload } });
  revalidatePath("/accounts");
  return {};
}

export async function readUpdateProfileResult(accountId: string): Promise<AccountCommandStatus> {
  return readLatestAccountCommand(accountId, "UPDATE_PROFILE");
}

export interface ProxyFormState {
  error?: string;
  success?: boolean;
}

/**
 * Saves (or clears) this account's outbound proxy and immediately queues a RECONNECT, because the
 * new setting only takes effect on the NEXT connect -- mirrors setPairingMethod's write-then-
 * reconnect shape above, for the same reason: a saved preference that needed a second button press
 * to take effect is the shape that leaves somebody staring at an unchanged connection.
 *
 * The password is encrypted with the SAME `encryptSecret` this schema already uses for Teams OAuth
 * tokens and AI provider keys. An empty address clears the whole configuration -- a proxy with no
 * address is not a partial proxy, it is no proxy.
 */
export async function saveAccountProxy(
  accountId: string,
  fields: { address: string; protocol?: string; username?: string; password?: string },
): Promise<ProxyFormState> {
  await requireSession();

  const address = fields.address.trim();
  if (!address) {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { proxyAddress: null, proxyProtocol: null, proxyUsername: null, proxyPasswordCiphertext: null },
    });
    await enqueueCommand("RECONNECT", accountId);
    revalidatePath("/accounts");
    return { success: true };
  }

  await prisma.whatsAppAccount.update({
    where: { id: accountId },
    data: {
      proxyAddress: address,
      proxyProtocol: fields.protocol?.trim() || null,
      proxyUsername: fields.username?.trim() || null,
      // Only re-encrypted when a new password was actually typed -- an operator editing the
      // address to fix a typo must not be forced to retype a password they are not changing.
      // Clearing a saved password is deliberately not this action's job: log out and back in with
      // a blank password to remove one that is no longer needed, which keeps "leave it" and
      // "clear it" from being ambiguous on the one field where a blank value cannot mean both.
      ...(fields.password?.trim() ? { proxyPasswordCiphertext: encryptSecret(fields.password.trim()) } : {}),
    },
  });
  await enqueueCommand("RECONNECT", accountId);
  revalidatePath("/accounts");
  return { success: true };
}
