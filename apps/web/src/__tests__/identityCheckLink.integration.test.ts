import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP11 on the isolated database: fixing an unknown sender from Team Members -> Identity
 * check. The Link goes through `linkWhatsAppSender`, the action WhatsApp Chat uses, so this proves the one
 * path keeps its rules (permission, duplicate-holder refusal, System Log, re-attribution, no number invented
 * from a private ID) and that the name suggestion is display only. Synthetic names and ids only; the Bengali
 * name is made up.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `ic-${tag}-${name}`;
const LID_RINA = "100000000021";
const LID_MOU = "100000000022";
const LID_TWIN = "100000000023";
const LID_STRANGER = "100000000024"; // held by "Holder Test" on the roster, seen in no message
const LID_UNKNOWN = "100000000028"; // a sender nobody on the roster resembles
const G = ["120000000000000021@g.us", "120000000000000022@g.us", "120000000000000023@g.us"];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/authorize")>();
  const { hasPermission } = await import("@/server/permissions");
  return {
    ...actual,
    requireAccess: async () => current,
    checkPermission: async (key: Parameters<typeof hasPermission>[1]) =>
      (await hasPermission(current, key)) ? { session: current } : { denied: "You do not have permission to perform this action." },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { getRosterIdentityHealth } = await import("@/server/rosterIdentityHealth");
const { linkWhatsAppSender } = await import("@/server/actions/teamMembers");
const { previewTeamMemberIdentityChange } = await import("@/server/actions/identityPreview");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
const projects: { main: Proj; other: Proj } = { main: { id: "", slug: "", name: "", status: "ACTIVE" }, other: { id: "", slug: "", name: "", status: "ACTIVE" } };
const users = { manager: null as unknown as Session, viewer: null as unknown as Session };
const moduleIds: string[] = [];
const userIds: string[] = [];
const inMain = <T,>(fn: () => Promise<T>) => runWithProject(projects.main, fn);
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

let seq = 0;
async function say(project: Proj, o: { sender: string; name: string; group: number; at: Date; jid?: string }) {
  seq += 1;
  const key = project === projects.main ? "main" : "other";
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: id(`${key}-A`),
      groupId: id(`${key}-g${o.group}`),
      chatId: G[o.group]!,
      whatsappMessageId: `false_${G[o.group]}_${seq}_${tag}`,
      senderPhone: o.sender,
      senderJid: o.jid ?? `${o.sender}@lid`,
      senderName: o.name,
      direction: "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: o.at,
      processingStatus: "PROCESSED",
    },
  });
}

async function seedUser(name: string, keys: string[]): Promise<Session> {
  const permissions = await Promise.all(keys.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })));
  const role = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  moduleIds.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: role.id } });
  userIds.push(u.id);
  await rawPrisma.projectAccess.create({ data: { projectId: projects.main.id, userId: u.id } });
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

beforeAll(async () => {
  const creator = await rawPrisma.user.create({ data: { username: `ic_${tag}`, email: `ic_${tag}@example.test`, name: "IC", passwordHash: "x" } });
  userIds.push(creator.id);
  for (const key of ["main", "other"] as const) {
    const created = await createProjectWithDefaults({ name: `IC ${key} ${tag}`, slug: `ic-${key}-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma);
    projects[key] = { id: created.id, slug: created.slug, name: `IC ${key} ${tag}`, status: "ACTIVE" };
    const pid = { projectId: created.id };
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-A`), label: `${key} A`, status: "CONNECTED", isPrimary: true } });
    for (let i = 0; i < G.length; i++) {
      await rawPrisma.whatsAppGroup.create({ data: { ...pid, id: id(`${key}-g${i}`), accountId: id(`${key}-A`), whatsappGroupId: G[i]!, name: `${key} group ${i}`, isMonitored: true, isActive: true } });
    }
  }
  users.manager = await seedUser("manager", ["whatsapp.manage", "whatsapp.view"]);
  users.viewer = await seedUser("viewer", ["whatsapp.view"]);
  current = users.manager;

  const pid = { projectId: projects.main.id };
  const member = (name: string, label: string, phone: string, extra: Record<string, unknown> = {}) =>
    rawPrisma.internalTeamMember.create({ data: { ...pid, id: id(name), name: label, phoneNumber: `+${phone}`, role: "Support", ...extra } as never });
  await member("rina", "Rina Akter", "8801000000021"); // no WhatsApp ID: the missing half of LID_RINA
  await member("mou", "মৌসুমী আক্তার", "8801000000022"); // Bengali name, no WhatsApp ID
  await member("twinA", "Babul Hossain", "8801000000023");
  await member("twinB", "Babul Hossain", "8801000000025");
  await member("holder", "Holder Test", "8801000000026", { whatsappId: LID_STRANGER });
  await member("former", "Former Test", "8801000000027", { status: "INACTIVE" });

  // Three unknown senders, each in three groups (the check's own threshold), with display names.
  for (let g = 0; g < 3; g++) {
    await say(projects.main, { sender: LID_RINA, name: "Rina Akter SoftifyBD", group: g, at: hoursAgo(5 + g) });
    await say(projects.main, { sender: LID_MOU, name: "মৌসুমী আক্তার", group: g, at: hoursAgo(5 + g) });
    await say(projects.main, { sender: LID_TWIN, name: "Babul Hossain", group: g, at: hoursAgo(5 + g) });
    await say(projects.main, { sender: LID_UNKNOWN, name: "Stranger Test", group: g, at: hoursAgo(5 + g) });
  }
  // Another project: a sender whose name matches nobody HERE, and whose id is not seen here.
  for (let g = 0; g < 3; g++) await say(projects.other, { sender: "100000000099", name: "Rina Akter", group: g, at: hoursAgo(5) });
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: projects.main.id, key: "UNIFIED_REPORTING" } },
    create: { projectId: projects.main.id, key: "UNIFIED_REPORTING", enabled: true },
    update: { enabled: true },
  });
  forgetProjectFeatureStates();
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (const project of [projects.main, projects.other]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
    }
    await rawPrisma.projectAccess.deleteMany({ where: { projectId: project.id } });
    await rawPrisma.project.deleteMany({ where: { id: project.id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: moduleIds } } });
  await rawPrisma.$disconnect();
});

