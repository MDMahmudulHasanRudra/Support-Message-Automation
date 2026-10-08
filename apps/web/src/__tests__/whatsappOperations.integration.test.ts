import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * WhatsApp Operations — the job indicator shown on every page, and the duplicate guard on Add Number
 * to Groups. Called as the browser calls them, with only the request plumbing stubbed. What they must
 * guarantee: a project sees its own jobs and nobody else's, a person without Bulk Messaging sees
 * nothing, a dropped account reads as a wait, and the same (number, group) pair is never in two
 * unfinished jobs however fast the button is pressed.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { manager: "", outsider: "", roles: [] as string[], account: "", offline: "", bizAccount: "", biz: "", groups: [] as string[] };
const jobs = { running: "", waiting: "", done: "", old: "", admin: "", bizAdd: "" };
const sessions = {} as Record<"manager" | "outsider", Session>;

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const reader = await import("@/server/whatsappOperations");
const action = await import("@/server/actions/whatsappOperations");
const adds = await import("@/server/actions/groupParticipantAdd");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const NUMBER = digits();

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

const ADD_DEFAULTS = { delayMinMs: 0, delayMaxMs: 0, maxPerMinute: 3, maxPerJob: 500, retryMaxAttempts: 2 };

async function addJob(projectId: string, accountId: string, groupId: string, status: string, items: string[], extra: Record<string, unknown> = {}) {
  const job = await rawPrisma.groupParticipantAddJob.create({
    data: { projectId, accountId, phoneNumbers: [NUMBER], status: status as never, queuedCount: items.length, ...ADD_DEFAULTS, ...extra },
  });
  for (const [i, itemStatus] of items.entries()) {
    const group = await rawPrisma.whatsAppGroup.create({
      data: { projectId, accountId, whatsappGroupId: `wo-${tag}-${job.id}-${i}@g.us`, name: `WO ${i}`, isActive: true },
    });
    await rawPrisma.groupParticipantAddItem.create({
      data: { projectId, jobId: job.id, groupId: i === 0 ? groupId : group.id, groupNameSnapshot: i === 0 ? "WO Shared" : `WO ${i}`, phoneNumber: NUMBER, status: itemStatus as never, scheduledAt: new Date(Date.now() + i * 10_000) },
    });
  }
  return job.id;
}

beforeAll(async () => {
  const m = await user("wo_mgr", await role("WO manage", ["bulk_messaging.view", "bulk_messaging.manage"]));
  const o = await user("wo_out", await role("WO outsider", ["messages.view"]));
  ids.manager = m.id;
  ids.outsider = o.id;
  sessions.manager = m.session;
  sessions.outsider = o.session;

  const pid = { projectId: ORIGINAL_PROJECT_ID };
  ids.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `WO ${tag}`, status: "CONNECTED" } })).id;
  ids.offline = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `WO offline ${tag}`, status: "DISCONNECTED" } })).id;
  for (let i = 0; i < 3; i++) {
    ids.groups.push((await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.account, whatsappGroupId: `wog-${tag}-${i}@g.us`, name: `WO group ${i}`, isActive: true } })).id);
  }
  const offlineGroup = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.offline, whatsappGroupId: `woo-${tag}@g.us`, name: "WO offline group", isActive: true } });

  // Running: two added, one in flight, two still to come.
  jobs.running = await addJob(ORIGINAL_PROJECT_ID, ids.account, ids.groups[0]!, "RUNNING", ["PROCESSING", "ADDED", "ADDED", "PENDING", "PENDING"]);
  jobs.waiting = await addJob(ORIGINAL_PROJECT_ID, ids.offline, offlineGroup.id, "RUNNING", ["PENDING", "ADDED"]);
  jobs.done = await addJob(ORIGINAL_PROJECT_ID, ids.account, ids.groups[2]!, "COMPLETED", ["ADDED", "FAILED"], { completedAt: new Date(Date.now() - 3_600_000) });
  jobs.old = await addJob(ORIGINAL_PROJECT_ID, ids.account, ids.groups[2]!, "COMPLETED", ["ADDED"], { completedAt: new Date(Date.now() - 20 * 3_600_000) });
  const admin = await rawPrisma.groupAdminPromotionJob.create({ data: { ...pid, accountId: ids.account, phoneNumber: NUMBER, status: "RUNNING", totalGroups: 3, adminGroups: 2 } });
  jobs.admin = admin.id;
  for (const [i, status] of ["PROMOTED", "PENDING", "NOT_ACCOUNT_ADMIN"].entries()) {
    await rawPrisma.groupAdminPromotionItem.create({ data: { ...pid, jobId: admin.id, groupId: ids.groups[i]!, groupNameSnapshot: `WO group ${i}`, status: status as never } });
  }

  // Bizify: its own running jobs, which ISP Digital must never see.
  const biz = await createProjectWithDefaults({ name: `WO Biz ${tag}`, slug: `wo-biz-${tag}`, status: "ACTIVE", creatorUserId: m.id }, rawPrisma);
  ids.biz = biz.id;
  ids.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `WO Biz ${tag}`, status: "CONNECTED" } })).id;
  const bizGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: ids.bizAccount, whatsappGroupId: `wob-${tag}@g.us`, name: "WO Biz group", isActive: true } });
  jobs.bizAdd = await addJob(biz.id, ids.bizAccount, bizGroup.id, "RUNNING", ["PENDING"]);
});

