import { fillRosterFromPattern, matchTeamMembersToWhatsApp } from "@support-automation/db";
import { normalizePhoneNumber } from "@support-automation/shared";
import { currentProjectId, forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { prisma } from "../db.js";
import { registerLoop, recordLoopTick } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { slowJobMayRun } from "../messagesFirst.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";

/**
 * The team runs itself (TEAM_AUTOMATION.md): team members are matched to the WhatsApp ID their messages arrive
 * under, and the roster is filled two weeks ahead from the weekly pattern. Both are on by default and each has
 * a switch on Team Settings. A slow job: it stands back while customer messages are being handled.
 */

const LOOP_NAME = "team-automation";
const MATCH_EVERY_MS = 10 * 60_000;
const ROSTER_EVERY_MS = 60 * 60_000;
const CONTACTS_EVERY_MS = 30 * 60_000;

const lastMatch = new Map<string, number>();
const lastRoster = new Map<string, number>();
const lastContacts = new Map<string, number>();
const seenEvidence = new Set<string>();

async function storeEvidence(lid: string, phone: string, name: string | null, source: "MESSAGE" | "CONTACTS"): Promise<void> {
  const projectId = currentProjectId();
  const memo = `${projectId}|${lid}|${phone}`;
  if (seenEvidence.has(memo)) return;
  await prisma.whatsAppIdentityEvidence.upsert({
    where: { projectId_lid: { projectId, lid } },
    create: { lid, phone, name, source },
    update: { phone, name: name ?? undefined, source, lastSeenAt: new Date() },
  });
  if (seenEvidence.size > 50_000) seenEvidence.clear();
  seenEvidence.add(memo);
}

/**
 * A message that names both its sender's private ID and their phone number proves the pair. Costs nothing on
 * every other message (no query), runs after the message is stored, and never throws.
 */
export async function recordSenderEvidence(raw: RawIncomingMessage): Promise<void> {
  try {
    if (!raw.senderPhoneEvidence || !raw.senderJid?.endsWith("@lid")) return;
    const phone = normalizePhoneNumber(raw.senderPhoneEvidence);
    if (phone) await storeEvidence(raw.senderJid.replace(/@.*$/, ""), phone, raw.senderName ?? null, "MESSAGE");
  } catch (err) {
    console.error("[team-automation] could not record sender evidence", (err as Error)?.message);
  }
}

async function readContacts(registry: ProviderRegistry, force: boolean): Promise<void> {
  const accounts = await prisma.whatsAppAccount.findMany({ where: { status: "CONNECTED" }, select: { id: true } });
  for (const account of accounts) {
    if (!force && Date.now() - (lastContacts.get(account.id) ?? 0) < CONTACTS_EVERY_MS) continue;
    const provider = registry.get(account.id);
    if (!provider?.readContactIdentities) continue;
    lastContacts.set(account.id, Date.now());
    const pairs = await provider.readContactIdentities();
    for (const pair of pairs ?? []) {
      const phone = normalizePhoneNumber(pair.phone);
      if (phone) await storeEvidence(pair.lid, phone, pair.name, "CONTACTS");
    }
  }
}

async function tickProject(registry: ProviderRegistry): Promise<void> {
  if (!(await projectHasFeature("TEAM_MANAGEMENT"))) return;
  const projectId = currentProjectId();
  const settings = await prisma.teamManagementSettings.findFirst({ select: { autoLinkMembers: true, autoRoster: true, matchRequestedAt: true } });
  const now = Date.now();
  const requested = settings?.matchRequestedAt ? settings.matchRequestedAt.getTime() > (lastMatch.get(projectId) ?? 0) : false;

  if ((settings?.autoLinkMembers ?? true) || requested) {
    if (requested || now - (lastMatch.get(projectId) ?? 0) >= MATCH_EVERY_MS) {
      lastMatch.set(projectId, now);
      await readContacts(registry, requested);
      const matches = await matchTeamMembersToWhatsApp(prisma, projectId);
      for (const match of matches) {
        await logSystemEvent("INFO", "team-automation", "Matched a team member to their WhatsApp ID", {
          memberId: match.memberId,
          how: match.how,
        });
      }
    }
  }
  if ((settings?.autoRoster ?? true) && now - (lastRoster.get(projectId) ?? 0) >= ROSTER_EVERY_MS) {
    lastRoster.set(projectId, now);
    await fillRosterFromPattern(prisma);
  }
}

export function startTeamAutomationProcessor(registry: ProviderRegistry, intervalMs = 30_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (slowJobMayRun(LOOP_NAME) ? forEachProject(LOOP_NAME, () => tickProject(registry)) : Promise.resolve())
      .catch((err) => console.error("[team-automation] tick failed", (err as Error)?.message))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
