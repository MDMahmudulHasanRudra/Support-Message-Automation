import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";

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
export async function ensureLegacyAccountExists(): Promise<WhatsAppAccount> {
  const existing = await prisma.whatsAppAccount.findFirst({ where: { sessionDataPath: LEGACY_SESSION_DATA_PATH } });
  if (existing) {
    // Upgrading from before this column existed — backfill once, using the exact same env-derived
    // value connect() has always used for this account, so nothing about its session changes.
    if (!existing.sessionId) {
      return prisma.whatsAppAccount.update({ where: { id: existing.id }, data: { sessionId: LEGACY_SESSION_ID } });
    }
    return existing;
  }
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
 * Self-heals a missing Primary — e.g. right after this feature's migration runs against an
 * existing install (every pre-existing row gets isPrimary=false by the column's own default; a
 * single row means there's exactly one reasonable choice), or if a Primary account was ever
 * deleted outright rather than demoted first. Never touches an already-valid Primary.
 */
export async function ensurePrimaryAccountExists(): Promise<void> {
  const primaryCount = await prisma.whatsAppAccount.count({ where: { isPrimary: true } });
  if (primaryCount > 0) return;
  const oldest = await prisma.whatsAppAccount.findFirst({ orderBy: { createdAt: "asc" } });
  if (oldest) {
    await prisma.whatsAppAccount.update({ where: { id: oldest.id }, data: { isPrimary: true } });
    console.log(`[registry] no Primary account found — auto-promoted "${oldest.label}" (${oldest.id})`);
  }
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
  return prisma.whatsAppAccount.update({
    where: { id: account.id },
    data: { sessionDataPath, sessionId },
  });
}

/** Every account with a session identity assigned — i.e. ready to be connected. */
export async function findConnectableAccounts(): Promise<WhatsAppAccount[]> {
  return prisma.whatsAppAccount.findMany({
    where: { sessionDataPath: { not: null }, sessionId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
}

/** Accounts that exist but haven't been assigned a session identity yet (created via "Add Account"). */
export async function findUnprovisionedAccounts(): Promise<WhatsAppAccount[]> {
  return prisma.whatsAppAccount.findMany({
    where: { OR: [{ sessionDataPath: null }, { sessionId: null }] },
    orderBy: { createdAt: "asc" },
  });
}