afterAll(async () => {
  const accounts = [ids.account, ids.offline, ids.bizAccount];
  await rawPrisma.groupAdminPromotionJob.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.groupParticipantAddJob.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: [ids.manager, ids.outsider] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [ids.manager, ids.outsider] } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

const mine = <T extends { id: string }>(ops: T[]) => ops.filter((o) => Object.values(jobs).includes(o.id));

describe("the job indicator's reading", () => {
  it("every running job of both kinds, then those finished recently — never one finished long ago", async () => {
    const ops = mine(await inIsp(() => reader.listWhatsAppOperations()));
    expect(ops.map((o) => o.id).sort()).toEqual([jobs.running, jobs.waiting, jobs.done, jobs.admin].sort());
    // Active ones before finished ones.
    expect(ops.at(-1)!.id).toBe(jobs.done);
  });

  it("a running add: adds done of adds queued, and the pair in flight", async () => {
    const op = mine(await inIsp(() => reader.listWhatsAppOperations())).find((o) => o.id === jobs.running)!;
    expect(op).toMatchObject({ kind: "ADD_NUMBER_TO_GROUPS", state: "RUNNING", processed: 2, total: 5, target: `+${NUMBER}`, href: `/group-member-adder/jobs/${jobs.running}` });
    expect(op.current).toBe(`Adding +${NUMBER} → WO Shared`);
  });

  it("an add whose account is disconnected reads as a wait, not a failure", async () => {
    const op = mine(await inIsp(() => reader.listWhatsAppOperations())).find((o) => o.id === jobs.waiting)!;
    expect(op.state).toBe("WAITING_ACCOUNT");
    expect(op.detail).toContain("carries on from 1 / 2");
  });

  it("the Admin Maker job: groups checked of all groups", async () => {
    const op = mine(await inIsp(() => reader.listWhatsAppOperations())).find((o) => o.id === jobs.admin)!;
    expect(op).toMatchObject({ kind: "ADMIN_MAKER", state: "RUNNING", processed: 2, total: 3 });
  });

  it("a finished job stays readable, with its result", async () => {
    const op = mine(await inIsp(() => reader.listWhatsAppOperations())).find((o) => o.id === jobs.done)!;
    expect(op.state).toBe("PARTIAL");
    expect(op.counts.find((c) => c.label === "Failed")!.value).toBe(1);
  });

  it("one kind only, for a module page", async () => {
    const ops = mine(await inIsp(() => reader.listWhatsAppOperations({ kind: "ADMIN_MAKER" })));
    expect(ops.map((o) => o.id)).toEqual([jobs.admin]);
  });
});

describe("isolation and permission", () => {
  it("ISP Digital never sees Bizify's jobs, and Bizify sees only its own", async () => {
    expect((await inIsp(() => reader.listWhatsAppOperations())).some((o) => o.id === jobs.bizAdd)).toBe(false);
    const bizOps = await runWithProject({ id: ids.biz, slug: `wo-biz-${tag}`, name: "WO Biz", status: "ACTIVE" }, () => reader.listWhatsAppOperations());
    expect(bizOps.map((o) => o.id)).toEqual([jobs.bizAdd]);
  });

  it("the polled reader shows nothing to somebody without Bulk Messaging — no redirect, no error", async () => {
    current = sessions.outsider;
    expect(await inIsp(() => action.readWhatsAppOperations())).toEqual([]);
    current = sessions.manager;
    expect(mine(await inIsp(() => action.readWhatsAppOperations())).length).toBe(4);
  });

  it("an unknown kind is ignored rather than trusted", async () => {
    current = sessions.manager;
    expect(mine(await inIsp(() => action.readWhatsAppOperations("SOMETHING" as never))).length).toBe(4);
  });
});

describe("Add Number to Groups never runs the same pair twice", () => {
  const target = (i: number) => ({ groupId: ids.groups[i]!, groupName: `WO group ${i}` });

  it("a pair already in an unfinished job opens that job instead of starting another", async () => {
    current = sessions.manager;
    // The running job holds NUMBER × group 0.
    const before = await rawPrisma.groupParticipantAddJob.count({ where: { accountId: ids.account } });
    const r = await inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [`+${NUMBER}`], targets: [target(0), target(1)] }));
    expect(r.existingJobId).toBe(jobs.running);
    expect(r.jobId).toBeUndefined();
    expect(await rawPrisma.groupParticipantAddJob.count({ where: { accountId: ids.account } })).toBe(before);
  });

  it("a finished job holds nothing: the same pair may run again", async () => {
    current = sessions.manager;
    // The completed job held NUMBER × group 2.
    const r = await inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [NUMBER], targets: [target(2)] }));
    expect(r.error).toBeUndefined();
    expect(r.jobId).toBeTruthy();
    await rawPrisma.groupParticipantAddJob.update({ where: { id: r.jobId! }, data: { status: "CANCELLED" } });
  });

  it("a job cancelled during review holds nothing either, though its pairs still read READY", async () => {
    current = sessions.manager;
    const number = digits();
    const cancelled = await rawPrisma.groupParticipantAddJob.create({
      data: { projectId: ORIGINAL_PROJECT_ID, accountId: ids.account, phoneNumbers: [number], status: "CANCELLED", ...ADD_DEFAULTS },
    });
    await rawPrisma.groupParticipantAddItem.create({
      data: { projectId: ORIGINAL_PROJECT_ID, jobId: cancelled.id, groupId: ids.groups[1]!, groupNameSnapshot: "WO group 1", phoneNumber: number, status: "READY" },
    });
    const r = await inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [number], targets: [target(1)] }));
    expect(r.existingJobId).toBeUndefined();
    expect(r.jobId).toBeTruthy();
  });

  it("a pair an unfinished job has already settled does not block either", async () => {
    current = sessions.manager;
    const number = digits();
    const running = await rawPrisma.groupParticipantAddJob.create({
      data: { projectId: ORIGINAL_PROJECT_ID, accountId: ids.account, phoneNumbers: [number], status: "RUNNING", ...ADD_DEFAULTS },
    });
    await rawPrisma.groupParticipantAddItem.create({
      data: { projectId: ORIGINAL_PROJECT_ID, jobId: running.id, groupId: ids.groups[2]!, groupNameSnapshot: "WO group 2", phoneNumber: number, status: "ADDED" },
    });
    const r = await inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [number], targets: [target(2)] }));
    expect(r.existingJobId).toBeUndefined();
    expect(r.jobId).toBeTruthy();
    await rawPrisma.groupParticipantAddJob.updateMany({ where: { id: { in: [running.id, r.jobId!] } }, data: { status: "CANCELLED" } });
  });

  it("three presses at the same instant make one job", async () => {
    current = sessions.manager;
    const other = digits();
    const results = await Promise.all([1, 2, 3].map(() => inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [other], targets: [target(1)] }))));
    const created = results.filter((r) => r.jobId);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.existingJobId === created[0]!.jobId)).toHaveLength(2);
    expect(await rawPrisma.groupParticipantAddJob.count({ where: { accountId: ids.account, phoneNumbers: { has: other } } })).toBe(1);
  });

  it("decides under a lock: a start waits for anyone else deciding the same account", async () => {
    current = sessions.manager;
    let released = false;
    const holder = rawPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-participant-add:${ids.account}`})::bigint)`;
        await new Promise((r) => setTimeout(r, 1500));
        released = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    const r = await inIsp(() => adds.createGroupParticipantAddJob({ accountId: ids.account, phoneNumbers: [digits()], targets: [target(1)] }));
    expect(released).toBe(true);
    expect(r.jobId).toBeTruthy();
    await holder;
  });
});

