import { rm } from "node:fs/promises";
import path from "node:path";
import { prisma as globalPrisma, Prisma } from "@support-automation/db";
import { LocalMediaStorage } from "@support-automation/media-storage";
import { deletionOrder } from "@support-automation/shared";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * Removing a customer from the platform, and deleting one permanently (CUSTOMER_REMOVAL.md). The
 * platform operator chooses which; the actions in `actions/customers.ts` check who is asking, the
 * typed name and the operator's password, and call these.
 *
 * REMOVE keeps every row. It switches the customer's software off the way the platform already knows
 * how to: every workspace ARCHIVED (the worker releases its WhatsApp sessions without logging them
 * out, and holds everything else), every address DISABLED (it opens nothing), every login inactive
 * and signed out, support access and pending invitations ended. What it changed is recorded in
 * `Customer.removalSnapshot`, and Restore puts back exactly that.
 *
 * DELETE PERMANENTLY removes first (so the worker lets go and nothing new arrives), then erases every
 * workspace with all its data, and the customer's logins, roles, departments, job titles, employees,
 * addresses, invitations, support sessions, security settings, branding and System Log. The tables
 * are read from the database's own catalogue — every table with a "projectId" column — and emptied in
 * foreign-key order (`deletionOrder`), so a table added later is covered without anyone listing it.
 * One transaction: it all goes, or nothing does. The customer row itself stays, marked purged, because
 * the platform's own invoices and payments for it are kept (payments are append-only by design).
 */

const CUSTOMER_TABLES = [
  "User",
  "PermissionModule",
  "Department",
  "JobTitle",
  "Employee",
  "CustomerDomain",
  "UserInvitation",
  "SupportAccessSession",
  "SecuritySettings",
  "PlatformBranding",
  "ModuleTemplate",
  "SystemLog",
] as const;