const health = () => inMain(() => getRosterIdentityHealth());
const senderRow = async (sender: string) => (await health()).unknownFrequentSenders.find((s) => s.sender === sender);
const counts = async () => ({
  reattributions: await rawPrisma.identityReattribution.count({ where: { projectId: projects.main.id } }),
  logs: await rawPrisma.systemLog.count({ where: { projectId: projects.main.id, scope: "team-members" } }),
  members: JSON.stringify(await rawPrisma.internalTeamMember.findMany({ where: { projectId: projects.main.id }, orderBy: { id: "asc" }, select: { id: true, phoneNumber: true, whatsappId: true } })),
});

describe("name suggestions on the Identity check", () => {
  it("names the one member whose name matches (an extra word, and a Bengali name)", async () => {
    expect((await senderRow(LID_RINA))?.suggestion).toEqual({ kind: "ONE", members: [{ id: id("rina"), name: "Rina Akter", linkable: true }] });
    expect((await senderRow(LID_MOU))?.suggestion).toEqual({ kind: "ONE", members: [{ id: id("mou"), name: "মৌসুমী আক্তার", linkable: true }] });
  });

  it("two members with the same name is 'several', never the first one", async () => {
    const suggestion = (await senderRow(LID_TWIN))?.suggestion;
    expect(suggestion?.kind).toBe("SEVERAL");
    expect(suggestion?.members.map((m) => m.id).sort()).toEqual([id("twinA"), id("twinB")].sort());
  });

  it("a sender nobody resembles has no suggestion, and an inactive member is never offered", async () => {
    expect((await senderRow(LID_UNKNOWN))?.suggestion).toBeNull();
    const h = await health();
    expect(h.linkableMembers.map((m) => m.id)).not.toContain(id("former"));
    // Holder already has a real WhatsApp ID of their own: Link would refuse them, so they are not offered.
    expect(h.linkableMembers.map((m) => m.id)).not.toContain(id("holder"));
    expect(h.linkableMembers.map((m) => m.id)).toEqual(expect.arrayContaining([id("rina"), id("mou"), id("twinA"), id("twinB")]));
  });

  it("another project's senders and names never appear", async () => {
    const h = await health();
    expect(h.unknownFrequentSenders.some((s) => s.sender === "100000000099")).toBe(false);
  });

  it("showing a suggestion writes nothing", async () => {
    const before = await counts();
    await health();
    expect(await counts()).toEqual(before);
  });
});

describe("Link goes through the one server path", () => {
  it("is refused without whatsapp.manage, and nothing changes", async () => {
    current = users.viewer;
    const before = await counts();
    const res = await inMain(() => linkWhatsAppSender(LID_RINA, {}, form({ memberId: id("rina") })));
    expect(res.error).toBeTruthy();
    expect(res.linked).toBeUndefined();
    expect(await counts()).toEqual(before);
    current = users.manager;
  });

  it("the impact preview is read-only and says what linking adds to the chosen member", async () => {
    const before = await counts();
    const res = await inMain(() => previewTeamMemberIdentityChange({ memberId: id("rina"), proposed: null, linkSenderId: `${LID_RINA}@lid` }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.preview.byMember.find((m) => m.memberId === id("rina"))).toMatchObject({ gained: 3, lost: 0 });
    expect(res.preview.affected.groups).toBe(3);
    expect(await counts()).toEqual(before);
  });

  it("stores the WhatsApp ID on the chosen member, logs it, queues the re-attribution, and invents no phone number", async () => {
    const before = await counts();
    const res = await inMain(() => linkWhatsAppSender(LID_RINA, {}, form({ memberId: id("rina") })));
    expect(res).toEqual({ linked: "Rina Akter" });
    const rina = await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: id("rina") } });
    expect(rina.whatsappId).toBe(LID_RINA);
    expect(rina.phoneNumber).toBe("+8801000000021"); // the typed number is untouched: a LID is never a phone number
    const logs = await rawPrisma.systemLog.findMany({ where: { projectId: projects.main.id, scope: "team-members", targetId: id("rina") } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorUserId).toBe(users.manager.userId);
    const queued = await rawPrisma.identityReattribution.findMany({ where: { projectId: projects.main.id, memberIds: { has: id("rina") } } });
    expect(queued).toHaveLength(1);
    expect((await counts()).reattributions).toBe(before.reattributions + 1);
    // Linked: the sender is no longer unknown.
    expect(await senderRow(LID_RINA)).toBeUndefined();
  });

  it("refuses a WhatsApp ID another member already holds, naming them, and changes nothing", async () => {
    const before = await counts();
    const res = await inMain(() => linkWhatsAppSender(LID_STRANGER, {}, form({ memberId: id("twinA") })));
    expect(res.error).toContain("Holder Test");
    expect(res.linked).toBeUndefined();
    expect(await counts()).toEqual(before);
  });

  it("refuses a member who already has a different WhatsApp ID, pointing at their edit page", async () => {
    const before = await counts();
    const res = await inMain(() => linkWhatsAppSender(LID_MOU, {}, form({ memberId: id("holder") })));
    expect(res.error).toContain("edit page");
    expect(await counts()).toEqual(before);
  });
});
