import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * WhatsApp Groups Admin Maker — the dashboard side (GROUP_ADMIN_MAKER.md): the actions that start,
 * cancel and resume a job, called exactly as the browser calls them, with only the request plumbing
 * stubbed. What they must guarantee: one job per account + number however the number is typed and
 * however fast the button is pressed, only connected accounts of this project, only the groups the
 * account is still in, and the existing permission.
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const actions = await import("@/server/actions/groupAdminPromotion");
const reads = await import("@/server/groupAdminPromotion");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const LOCAL = `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`; // 01XXXXXXXXX
const INTERNATIONAL = `88${LOCAL}`;
const ids = { manager: "", viewer: "", account: "", offline: "", bizAccount: "", biz: "", roles: [] as string[] };
const sessions = {} as Record<"manager" | "viewer", Session>;
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" }, fn);

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  return { id: u.id, session: { userId: u.id, username: u.username, email: u.email!, name } as Session };
}

beforeAll(async () => {
  const m = await user("adminmaker_mgr", await role("AdminMaker manage", ["bulk_messaging.view", "bulk_messaging.manage"]));
  const v = await user("adminmaker_view", await role("AdminMaker view", ["bulk_messaging.view"]));
  ids.manager = m.id;
  ids.viewer = v.id;
  sessions.manager = m.session;
  sessions.viewer = v.session;

  const pid = { projectId: ORIGINAL_PROJECT_ID };
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `AM ${tag}`, status: "CONNECTED" } });
  const offline = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `AM offline ${tag}`, status: "DISCONNECTED" } });
  ids.account = account.id;
  ids.offline = offline.id;
  for (const [i, active] of [true, true, true, false].entries()) {
    await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: account.id, whatsappGroupId: `am-${tag}-${i}@g.us`, name: `AM group ${i}`, isActive: active } });
  }
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: offline.id, whatsappGroupId: `amo-${tag}@g.us`, name: "AM offline group", isActive: true } });

  const biz = await createProjectWithDefaults({ name: `AM Biz ${tag}`, slug: `am-biz-${tag}`, status: "ACTIVE", creatorUserId: m.id }, rawPrisma);
  ids.biz = biz.id;
  const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `AM Biz ${tag}`, status: "CONNECTED" } });
  ids.bizAccount = bizAccount.id;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bizAccount.id, whatsappGroupId: `amb-${tag}@g.us`, name: "AM Biz group", isActive: true } });
});

afterAll(async () => {
  await rawPrisma.groupAdminPromotionJob.deleteMany({ where: { accountId: { in: [ids.account, ids.offline, ids.bizAccount] } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: [ids.account, ids.offline, ids.bizAccount] } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [ids.account, ids.offline, ids.bizAccount] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: [ids.manager, ids.viewer] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [ids.manager, ids.viewer] } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

describe("starting a job", () => {
  it("normalizes the number and covers every group the account is still in", async () => {
    current = sessions.manager;
    const r = await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: LOCAL }));
    expect(r.error).toBeUndefined();
    expect(r.existing).toBe(false);
    const job = await rawPrisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: r.jobId! }, include: { items: true } });
    expect(job).toMatchObject({ phoneNumber: INTERNATIONAL, status: "CHECKING", totalGroups: 3, projectId: ORIGINAL_PROJECT_ID, createdById: ids.manager });
    expect(job.items.map((i) => i.groupNameSnapshot).sort()).toEqual(["AM group 0", "AM group 1", "AM group 2"]);
    expect(job.items.every((i) => i.status === "PENDING")).toBe(true);
  });

  it("returns the running job instead of starting another, however the number is written", async () => {
    current = sessions.manager;
    const first = await rawPrisma.groupAdminPromotionJob.findFirstOrThrow({ where: { accountId: ids.account, phoneNumber: INTERNATIONAL } });
    for (const typed of [LOCAL, `+${INTERNATIONAL}`, INTERNATIONAL, `+88 ${LOCAL.slice(0, 5)}-${LOCAL.slice(5)}`]) {
      const r = await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: typed }));
      expect(r).toMatchObject({ jobId: first.id, existing: true });
    }
    expect(await rawPrisma.groupAdminPromotionJob.count({ where: { accountId: ids.account } })).toBe(1);
  });

  it("two presses at the same instant still make one job", async () => {
    current = sessions.manager;
    const other = `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const results = await Promise.all([1, 2, 3].map(() => inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: other }))));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.existing === false)).toHaveLength(1);
    expect(await rawPrisma.groupAdminPromotionJob.count({ where: { accountId: ids.account, phoneNumber: other } })).toBe(1);
  });

  it("decides under a lock: a start waits for anyone else deciding the same account + number", async () => {
    // Racing Promise.all alone cannot prove this — the window between the check and the insert is
    // milliseconds wide and the race rarely lands in it. Holding the lock ourselves does: without it
    // the start returns at once, with it the start waits until we let go.
    current = sessions.manager;
    const number = `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    let released = false;
    const holder = rawPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-admin-promotion:${ids.account}:${number}`})::bigint)`;
        await new Promise((r) => setTimeout(r, 1500));
        released = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    const r = await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: number }));
    expect(released).toBe(true);
    expect(r.existing).toBe(false);
    await holder;
  });

  it("refuses a disconnected account, an invalid number, another project's account and a view-only role", async () => {
    current = sessions.manager;
    expect((await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.offline, phoneNumber: LOCAL }))).error).toMatch(/not connected/);
    expect((await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: "12ab" }))).error).toMatch(/Enter one WhatsApp number/);
    expect((await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.bizAccount, phoneNumber: LOCAL }))).error).toMatch(/not found in this project/);
    current = sessions.viewer;
    expect((await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: "8801700000002" }))).error).toBeTruthy();
    expect(await rawPrisma.groupAdminPromotionJob.count({ where: { accountId: { in: [ids.offline, ids.bizAccount] } } })).toBe(0);
    expect(await rawPrisma.groupAdminPromotionJob.count({ where: { phoneNumber: "8801700000002" } })).toBe(0);
  });
});

