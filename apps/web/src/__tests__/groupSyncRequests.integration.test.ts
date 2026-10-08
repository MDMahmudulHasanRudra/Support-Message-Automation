import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Asking for a group sync (GROUP_SYNC.md): one request per account in flight, and the dashboard is
 * told when a sync was already running rather than shown a second one starting.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { user: "", role: "", accounts: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const action = await import("@/server/actions/accounts");
const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);

beforeAll(async () => {
  const keys = ["whatsapp.view", "whatsapp.manage"];
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `Sync ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.role = role.id;
  const user = await rawPrisma.user.create({ data: { username: `sync_${tag}`, email: `sync_${tag}@example.test`, name: "Sync", passwordHash: "x", permissionModuleId: role.id } });
  ids.user = user.id;
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: user.id } });
  current = { userId: user.id, username: user.username, email: user.email!, name: "Sync" } as Session;
  for (let i = 0; i < 2; i++) {
    ids.accounts.push((await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `Sync ${tag} ${i}`, status: "CONNECTED" } })).id);
  }
});

afterAll(async () => {
  await rawPrisma.workerCommand.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

describe("asking for a group sync", () => {
  it("queues one per account and says so when one is already in progress", async () => {
    const [a] = ids.accounts;
    expect(await inIsp(() => action.requestGroupResync(a!))).toEqual({ alreadyRunning: false });
    expect(await inIsp(() => action.requestGroupResync(a!))).toEqual({ alreadyRunning: true });
    expect(await rawPrisma.workerCommand.count({ where: { accountId: a!, type: "RESYNC_GROUPS" } })).toBe(1);
  });

  it("Sync Groups queues each account on its own and counts the ones already syncing", async () => {
    const before = await rawPrisma.workerCommand.count({ where: { type: "RESYNC_GROUPS", status: { in: ["PENDING", "PROCESSING"] } } });
    const result = await inIsp(() => action.requestSyncAllGroups());
    // Every ISP Digital account is either queued now or already had a sync in flight.
    expect(result.alreadyRunning).toBeGreaterThanOrEqual(1);
    expect(result.accountsQueued + result.alreadyRunning).toBe(await rawPrisma.whatsAppAccount.count({ where: { projectId: ORIGINAL_PROJECT_ID } }));
    const after = await rawPrisma.workerCommand.count({ where: { type: "RESYNC_GROUPS", status: { in: ["PENDING", "PROCESSING"] } } });
    expect(after - before).toBe(result.accountsQueued);
    expect(await rawPrisma.workerCommand.count({ where: { accountId: ids.accounts[1]!, type: "RESYNC_GROUPS" } })).toBe(1);
  });
});
