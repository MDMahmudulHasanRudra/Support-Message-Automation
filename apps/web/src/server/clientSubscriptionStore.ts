import { Prisma } from "@prisma/client";
import { pickCurrentSubscription } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Write-side plumbing shared by the subscription, client and billing actions (CLIENTS_V3.md). Not a
 * "use server" file: nothing here is an endpoint, and every caller has made its own permission check.
 */

type Tx = Prisma.TransactionClient;

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Locks one client row for the rest of the transaction, so two people changing the same client's
 * subscriptions serialise and the current-term pointer cannot be computed from a stale read.
 * Returns false when the client is not in this project (the raw query names the project itself).
 */
export async function lockClient(tx: Tx, clientId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Client" WHERE "id" = ${clientId} AND "projectId" = ${await activeProjectId()} FOR UPDATE`,
  );
  return rows.length === 1;
}

/** Recomputes `Client.currentSubscriptionId` from every term (`pickCurrentSubscription`). Call after any term change, inside the lock. */
export async function refreshCurrentSubscription(tx: Tx, clientId: string): Promise<string | null> {
  const terms = await tx.clientSubscription.findMany({ where: { clientId }, select: { id: true, startDate: true, endDate: true, cancelledAt: true } });
  const current = pickCurrentSubscription(terms.map((t) => ({ id: t.id, startDate: day(t.startDate), endDate: day(t.endDate), cancelledAt: t.cancelledAt })));
  await tx.client.update({ where: { id: clientId }, data: { currentSubscriptionId: current?.id ?? null } });
  return current?.id ?? null;
}

export interface SellerSnapshot {
  soldByMemberId: string | null;
  soldByName: string | null;
  soldByTeamId: string | null;
  soldByTeamName: string | null;
}

/**
 * The seller of a NEW sale, from the project's real roster: an ACTIVE `InternalTeamMember`, with their
 * team as it is right now (snapshotted, so a later transfer never rewrites who sold what). A member on
 * a disabled team may still sell, but the team is not recorded as selling. Null = no seller named.
 */
export async function sellerSnapshot(memberId: string | null, db: Tx | typeof prisma = prisma): Promise<SellerSnapshot | { error: string }> {
  if (!memberId) return { soldByMemberId: null, soldByName: null, soldByTeamId: null, soldByTeamName: null };
  const member = await db.internalTeamMember.findFirst({ where: { id: memberId }, select: { id: true, name: true, status: true, team: { select: { id: true, name: true, status: true } } } });
  if (!member) return { error: "That seller is not on this project's team roster." };
  if (member.status !== "ACTIVE") return { error: `${member.name} is no longer active, so a new sale cannot be credited to them.` };
  const team = member.team && member.team.status === "ACTIVE" ? member.team : null;
  return { soldByMemberId: member.id, soldByName: member.name, soldByTeamId: team?.id ?? null, soldByTeamName: team?.name ?? null };
}

/**
 * A client's assigned team and staff, checked against the real roster: both in this project, a NEW
 * assignment only to an active team and an active member, and the member must belong to the team when
 * both are named. An existing assignment that has since gone inactive may be kept as it is.
 */
export async function checkAssignment(
  teamId: string | null,
  memberId: string | null,
  current: { teamId: string | null; memberId: string | null } = { teamId: null, memberId: null },
): Promise<{ error: string } | null> {
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId }, select: { name: true, status: true } });
    if (!team) return { error: "That team does not exist in this project." };
    if (team.status !== "ACTIVE" && teamId !== current.teamId) return { error: `The team ${team.name} is disabled, so nobody new can be assigned to it.` };
  }
  if (memberId) {
    const member = await prisma.internalTeamMember.findFirst({ where: { id: memberId }, select: { name: true, status: true, teamId: true } });
    if (!member) return { error: "That staff member does not exist in this project." };
    if (member.status !== "ACTIVE" && memberId !== current.memberId) return { error: `${member.name} is no longer active, so they cannot be newly assigned.` };
    if (teamId && member.teamId !== teamId && memberId !== current.memberId) return { error: `${member.name} is not in the chosen team.` };
  }
  return null;
}

/** The next invoice / receipt number from the installation-wide sequences. */
export async function nextDocumentNumber(tx: Tx, kind: "invoice" | "receipt"): Promise<number> {
  const rows =
    kind === "invoice"
      ? await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('client_invoice_seq')::bigint AS n`
      : await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('client_receipt_seq')::bigint AS n`;
  return Number(rows[0]!.n);
}