describe("the job survives the page", () => {
  it("is found again on a later visit, with its progress", async () => {
    current = sessions.manager;
    const job = await rawPrisma.groupAdminPromotionJob.findFirstOrThrow({ where: { accountId: ids.account, phoneNumber: INTERNATIONAL } });
    await rawPrisma.groupAdminPromotionItem.updateMany({ where: { jobId: job.id, groupNameSnapshot: "AM group 0" }, data: { status: "PROMOTED" } });
    const active = await inIsp(() => reads.getActiveAdminPromotionJobs());
    const found = active.find((j) => j.id === job.id)!;
    expect(found.counts).toMatchObject({ total: 3, checked: 1, promoted: 1, pending: 2 });
    // Bizify sees none of it.
    const inBiz = await runWithProject({ id: ids.biz, slug: `am-biz-${tag}`, name: "Biz", status: "ACTIVE" }, () => reads.getActiveAdminPromotionJobs());
    expect(inBiz.find((j) => j.id === job.id)).toBeUndefined();
  });

  it("resumes only a paused job, and only once its account is connected; cancel ends it", async () => {
    current = sessions.manager;
    const job = await rawPrisma.groupAdminPromotionJob.findFirstOrThrow({ where: { accountId: ids.account, phoneNumber: INTERNATIONAL } });
    expect((await inIsp(() => actions.resumeGroupAdminPromotion(job.id))).error).toMatch(/Only a paused job/);
    await rawPrisma.groupAdminPromotionJob.update({ where: { id: job.id }, data: { status: "PAUSED_DISCONNECTED", adminGroups: 2 } });
    await rawPrisma.whatsAppAccount.update({ where: { id: ids.account }, data: { status: "DISCONNECTED" } });
    expect((await inIsp(() => actions.resumeGroupAdminPromotion(job.id))).error).toMatch(/still not connected/);
    await rawPrisma.whatsAppAccount.update({ where: { id: ids.account }, data: { status: "CONNECTED" } });
    expect(await inIsp(() => actions.resumeGroupAdminPromotion(job.id))).toEqual({ success: "Resumed." });
    expect((await rawPrisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("RUNNING");
    expect(await inIsp(() => actions.cancelGroupAdminPromotion(job.id))).toEqual({ success: "Cancelled." });
    expect((await rawPrisma.groupAdminPromotionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    // Once it is over, the same number may be started again.
    const again = await inIsp(() => actions.startGroupAdminPromotion({ accountId: ids.account, phoneNumber: LOCAL }));
    expect(again.existing).toBe(false);
    expect(again.jobId).not.toBe(job.id);
  });
});
