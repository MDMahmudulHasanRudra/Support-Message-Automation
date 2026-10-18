import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import type { ActiveProject } from "@/server/projectContext";

/**
 * The WhatsApp Accounts and Groups actions that could silently do the opposite of what an operator
 * meant (WhatsApp module audit, 18 Oct 2026):
 *
 * - Making a number Primary decides which number answers customers — only the Primary does. A
 *   disconnected spare could be made Primary, which stopped every customer reply in the project.
 * - A project's first number was not Primary until the worker next restarted.
 * - Delete always told the server the operator had seen the history it destroys, even while the
 *   figures were still loading or had failed to load — so the server's own check never held.
 * - Reconnect on a number that reads CONNECTED was skipped by the worker as a stale command, so the
 *   button (and every alert telling somebody to press it) did nothing.
 * - The group switches flipped whatever the row held, so a stale tab or a second operator turned the
 *   opposite of what was on screen — "Exit test mode" could switch test mode ON.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let project: ActiveProject;
const ids = { user: "", role: "" };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/acct-${tag}${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const accounts = await import("@/server/actions/accounts");
const groups = await import("@/server/actions/groups");
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project, fn);

async function account(label: string, status: "CONNECTED" | "DISCONNECTED", isPrimary = false) {
  return rawPrisma.whatsAppAccount.create({ data: { projectId: project.id, label: `${label} ${tag}`, status, isPrimary } });
}

beforeAll(async () => {
  const keys = ["whatsapp.view", "whatsapp.manage"];
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `Accounts ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.role = role.id;
  const user = await rawPrisma.user.create({ data: { username: `acct_${tag}`, email: `acct_${tag}@example.test`, name: "Accounts", passwordHash: "x", permissionModuleId: role.id } });
  ids.user = user.id;
  const created = await createProjectWithDefaults({ name: `Accounts ${tag}`, slug: `acct-${tag}`, status: "ACTIVE", creatorUserId: user.id }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Accounts ${tag}`, status: "ACTIVE" };
  await rawPrisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    create: { projectId: project.id, userId: user.id },
    update: {},
  });
  current = { userId: user.id, username: user.username, email: user.email!, name: "Accounts" } as Session;
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: ids.role } });
  await rawPrisma.$disconnect();
});

describe("the first number in a project", () => {
  it("is Primary from the moment it is added, and the second is not", async () => {
    const form = (label: string) => {
      const data = new FormData();
      data.set("label", `${label} ${tag}`);
      return data;
    };
    expect(await inProject(() => accounts.addWhatsAppAccount(form("First")))).toEqual({});
    expect(await inProject(() => accounts.addWhatsAppAccount(form("Second")))).toEqual({});

    const rows = await rawPrisma.whatsAppAccount.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.isPrimary)).toEqual([true, false]);
    await rawPrisma.whatsAppAccount.deleteMany({ where: { projectId: project.id } });
  });
});

describe("Primary decides which number answers customers", () => {
  it("refuses to make a number Primary while it is not connected, and keeps the current Primary", async () => {
    const serving = await account("Serving", "CONNECTED", true);
    const spare = await account("Spare", "DISCONNECTED");

    const result = await inProject(() => accounts.setPrimaryAccount(spare.id));

    expect(result?.error).toMatch(/not connected/i);
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: serving.id } })).isPrimary).toBe(true);
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: spare.id } })).isPrimary).toBe(false);
  });

  it("moves Primary to a connected number", async () => {
    const current = await rawPrisma.whatsAppAccount.findFirstOrThrow({ where: { projectId: project.id, isPrimary: true } });
    const next = await account("Next", "CONNECTED");

    expect(await inProject(() => accounts.setPrimaryAccount(next.id))).toEqual({});
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: next.id } })).isPrimary).toBe(true);
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: current.id } })).isPrimary).toBe(false);
  });
});

describe("Delete destroys history only after the operator was shown it", () => {
  it("refuses a bare 'yes' — the confirmation must carry the figures that were shown", async () => {
    const doomed = await account("Doomed", "DISCONNECTED");
    await rawPrisma.whatsAppGroup.create({
      data: { projectId: project.id, accountId: doomed.id, whatsappGroupId: `${tag}-doomed@g.us`, name: "Doomed group" },
    });

    // What the dialog used to send whatever it had shown, including "Checking…" or a failed read.
    const bare = await inProject(() => accounts.deleteWhatsAppAccount(doomed.id, true as never));
    expect(bare.error).toBeTruthy();
    expect(bare.impact?.groups).toBe(1);
    expect(await rawPrisma.whatsAppAccount.count({ where: { id: doomed.id } })).toBe(1);

    const nothingShown = await inProject(() => accounts.deleteWhatsAppAccount(doomed.id, null));
    expect(nothingShown.error).toBeTruthy();
    expect(await rawPrisma.whatsAppAccount.count({ where: { id: doomed.id } })).toBe(1);

    const shown = await inProject(() => accounts.getAccountDeletionImpact(doomed.id));
    const deleted = await inProject(() => accounts.deleteWhatsAppAccount(doomed.id, shown));
    expect(deleted.error).toBeUndefined();
    expect(await rawPrisma.whatsAppAccount.count({ where: { id: doomed.id } })).toBe(0);
  });
});

describe("Reconnect pressed by a person", () => {
  it("asks the worker to restart the session even if it reads CONNECTED", async () => {
    const live = await account("Live", "CONNECTED");
    await inProject(() => accounts.requestReconnect(live.id));
    const command = await rawPrisma.workerCommand.findFirstOrThrow({ where: { accountId: live.id, type: "RECONNECT" } });
    expect(command.payload).toMatchObject({ force: true });
  });
});

describe("group switches set the value the operator chose", () => {
  it("never flip: asking for the state a group is already in changes nothing", async () => {
    const owner = await account("Groups", "CONNECTED");
    const group = await rawPrisma.whatsAppGroup.create({
      data: { projectId: project.id, accountId: owner.id, whatsappGroupId: `${tag}-g@g.us`, name: "Customer group", isMonitored: true },
    });
    const read = () => rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });

    // A stale tab still showing "Exit test mode" on a group a colleague already took out of test mode.
    expect(await inProject(() => groups.setGroupTestMode(group.id, false))).toEqual({ changed: false });
    expect((await read()).testModeEnabled).toBe(false);

    // A stale "Start monitoring" on a group that is already monitored.
    expect(await inProject(() => groups.setGroupMonitoring(group.id, true))).toEqual({ changed: false });
    expect((await read()).isMonitored).toBe(true);

    expect(await inProject(() => groups.setGroupAiExcluded(group.id, true))).toEqual({ changed: true });
    expect(await inProject(() => groups.setGroupAiExcluded(group.id, true))).toEqual({ changed: false });
    expect((await read()).aiAutomationExcluded).toBe(true);

    expect(await inProject(() => groups.setGroupAiAutomation(group.id, true))).toEqual({ changed: true });
    expect((await read()).aiAutomationEnabled).toBe(true);
  });

  it("says so when the group is gone, instead of crashing the page", async () => {
    expect((await inProject(() => groups.setGroupTestMode(`missing-${tag}`, true))).error).toMatch(/no longer exists/i);
  });
});
