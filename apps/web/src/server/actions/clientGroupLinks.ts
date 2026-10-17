"use server";

import { revalidatePath } from "next/cache";
import { GROUP_LINK_LIMITS, groupLinkRefusal } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { recordClientActivity } from "@/server/clientRecords";
import { subModuleOff } from "@/server/clientModule";

/**
 * Linking a client to an existing WhatsApp GROUP (CLIENTS_V3.md §8). Every action checks
 * `clients.link_whatsapp_group` and that the sub-module is on. A link is data: nothing here joins a
 * group, starts a session, sends a message, or touches `isMonitored` / AI flags — the only rows
 * written are the link itself, the client's timeline and a System Log entry.
 *
 * Personal one-to-one chat links (`clientChatLinks.ts`) are a separate table and a separate key, and
 * keep refusing groups.
 */

export interface GroupCandidate {
  groupId: string;
  name: string;
  whatsappGroupId: string;
  participantCount: number | null;
  isMonitored: boolean;
  /** The client this group is already linked to (through any of our numbers), when it is. */
  linkedTo: { clientId: string; code: string; name: string } | null;
}

export interface GroupLinkResult {
  ok: boolean;
  message: string;
}

async function refresh(clientId: string) {
  revalidatePath(await projectPath("/clients"));
  revalidatePath(await projectPath(`/clients/${clientId}`));
}

/**
 * The account's groups to choose from: synced, ACTIVE groups of one of this project's accounts, by
 * name or id. Refuses as an empty list (a reader polled while somebody types must not throw). Never
 * reads the browser session or the QR; the list is what group sync already stored.
 */
export async function searchLinkableGroups(accountId: string, query: string): Promise<GroupCandidate[]> {
  const granted = await checkPermission("clients.link_whatsapp_group");
  if ("denied" in granted) return [];
  if (await subModuleOff("whatsappGroups")) return [];
  const account = await prisma.whatsAppAccount.findFirst({ where: { id: String(accountId ?? "") }, select: { id: true } });
  if (!account) return [];
  const q = String(query ?? "").trim().slice(0, 80);
  const groups = await prisma.whatsAppGroup.findMany({
    where: {
      accountId: account.id,
      isActive: true,
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { whatsappGroupId: { contains: q } }] } : {}),
    },
    select: { id: true, name: true, whatsappGroupId: true, participantCount: true, isMonitored: true },
    orderBy: { name: "asc" },
    take: 40,
  });
  const owners = groups.length
    ? await prisma.clientWhatsAppGroupLink.findMany({
        where: { unlinkedAt: null, whatsappGroupId: { in: groups.map((g) => g.whatsappGroupId) } },
        select: { whatsappGroupId: true, client: { select: { id: true, code: true, name: true } } },
      })
    : [];
  const ownerOf = new Map(owners.map((o) => [o.whatsappGroupId, o.client]));
  return groups.map((g) => {
    const owner = ownerOf.get(g.whatsappGroupId);
    return {
      groupId: g.id,
      name: g.name,
      whatsappGroupId: g.whatsappGroupId,
      participantCount: g.participantCount,
      isMonitored: g.isMonitored,
      linkedTo: owner ? { clientId: owner.id, code: owner.code, name: owner.name || "Unnamed client" } : null,
    };
  });
}

/** Shared by the client page and the Add Client form: checks and writes one link inside a transaction. */
export async function linkClientGroup(clientId: string, accountId: string, groupId: string): Promise<GroupLinkResult> {
  const granted = await checkPermission("clients.link_whatsapp_group");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const off = await subModuleOff("whatsappGroups");
  if (off) return { ok: false, message: off };
  const client = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };
  if (client.status === "ARCHIVED") return { ok: false, message: "This client is archived. Restore it before linking a group." };
  const group = await prisma.whatsAppGroup.findFirst({ where: { id: groupId }, select: { id: true, name: true, whatsappGroupId: true, isActive: true, accountId: true } });
  const refusal = groupLinkRefusal(group, accountId);
  if (refusal) return { ok: false, message: refusal };
  const owner = await prisma.clientWhatsAppGroupLink.findFirst({ where: { unlinkedAt: null, whatsappGroupId: group!.whatsappGroupId }, select: { clientId: true, client: { select: { code: true, name: true } } } });
  if (owner) {
    return {
      ok: false,
      message:
        owner.clientId === clientId
          ? "This group is already linked to this client."
          : `This group is already linked to ${owner.client.name || "Unnamed client"} (${owner.client.code}). Unlink it there first if it really belongs to this client.`,
    };
  }
  if ((await prisma.clientWhatsAppGroupLink.count({ where: { clientId, unlinkedAt: null } })) >= GROUP_LINK_LIMITS.perClient) {
    return { ok: false, message: `A client can have at most ${GROUP_LINK_LIMITS.perClient} linked groups.` };
  }
  let linkId: string;
  try {
    linkId = await prisma.$transaction(async (tx) => {
      const link = await tx.clientWhatsAppGroupLink.create({
        data: { clientId, accountId, groupId: group!.id, whatsappGroupId: group!.whatsappGroupId, groupName: group!.name, linkedById: granted.session.userId },
        select: { id: true },
      });
      await recordClientActivity(tx, clientId, granted.session.userId, { type: "GROUP_LINKED", summary: `WhatsApp group linked: ${group!.name}`, details: { linkId: link.id, accountId, groupId } });
      return link.id;
    });
  } catch (err) {
    // Two people linking one group at once: the one-active-owner index decides.
    if (isUniqueViolation(err)) return { ok: false, message: "This group was just linked to a client by someone else." };
    throw err;
  }
  await logSystemEvent("INFO", "clients", "WhatsApp group linked to a client", { linkId, clientId, accountId, groupId }, { actorUserId: granted.session.userId, targetType: "Client", targetId: clientId });
  await refresh(clientId);
  return { ok: true, message: `Linked to ${group!.name}. Nothing was sent, and the group's monitoring is unchanged.` };
}

export async function unlinkClientGroup(linkId: string, reason: string): Promise<GroupLinkResult> {
  const granted = await checkPermission("clients.link_whatsapp_group");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const off = await subModuleOff("whatsappGroups");
  if (off) return { ok: false, message: off };
  const why = String(reason ?? "").trim().slice(0, GROUP_LINK_LIMITS.unlinkReason) || null;
  const link = await prisma.clientWhatsAppGroupLink.findFirst({ where: { id: linkId, unlinkedAt: null }, select: { clientId: true, groupName: true } });
  if (!link) return { ok: false, message: "That link no longer exists." };
  // Conditional on still being active, so two presses (or two people) unlink once. The row stays as history.
  const done = await prisma.$transaction(async (tx) => {
    const updated = await tx.clientWhatsAppGroupLink.updateMany({ where: { id: linkId, unlinkedAt: null }, data: { unlinkedAt: new Date(), unlinkedById: granted.session.userId, unlinkReason: why } });
    if (updated.count === 0) return false;
    await recordClientActivity(tx, link.clientId, granted.session.userId, { type: "GROUP_UNLINKED", summary: `WhatsApp group link removed: ${link.groupName}`, details: { linkId } });
    return true;
  });
  if (!done) return { ok: false, message: "That link was already removed." };
  await logSystemEvent("INFO", "clients", "WhatsApp group unlinked from a client", { linkId, clientId: link.clientId }, { actorUserId: granted.session.userId, targetType: "Client", targetId: link.clientId });
  await refresh(link.clientId);
  return { ok: true, message: "Link removed. The group itself is unchanged." };
}