/** A table's rows for the purge, by how the table names its owner. */
function ownerCondition(table: string, projectTables: Set<string>): string {
  if (table === "Project") return `"id" = ANY($1::text[])`;
  const byProject = projectTables.has(table);
  const byCustomer = (CUSTOMER_TABLES as readonly string[]).includes(table);
  if (byProject && byCustomer) return `("projectId" = ANY($1::text[]) OR "customerId" = $2)`;
  return byProject ? `"projectId" = ANY($1::text[])` : `"customerId" = $2`;
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface RemovalSnapshot {
  projects: Array<{ id: string; status: string }>;
  domains: Array<{ id: string; status: string }>;
  userIds: string[];
}

function readSnapshot(value: Prisma.JsonValue | null): RemovalSnapshot {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const pairs = (list: unknown) =>
    (Array.isArray(list) ? list : []).flatMap((item) => {
      const row = item as { id?: unknown; status?: unknown };
      return typeof row?.id === "string" && typeof row?.status === "string" ? [{ id: row.id, status: row.status }] : [];
    });
  return {
    projects: pairs(raw.projects),
    domains: pairs(raw.domains),
    userIds: (Array.isArray(raw.userIds) ? raw.userIds : []).filter((id): id is string => typeof id === "string"),
  };
}

type Refusal = { error: string };

async function lockCustomer(tx: Prisma.TransactionClient, customerId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; isFounding: boolean; removedAt: Date | null; purgedAt: Date | null; removalSnapshot: Prisma.JsonValue | null }>>`
    SELECT "id", "name", "isFounding", "removedAt", "purgedAt", "removalSnapshot" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Remove: switch everything off, keep every row. */
export async function removeCustomerData(customerId: string, actor: string): Promise<Refusal | { snapshot: RemovalSnapshot; name: string }> {
  return globalPrisma.$transaction(async (tx) => {
    const customer = await lockCustomer(tx, customerId);
    if (!customer) return { error: "This customer no longer exists." };
    if (customer.isFounding) return { error: "The original installation cannot be removed." };
    if (customer.purgedAt) return { error: "This customer was already deleted permanently." };
    if (customer.removedAt) return { error: "This customer is already removed." };

    const now = new Date();
    const [projects, domains, users] = await Promise.all([
      tx.project.findMany({ where: { customerId }, select: { id: true, status: true } }),
      tx.customerDomain.findMany({ where: { customerId }, select: { id: true, status: true } }),
      tx.user.findMany({ where: { customerId, isActive: true }, select: { id: true } }),
    ]);
    const snapshot: RemovalSnapshot = { projects, domains, userIds: users.map((u) => u.id) };

    await tx.project.updateMany({ where: { customerId, status: { not: "ARCHIVED" } }, data: { status: "ARCHIVED" } });
    await tx.customerDomain.updateMany({ where: { customerId, status: { not: "DISABLED" } }, data: { status: "DISABLED", disabledAt: now } });
    await tx.user.updateMany({ where: { customerId, isActive: true }, data: { isActive: false } });
    await tx.userSession.updateMany({ where: { user: { customerId }, revokedAt: null }, data: { revokedAt: now, revokedReason: "CUSTOMER_REMOVED" } });
    await tx.supportAccessSession.updateMany({ where: { customerId, endedAt: null }, data: { endedAt: now, endReason: "REVOKED", endedByUsername: actor } });
    await tx.userInvitation.updateMany({ where: { customerId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now, linkCiphertext: null } });
    await tx.customer.update({
      where: { id: customerId },
      data: { removedAt: now, removedByUsername: actor, removalSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });
    return { snapshot, name: customer.name };
  });
}

/** Restore: put back what Remove recorded. Pending invitations stay revoked (send new ones). */
export async function restoreCustomerData(customerId: string): Promise<Refusal | { name: string; restored: { projects: number; domains: number; users: number } }> {
  return globalPrisma.$transaction(async (tx) => {
    const customer = await lockCustomer(tx, customerId);
    if (!customer) return { error: "This customer no longer exists." };
    if (customer.purgedAt) return { error: "This customer was deleted permanently and cannot be restored." };
    if (!customer.removedAt) return { error: "This customer is not removed." };

    const snapshot = readSnapshot(customer.removalSnapshot);
    let projects = 0;
    for (const p of snapshot.projects) {
      if (p.status === "ARCHIVED") continue;
      projects += (await tx.project.updateMany({ where: { id: p.id, customerId, status: "ARCHIVED" }, data: { status: p.status as never } })).count;
    }
    let domains = 0;
    for (const d of snapshot.domains) {
      if (d.status === "DISABLED") continue;
      domains += (await tx.customerDomain.updateMany({ where: { id: d.id, customerId, status: "DISABLED" }, data: { status: d.status, disabledAt: null } })).count;
    }
    const users = snapshot.userIds.length
      ? (await tx.user.updateMany({ where: { id: { in: snapshot.userIds }, customerId }, data: { isActive: true } })).count
      : 0;
    await tx.customer.update({ where: { id: customerId }, data: { removedAt: null, removedByUsername: null, removalSnapshot: Prisma.DbNull } });
    return { name: customer.name, restored: { projects, domains, users } };
  });
}

/** Every table that holds a workspace's rows, and the keys that decide the order to empty them in. */
async function purgePlan(tx: Prisma.TransactionClient): Promise<{ order: string[]; projectTables: Set<string> } | Refusal> {
  const columns = await tx.$queryRaw<Array<{ table_name: string }>>`
    SELECT "table_name" FROM information_schema.columns
    WHERE "table_schema" = current_schema() AND "column_name" = 'projectId'`;
  const projectTables = new Set(columns.map((c) => c.table_name));
  const tables = [...new Set([...projectTables, ...CUSTOMER_TABLES, "Project"])];
  const unsafe = tables.find((t) => !SAFE_IDENTIFIER.test(t));
  if (unsafe) return { error: `Unexpected table name "${unsafe}". Nothing was deleted.` };
  const keys = await tx.$queryRaw<Array<{ child: string; parent: string; blocking: boolean }>>`
    SELECT cl.relname AS "child", pr.relname AS "parent", c.confdeltype IN ('a', 'r') AS "blocking"
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class pr ON pr.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype = 'f' AND n.nspname = current_schema()`;
  const ordered = deletionOrder(tables, keys);
  if (!ordered.ok) return { error: `These tables point at each other and cannot be emptied in order: ${ordered.cycle.join(", ")}. Nothing was deleted.` };
  return { order: ordered.order, projectTables };
}

/**
 * Delete permanently. Removes first when the customer is still in use (its own committed step, so the
 * worker lets go of its WhatsApp sessions and stops writing), then erases everything in one transaction.
 */
export async function purgeCustomerData(
  customerId: string,
  actor: string,
): Promise<Refusal | { name: string; projectIds: string[]; deleted: Record<string, number>; mediaRemoved: boolean }> {
  const current = await globalPrisma.customer.findUnique({ where: { id: customerId }, select: { isFounding: true, removedAt: true, purgedAt: true } });
  if (!current) return { error: "This customer no longer exists." };
  if (current.isFounding) return { error: "The original installation cannot be deleted." };
  if (current.purgedAt) return { error: "This customer was already deleted permanently." };
  if (!current.removedAt) {
    const removed = await removeCustomerData(customerId, actor);
    if ("error" in removed) return removed;
  }

  const result = await globalPrisma.$transaction(
    async (tx) => {
      const customer = await lockCustomer(tx, customerId);
      if (!customer) return { error: "This customer no longer exists." };
      if (customer.isFounding) return { error: "The original installation cannot be deleted." };
      if (customer.purgedAt) return { error: "This customer was already deleted permanently." };

      // Locking the workspaces blocks every insert that points at them (each foreign-key check needs a
      // share lock on the row), so nothing new can land between one table being emptied and the next.
      const projects = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Project" WHERE "customerId" = ${customerId} FOR UPDATE`;
      const projectIds = projects.map((p) => p.id);
      const plan = await purgePlan(tx);
      if ("error" in plan) return plan;

      const deleted: Record<string, number> = {};
      for (const table of plan.order) {
        const count = await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${ownerCondition(table, plan.projectTables)}`, projectIds, customerId);
        if (count > 0) deleted[table] = count;
      }
      await tx.customer.update({
        where: { id: customerId },
        data: { purgedAt: new Date(), purgedByUsername: actor, removalSnapshot: Prisma.DbNull },
      });
      return { name: customer.name, projectIds, deleted };
    },
    { timeout: 15 * 60_000, maxWait: 30_000 },
  );
  if ("error" in result) return result;
  return { ...result, mediaRemoved: await removeMediaFiles(result.projectIds) };
}

/**
 * The workspaces' files on the media volume (MEDIA_STORAGE.md: `whatsapp/<projectId>/…` and
 * `outbound/<projectId>/…`). After the database commit, so a failed delete never leaves rows pointing at
 * missing files. Best effort: false when storage is not local or a folder could not be removed.
 */
async function removeMediaFiles(projectIds: string[]): Promise<boolean> {
  if (projectIds.length === 0) return true;
  const storage = getMediaStorage();
  if (!(storage instanceof LocalMediaStorage)) return false;
  let ok = true;
  for (const id of projectIds) {
    if (!SAFE_IDENTIFIER.test(id)) {
      ok = false;
      continue;
    }
    for (const area of ["whatsapp", "outbound"]) {
      try {
        await rm(path.join(storage.root, area, id), { recursive: true, force: true });
      } catch (err) {
        console.error(`[platform] could not remove media for a deleted workspace (${area}/${id})`, err);
        ok = false;
      }
    }
  }
  return ok;
}
