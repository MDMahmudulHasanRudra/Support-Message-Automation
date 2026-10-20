import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP8: the read-only identity-change preview on the isolated database. Synthetic data
 * only. Two projects hold the same identifiers, so a preview that crosses the project boundary fails here.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `ip-${tag}-${name}`;
const SECRET = "SECRETBODY";
const LID = "100000000001";
const RINA_PHONE = "8801000000001";
const G1 = "120000000000000001@g.us";
const G2 = "120000000000000002@g.us";
const PERSONAL_CHAT = `${LID}@lid`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
// The real gate, evaluated for whoever `current` is: the tests below prove a refusal, not just an allow.
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
const { previewTeamMemberIdentityChange } = await import("@/server/actions/identityPreview");
const { loadIdentityPreviewInput, previewDigest, previewWindow } = await import("@/server/identityPreview");
const teamMemberActions = await import("@/server/actions/teamMembers");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
const projects: { isp: Proj; other: Proj } = { isp: { id: "", slug: "", name: "", status: "ACTIVE" }, other: { id: "", slug: "", name: "", status: "ACTIVE" } };
const users = { full: null as unknown as Session, noPersonal: null as unknown as Session, noManage: null as unknown as Session, noReports: null as unknown as Session };
const moduleIds: string[] = [];
const userIds: string[] = [];
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(projects.isp, fn);

let seq = 0;
async function msg(
  project: Proj,
  o: { account: string; chat: string; group?: string | null; at: Date; sender: string; jid?: string | null; key?: string; out?: boolean },
) {
  seq += 1;
  const key = o.key ?? `K${seq}`;
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: o.account,
      groupId: o.group ?? null,
      chatId: o.chat,
      whatsappMessageId: `${o.out ? "true" : "false"}_${o.chat}_${key}_${tag}`,
      senderPhone: o.sender,
      senderJid: o.jid === undefined ? `${o.sender}@lid` : o.jid,
      direction: o.out ? "OUTGOING" : "INCOMING",
      body: SECRET,
      normalizedBody: SECRET,
      timestampWa: o.at,
      processingStatus: "PROCESSED",
    },
  });
}

async function seedPermissionUser(name: string, keys: string[]): Promise<Session> {
  const permissions = await Promise.all(
    keys.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  moduleIds.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: role.id } });
  userIds.push(u.id);
  await rawPrisma.projectAccess.create({ data: { projectId: projects.isp.id, userId: u.id } });
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

const setFlag = async (enabled: boolean) => {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: projects.isp.id, key: "UNIFIED_REPORTING" } },
    create: { projectId: projects.isp.id, key: "UNIFIED_REPORTING", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
};

