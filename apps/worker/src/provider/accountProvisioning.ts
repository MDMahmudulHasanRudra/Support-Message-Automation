import { ORIGINAL_PROJECT_ID } from "@support-automation/db";
import { platformPrisma, prisma } from "../db.js";
import { forEachProject, withAccountProject, withProject } from "../project/context.js";
import type { WhatsAppAccount } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";

const LEGACY_SESSION_ID = process.env.WHATSAPP_SESSION_NAME ?? "support-automation";
const LEGACY_SESSION_DATA_PATH = process.env.WHATSAPP_SESSION_DIR ?? "/app/sessions";
const LEGACY_ACCOUNT_LABEL = process.env.WHATSAPP_ACCOUNT_LABEL ?? "Primary Account";
/** Every new (non-legacy) account gets its own subdirectory under the same mounted volume. */
const SESSION_ROOT = process.env.WHATSAPP_SESSION_DIR ?? "/app/sessions";

/**
 * Backward compatibility, load-bearing: before multi-account support, this exact
 * (sessionDataPath, sessionId) pair was the ONLY account, keyed only by sessionDataPath. Finding
 * it by that same path — never by id, never by label — is what lets an existing install upgrade
 * without losing its already-authenticated WhatsApp session (changing sessionId would make
 * OpenWA look in the wrong on-disk Chromium profile subdirectory; see the `sessionId` field's
 * doc comment in schema.prisma).
 */
export async function ensureLegacyAccountExists(): Promise<WhatsAppAccount | null> {
  // The session directory is this machine's, so the account using it is looked for across every
  // project — it may since have been moved — and it is only ever CREATED in ISP Digital, the
  // project every pre-multi-project row belongs to (MULTI_PROJECT_PLAN.md Phase 3).
  const existing = await platformPrisma.whatsAppAccount.findFirst({ where: { sessionDataPath: LEGACY_SESSION_DATA_PATH } });
  if (existing) {
    // Upgrading from before this column existed — backfill once, using the exact same env-derived
    // value connect() has always used for this account, so nothing about its session changes.
    if (!existing.sessionId) {
      return platformPrisma.whatsAppAccount.update({ where: { id: existing.id }, data: { sessionId: LEGACY_SESSION_ID } });
    }
    return existing;
  }
  // Created only on a FRESH install. It used to be created whenever no row used the session
  // folder — so an operator who deleted this account in the dashboard got it back on the next
  // restart, ready to reconnect with whatever WhatsApp link was still in the folder and to start
  // collecting into ISP Digital again. Once any account exists, a missing legacy row is a decision.
  if ((await platformPrisma.whatsAppAccount.count()) > 0) return null;
  return withProject(ORIGINAL_PROJECT_ID, () => createLegacyAccount());
}

async function createLegacyAccount(): Promise<WhatsAppAccount> {
  const anyAccountExists = (await prisma.whatsAppAccount.count()) > 0;
  return prisma.whatsAppAccount.create({
    data: {
      label: LEGACY_ACCOUNT_LABEL,
      sessionDataPath: LEGACY_SESSION_DATA_PATH,
      sessionId: LEGACY_SESSION_ID,
      status: "DISCONNECTED",
      // First account ever created on a fresh install becomes Primary automatically — satisfies
      // "if the application has only one WhatsApp account, everything continues working exactly
      // as it does today" without requiring any manual setup step.
      isPrimary: !anyAccountExists,
    },
  });
}

/**
 * Self-heals a missing Primary in a project that has exactly ONE account — right after this
 * feature's migration runs against an existing install (every pre-existing row gets isPrimary=false
 * by the column's own default, and a single row is the only reasonable choice), or a project whose
 * first number was added before the dashboard made it Primary. Never touches an existing Primary.
 *
 * Never with two or more accounts. Only the Primary answers customers (processIncomingMessage), so
 * which number is Primary is an operator's decision, and "no Primary" is one too (Remove Primary:
 * every connected number answers its own groups). Picking the OLDEST account here reversed that
 * decision on every restart — and the oldest is often a retired or logged-out spare, which then
 * silenced every customer reply in the project with nothing on screen saying why.
 */
export async function ensurePrimaryAccountExists(): Promise<void> {
  // Primary is per project: every project with accounts has exactly one, chosen from its own.
  await forEachProject("registry", () => ensurePrimaryInProject());
}

async function ensurePrimaryInProject(): Promise<void> {
  const primaryCount = await prisma.whatsAppAccount.count({ where: { isPrimary: true } });
  if (primaryCount > 0) return;
  const accounts = await prisma.whatsAppAccount.findMany({ select: { id: true, label: true }, take: 2 });
  if (accounts.length !== 1) return;
  const only = accounts[0]!;
  await prisma.whatsAppAccount.update({ where: { id: only.id }, data: { isPrimary: true } });
  console.log(`[registry] the project's only account had no Primary — made "${only.label}" (${only.id}) Primary`);
  await logSystemEvent("INFO", "accounts", `"${only.label}" made Primary: it is the project's only WhatsApp account`, {
    accountId: only.id,
  }).catch(() => undefined);
}

/**
 * Accounts created from the web UI ("Add Account") start with no sessionDataPath/sessionId —
 * the web app doesn't know WHATSAPP_SESSION_DIR (only the worker's env has it), so assigning one
 * is the worker's job, done once per account, the first time the account-sync poller notices it.
 */
export async function assignSessionForAccount(account: WhatsAppAccount): Promise<WhatsAppAccount> {
  if (account.sessionDataPath && account.sessionId) return account;
  const sessionId = `support-automation-${account.id}`;
  const sessionDataPath = `${SESSION_ROOT}/${account.id}`;
  return withAccountProject(account.id, () =>
    prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { sessionDataPath, sessionId },
    }),
  );
}

/**
 * Every account with a session identity assigned — i.e. ready to be connected. Across every
 * project: this one worker process holds every project's WhatsApp sessions, and each account's
 * work then runs inside its own project (withAccountProject).
 */
export async function findConnectableAccounts(): Promise<WhatsAppAccount[]> {
  return platformPrisma.whatsAppAccount.findMany({
    // An ARCHIVED project's accounts are disconnected and stay so (§8); nothing is logged out, so
    // its sessions are intact on disk.
    where: { sessionDataPath: { not: null }, sessionId: { not: null }, project: { status: { not: "ARCHIVED" } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Accounts that exist but haven't been assigned a session identity yet (created via "Add Account"). */
export async function findUnprovisionedAccounts(): Promise<WhatsAppAccount[]> {
  return platformPrisma.whatsAppAccount.findMany({
    where: { OR: [{ sessionDataPath: null }, { sessionId: null }] },
    orderBy: { createdAt: "asc" },
  });
}