describe("Clear / Hide — one person's tracker, never the job", () => {
  const extra = { review: "", colleague: "" };
  let colleague: Session;

  beforeAll(async () => {
    extra.review = await addJob(ORIGINAL_PROJECT_ID, ids.account, ids.groups[1]!, "AWAITING_REVIEW", ["READY", "ALREADY_MEMBER"]);
    const c = await user("wo_col", ids.roles[0]!);
    extra.colleague = c.id;
    colleague = c.session;
  });

  afterAll(async () => {
    await rawPrisma.groupParticipantAddJob.deleteMany({ where: { id: extra.review } });
    await rawPrisma.projectAccess.deleteMany({ where: { userId: extra.colleague } });
    await rawPrisma.user.deleteMany({ where: { id: extra.colleague } });
  });

  const visibleTo = async (session: Session) => {
    current = session;
    return (await inIsp(() => action.readWhatsAppOperations())).map((o) => o.id);
  };

  it("clearing a job ready for review removes it for that person only, and leaves the job and its review intact", async () => {
    expect(await visibleTo(sessions.manager)).toContain(extra.review);
    current = sessions.manager;
    expect(await inIsp(() => action.clearWhatsAppOperation("ADD_NUMBER_TO_GROUPS", extra.review))).toEqual({ action: "Clear" });
    expect(await visibleTo(sessions.manager)).not.toContain(extra.review);
    // The module page's server-rendered list uses the same per-viewer filter.
    expect((await inIsp(() => reader.listWhatsAppOperations({ kind: "ADD_NUMBER_TO_GROUPS", viewerId: ids.manager }))).map((o) => o.id)).not.toContain(extra.review);
    // A colleague still sees it.
    expect(await visibleTo(colleague)).toContain(extra.review);
    // Nothing about the job changed: still awaiting review, every item still there.
    const job = await rawPrisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: extra.review }, include: { items: true } });
    expect(job.status).toBe("AWAITING_REVIEW");
    expect(job.items.map((i) => i.status).sort()).toEqual(["ALREADY_MEMBER", "READY"]);
  });

  it("it shows again once the job moves on — a continued review is news", async () => {
    await rawPrisma.groupParticipantAddJob.update({ where: { id: extra.review }, data: { status: "RUNNING" } });
    expect(await visibleTo(sessions.manager)).toContain(extra.review);
    await rawPrisma.groupParticipantAddJob.update({ where: { id: extra.review }, data: { status: "AWAITING_REVIEW" } });
  });

  it("hiding a running job is only hiding: it is called Hide and the job keeps running", async () => {
    current = sessions.manager;
    expect(await inIsp(() => action.clearWhatsAppOperation("ADD_NUMBER_TO_GROUPS", jobs.running))).toEqual({ action: "Hide" });
    expect(await visibleTo(sessions.manager)).not.toContain(jobs.running);
    const job = await rawPrisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: jobs.running } });
    expect(job.status).toBe("RUNNING");
    expect(job.cancelledAt).toBeNull();
  });

  it("restore puts it back", async () => {
    current = sessions.manager;
    await inIsp(() => action.restoreWhatsAppOperation("ADD_NUMBER_TO_GROUPS", jobs.running));
    expect(await visibleTo(sessions.manager)).toContain(jobs.running);
  });

  it("a finished job can be cleared; its result stays", async () => {
    current = sessions.manager;
    expect(await inIsp(() => action.clearWhatsAppOperation("ADD_NUMBER_TO_GROUPS", jobs.done))).toEqual({ action: "Clear" });
    expect(await visibleTo(sessions.manager)).not.toContain(jobs.done);
    expect(await rawPrisma.groupParticipantAddItem.count({ where: { jobId: jobs.done } })).toBe(2);
  });

  it("another project's job, an unknown kind and a role without Bulk Messaging are refused", async () => {
    current = sessions.manager;
    expect((await inIsp(() => action.clearWhatsAppOperation("ADD_NUMBER_TO_GROUPS", jobs.bizAdd))).error).toBeTruthy();
    expect((await inIsp(() => action.clearWhatsAppOperation("SOMETHING", jobs.running))).error).toBeTruthy();
    current = sessions.outsider;
    expect((await inIsp(() => action.clearWhatsAppOperation("ADD_NUMBER_TO_GROUPS", jobs.running))).error).toBeTruthy();
    expect(await rawPrisma.whatsAppOperationDismissal.count({ where: { jobId: jobs.bizAdd } })).toBe(0);
  });
});