beforeAll(async () => {
  const creator = await rawPrisma.user.create({ data: { username: `ip_${tag}`, email: `ip_${tag}@example.test`, name: "IP", passwordHash: "x" } });
  userIds.push(creator.id);
  for (const key of ["isp", "other"] as const) {
    const created = await createProjectWithDefaults({ name: `IP ${key} ${tag}`, slug: `ip-${key}-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma);
    projects[key] = { id: created.id, slug: created.slug, name: `IP ${key} ${tag}`, status: "ACTIVE" };
  }
  users.full = await seedPermissionUser("full", ["whatsapp.manage", "messages.view", "support_activity.view"]);
  users.noPersonal = await seedPermissionUser("nopersonal", ["whatsapp.manage", "support_activity.view"]);
  users.noReports = await seedPermissionUser("noreports", ["whatsapp.manage", "messages.view"]);
  users.noManage = await seedPermissionUser("nomanage", ["messages.view"]);
  current = users.full;

  for (const key of ["isp", "other"] as const) {
    const pid = { projectId: projects[key].id };
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-A`), label: `${key} A`, status: "CONNECTED", isPrimary: true, phoneNumber: "8801500000001" } });
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-B`), label: `${key} B`, status: "CONNECTED" } });
    for (const [n, g] of [["g1", G1], ["g2", G2]] as const) {
      await rawPrisma.whatsAppGroup.create({
        data: { ...pid, id: id(`${key}-${n}`), accountId: id(`${key}-A`), whatsappGroupId: g, name: `${key} ${n}`, isMonitored: true, isActive: true },
      });
    }
  }
  const pid = { projectId: projects.isp.id };
  // Rina is on the roster by phone only; her WhatsApp id (a LID) is not on file yet.
  await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id("rina"), name: "Rina", phoneNumber: `+${RINA_PHONE}`, role: "Support" } });
  await rawPrisma.internalTeamMember.create({ data: { ...pid, id: id("omar"), name: "Omar", phoneNumber: "+8801000000002", role: "Support" } });

  const A = id("isp-A");
  const B = id("isp-B");
  // One logical message in G1, stored by BOTH accounts, from the LID: two copies, one logical message.
  await msg(projects.isp, { account: A, chat: G1, group: id("isp-g1"), at: hoursAgo(5), sender: LID, key: "M1" });
  await msg(projects.isp, { account: B, chat: G1, group: id("isp-g1"), at: hoursAgo(5), sender: LID, key: "M1" });
  // A second message from the LID in G2, and a customer line in G1 (unchanged by the change).
  await msg(projects.isp, { account: A, chat: G2, group: id("isp-g2"), at: hoursAgo(4), sender: LID, key: "M2" });
  await msg(projects.isp, { account: A, chat: G1, group: id("isp-g1"), at: hoursAgo(3), sender: "100000000050", key: "M3" });
  // The LID writing to the business number in a personal chat.
  await msg(projects.isp, { account: A, chat: PERSONAL_CHAT, at: hoursAgo(2), sender: LID, key: "P1" });
  // Too old for the default window (92 days).
  await msg(projects.isp, { account: A, chat: G1, group: id("isp-g1"), at: hoursAgo(200 * 24), sender: LID, key: "OLD" });
  // The other project: the same LID in its own groups and personal chat.
  for (let i = 0; i < 4; i++) await msg(projects.other, { account: id("other-A"), chat: G1, group: id("other-g1"), at: hoursAgo(5 + i), sender: LID, key: `O${i}` });
  await msg(projects.other, { account: id("other-A"), chat: PERSONAL_CHAT, at: hoursAgo(2), sender: LID, key: "OP1" });
  await setFlag(true);
}, 180_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (const project of [projects.isp, projects.other]) {
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

const linkLid = { memberId: id("rina"), proposed: { phoneNumber: `+${RINA_PHONE}`, whatsappId: LID, attributeFrom: undefined } };
const preview = (req: Parameters<typeof previewTeamMemberIdentityChange>[0] = linkLid) => inIsp(() => previewTeamMemberIdentityChange(req));
const rowCounts = async () => ({
  messages: await rawPrisma.message.count({ where: { projectId: projects.isp.id } }),
  reattributions: await rawPrisma.identityReattribution.count({ where: { projectId: projects.isp.id } }),
  logs: await rawPrisma.systemLog.count({ where: { projectId: projects.isp.id } }),
  members: await rawPrisma.internalTeamMember.findMany({ where: { projectId: projects.isp.id }, select: { id: true, phoneNumber: true, whatsappId: true, updatedAt: true }, orderBy: { id: "asc" } }),
});

describe("identity change preview", () => {
  it("finds every copy of a hit across two accounts", async () => {
    current = users.full;
    const res = await preview();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // M1 (two stored copies, one logical message), M2 and the personal P1. M3 is another sender's; OLD is out of the window.
    expect(res.preview.examined).toEqual({ logicalMessages: 3, storedMessages: 4 });
    expect(res.preview.affected).toEqual({ logicalMessages: 3, storedMessages: 4, groups: 2, personalConversations: 1 });
    expect(res.preview.transitions).toEqual([{ from: "CUSTOMER", to: `MEMBER:${id("rina")}`, count: 3 }]);
    expect(res.preview.byMember).toEqual([{ memberId: id("rina"), gained: 3, lost: 0 }]);
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
    // Never a body, never a phone number: samples carry keys, times and labels only.
    expect(JSON.stringify(res)).not.toContain(SECRET);
    // A personal chat's id (a number or LID) never reaches the browser.
    expect(JSON.stringify(res)).not.toContain(PERSONAL_CHAT);
    expect(JSON.stringify(res)).not.toContain(RINA_PHONE);
    expect(res.preview.samples.find((x) => x.conversationKind === "PERSONAL")?.conversationKey).toBe("personal");
    for (const s of res.preview.samples) expect(Object.keys(s).sort()).toEqual(["conversationKey", "conversationKind", "from", "to", "ts"]);
  });

  it("never returns another project's messages", async () => {
    const res = await preview();
    if (!res.ok) throw new Error(res.error);
    // The other project holds five more rows from the same LID; none of them is read.
    expect(res.preview.examined.storedMessages).toBe(4);
    const input = await inIsp(() => loadIdentityPreviewInput({ identifiers: [LID], window: previewWindow(92, new Date()) }));
    expect(input.messages.every((m) => m.conversationKey !== `${id("other-A")}|${PERSONAL_CHAT}`)).toBe(true);
    expect(input.messages).toHaveLength(3);
  });

  it("the same preview twice has the same figures; the digest names exactly what was shown", async () => {
    const a = await preview();
    const b = await preview();
    if (!a.ok || !b.ok) throw new Error("preview failed");
    // The window ends at "now", so only the window differs between two runs; the digest covers it by design.
    const { window: _a, ...restA } = a.preview;
    const { window: _b, ...restB } = b.preview;
    void _a;
    void _b;
    expect(restB).toEqual(restA);
    expect(previewDigest({ ...a.preview, kpiScope: { month: null, groupKeys: [], personalAccountIds: [] } })).toBe(a.digest);
    const other = await preview({ memberId: null, proposed: { phoneNumber: "+8801000000077", whatsappId: LID } });
    if (!other.ok) throw new Error(other.error);
    expect(other.digest).not.toBe(a.digest);
  });

  it("truncates at the cap and says so", async () => {
    const input = await inIsp(() => loadIdentityPreviewInput({ identifiers: [LID], window: previewWindow(92, new Date()), maxLogical: 2 }));
    expect(input.truncated).toBe(true);
    expect(input.messages).toHaveLength(2);
    const roomy = await inIsp(() => loadIdentityPreviewInput({ identifiers: [LID], window: previewWindow(92, new Date()), maxLogical: 3 }));
    expect(roomy.truncated).toBe(false);
  });

  it("the link-sender path previews the same change as the form", async () => {
    const viaForm = await preview();
    const viaLink = await preview({ memberId: id("rina"), proposed: null, linkSenderId: `${LID}@lid` });
    if (!viaForm.ok || !viaLink.ok) throw new Error("preview failed");
    const { window: _a, ...form } = viaForm.preview;
    const { window: _b, ...link } = viaLink.preview;
    void _a;
    void _b;
    expect(link).toEqual(form);
  });

  it("a new member is previewed as MEMBER:new-member", async () => {
    const res = await preview({ memberId: null, proposed: { phoneNumber: "+8801000000077", whatsappId: LID } });
    if (!res.ok) throw new Error(res.error);
    expect(res.preview.transitions[0]).toMatchObject({ from: "CUSTOMER", to: `MEMBER:${res.newMemberId}` });
  });

  it("estimates the month's figures for the affected groups, before and after", async () => {
    const res = await preview();
    if (!res.ok) throw new Error(res.error);
    expect(res.kpi).not.toBeNull();
    const field = (name: string) => res.kpi!.group.find((f) => f.field === name)!;
    // M1 and M2 stop being customer messages and become Rina's.
    expect(field("customerMessages").before - field("customerMessages").after).toBe(2);
    expect(field("memberReplies").after - field("memberReplies").before).toBe(2);
    expect(res.kpi!.groupsConsidered).toBe(2);
    expect(res.kpi!.personal).not.toBeNull();
    expect(res.kpi!.personal!.find((f) => f.field === "customerMessages")!.before).toBeGreaterThan(res.kpi!.personal!.find((f) => f.field === "customerMessages")!.after - 1);
  });

  it("refuses without whatsapp.manage, refuses with the flag off, hides personal without messages.view", async () => {
    current = users.noManage;
    const denied = await preview();
    expect(denied).toEqual({ ok: false, error: "You do not have permission to perform this action." });

    current = users.full;
    await setFlag(false);
    const off = await preview();
    expect(off).toEqual({ ok: false, error: "Impact preview is not enabled for this project." });
    await setFlag(true);

    current = users.noPersonal;
    const res = await preview();
    if (!res.ok) throw new Error(res.error);
    expect(res.showPersonal).toBe(false);
    expect(res.preview.affected.personalConversations).toBe(0);
    // Not read into any count: the personal message is not in the totals at all.
    expect(res.preview.examined).toEqual({ logicalMessages: 2, storedMessages: 3 });
    expect(res.preview.samples.every((s) => s.conversationKind === "GROUP")).toBe(true);
    expect(res.kpi?.personal ?? null).toBeNull();
    current = users.full;
  });

  it("gives no Team Report estimate to a viewer without support_activity.view (review fix)", async () => {
    current = users.noReports;
    const res = await preview();
    if (!res.ok) throw new Error(res.error);
    // The counts are the member manager's; the waits, missed, recall and overtime figures are the report's.
    expect(res.preview.affected.logicalMessages).toBeGreaterThan(0);
    expect(res.kpi).toBeNull();
    current = users.full;
  });

  it("refuses what Save would refuse", async () => {
    const badPhone = await preview({ memberId: id("rina"), proposed: { phoneNumber: "not a number", whatsappId: null } });
    expect(badPhone.ok).toBe(false);
    const badId = await preview({ memberId: id("rina"), proposed: { phoneNumber: `+${RINA_PHONE}`, whatsappId: "12ab" } });
    expect(badId.ok).toBe(false);
    const badDate = await preview({ memberId: id("rina"), proposed: { phoneNumber: `+${RINA_PHONE}`, whatsappId: LID, attributeFrom: "2026-02-31" } });
    expect(badDate.ok).toBe(false);
    const gone = await preview({ memberId: "nobody", proposed: { phoneNumber: `+${RINA_PHONE}`, whatsappId: LID } });
    expect(gone.ok).toBe(false);
    const group = await preview({ memberId: id("rina"), proposed: null, linkSenderId: G1 });
    expect(group.ok).toBe(false);
  });

  it("writes nothing", async () => {
    const before = await rowCounts();
    const res = await preview();
    expect(res.ok).toBe(true);
    await preview({ memberId: null, proposed: { phoneNumber: "+8801000000077", whatsappId: LID } });
    await preview({ memberId: id("rina"), proposed: null, linkSenderId: `${LID}@lid` });
    expect(await rowCounts()).toEqual(before);
  });
});

describe("saving after a preview", () => {
  const DIGEST = "a".repeat(64);
  const carried = (extra: Record<string, string> = {}) => ({
    previewDigest: DIGEST,
    previewAffected: "3",
    previewGroups: "2",
    previewPersonal: "1",
    previewFrom: "2026-07-20T00:00:00.000Z",
    previewTo: "2026-10-20T00:00:00.000Z",
    ...extra,
  });
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  const logFor = async (name: string) => {
    const rows = await rawPrisma.systemLog.findMany({ where: { projectId: projects.isp.id, scope: "team-members", message: { contains: name } }, select: { metadata: true } });
    expect(rows).toHaveLength(1);
    return rows[0]!.metadata as Record<string, unknown>;
  };

  it("teamMembers save without previewDigest logs exactly as before", async () => {
    current = users.full;
    const res = await inIsp(() => teamMemberActions.createTeamMember({}, form({ name: "Plain Add", phoneNumber: "+8801000000081", role: "Support" })));
    expect(res).toEqual({ success: true });
    const metadata = await logFor("Plain Add");
    expect(Object.keys(metadata).sort()).toEqual(["after", "before", "via"]);
    expect(metadata).toEqual({ before: null, after: { phoneNumber: "+8801000000081", whatsappId: null }, via: "form" });
  });

  it("a save that carries a preview records what the person saw, and still saves", async () => {
    current = users.full;
    const res = await inIsp(() => teamMemberActions.createTeamMember({}, form({ name: "Previewed Add", phoneNumber: "+8801000000082", role: "Support", ...carried() })));
    expect(res).toEqual({ success: true });
    const metadata = await logFor("Previewed Add");
    expect(metadata.preview).toEqual({
      digest: DIGEST,
      affectedLogical: 3,
      affectedGroups: 2,
      affectedPersonal: 1,
      window: { from: "2026-07-20T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" },
    });
    expect(await rawPrisma.internalTeamMember.count({ where: { projectId: projects.isp.id, phoneNumber: "+8801000000082" } })).toBe(1);
    // The save path is unchanged: it queued its re-attribution exactly once.
    expect(await rawPrisma.identityReattribution.count({ where: { projectId: projects.isp.id, reason: { contains: "Previewed Add" } } })).toBe(1);
  });

  it("a malformed digest or count is ignored, never stored", async () => {
    current = users.full;
    for (const [name, extra] of [
      ["Bad Digest", { previewDigest: "not-a-digest" }],
      ["Bad Count", { previewAffected: "-4" }],
      ["Bad Date", { previewFrom: "yesterday-ish" }],
    ] as const) {
      const res = await inIsp(() => teamMemberActions.createTeamMember({}, form({ name, phoneNumber: `+88010000009${name.length}`, role: "Support", ...carried(extra) })));
      expect(res).toEqual({ success: true });
      expect((await logFor(name)).preview).toBeUndefined();
    }
  });

  it("the chat link records the preview it carried", async () => {
    current = users.full;
    const res = await inIsp(() => teamMemberActions.linkWhatsAppSender(`${LID}@lid`, {}, form({ memberId: id("omar"), ...carried() })));
    expect(res).toEqual({ linked: "Omar" });
    const metadata = await logFor("Omar");
    expect((metadata.preview as { digest: string }).digest).toBe(DIGEST);
    expect(metadata.via).toBe("chat-link");
  });

  it("an edit records the preview it carried", async () => {
    current = users.full;
    const target = await rawPrisma.internalTeamMember.findFirstOrThrow({ where: { projectId: projects.isp.id, phoneNumber: "+8801000000081" } });
    await inIsp(() =>
      teamMemberActions
        .updateTeamMember(target.id, {}, form({ name: "Plain Add", phoneNumber: "+8801000000081", whatsappId: "100000000081", role: "Support", ...carried() }))
        .catch((err: unknown) => {
          // A successful edit redirects to the list; Next throws to do it.
          if (!String((err as { message?: string })?.message).includes("NEXT_REDIRECT")) throw err;
        }),
    );
    const rows = await rawPrisma.systemLog.findMany({
      where: { projectId: projects.isp.id, scope: "team-members", targetId: target.id, message: { contains: "changed" } },
      select: { metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as { preview: { digest: string } }).preview.digest).toBe(DIGEST);
  });
});
