import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createProjectScopedPrisma,
  ORIGINAL_PROJECT_ID,
  prisma,
  ProjectScopeError,
  scopeQueryArgs,
} from "@support-automation/db";

/**
 * Multi-project Phase 2: the project-scoped client (packages/db `createProjectScopedPrisma`).
 * Two projects — ISP Digital and a test "Bizify" — and one question asked every way the app asks
 * it: can a query on one project reach the other's rows? It must not, and a query with no project
 * must fail rather than read everything.
 *
 * Fixtures are written with the RAW client and an explicit projectId, so each test's "other
 * project" rows really exist; the assertions all go through the scoped client.
 */

const ISP = ORIGINAL_PROJECT_ID;
const BIZIFY = `proj_test_bizify_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 8);

let active: string | null = ISP;
const db = createProjectScopedPrisma(prisma, async () => {
  if (!active) throw new ProjectScopeError("no active project (test)");
  return active;
});

let userId: string;

beforeAll(async () => {
  await prisma.project.create({ data: { id: BIZIFY, name: `Bizify ${tag}`, slug: `bizify-${tag}`, status: "ACTIVE" } });
  userId = (await prisma.user.create({ data: { username: `scope-${tag}`, name: "Scope Test", passwordHash: "x" } })).id;
});

beforeEach(() => {
  active = ISP;
});

afterAll(async () => {
  const projects = [ISP, BIZIFY];
  await prisma.systemLog.deleteMany({ where: { scope: `scope-test-${tag}` } });
  await prisma.supportRuleKeyword.deleteMany({ where: { rule: { name: { startsWith: `scope-${tag}` } } } });
  await prisma.supportRule.deleteMany({ where: { name: { startsWith: `scope-${tag}` } } });
  await prisma.supportKeyword.deleteMany({ where: { value: { startsWith: `scope-${tag}` } } });
  await prisma.automationRule.deleteMany({ where: { name: { startsWith: `scope-${tag}` } } });
  await prisma.whatsAppGroup.deleteMany({ where: { name: { startsWith: `scope-${tag}` } } });
  await prisma.whatsAppAccount.deleteMany({ where: { label: { startsWith: `scope-${tag}` } } });
  await prisma.aiSettings.deleteMany({ where: { projectId: BIZIFY } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.project.deleteMany({ where: { id: BIZIFY, NOT: { id: { in: projects.filter((p) => p !== BIZIFY) } } } });
  await prisma.$disconnect();
});

const rule = (projectId: string, suffix: string) =>
  prisma.automationRule.create({
    data: {
      projectId,
      name: `scope-${tag}-${suffix}`,
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      keywords: ["x"],
      actions: [],
      status: "ACTIVE",
      createdById: userId,
    },
  });

describe("reads", () => {
  it("findMany / count / aggregate / groupBy see only the active project", async () => {
    await rule(ISP, "isp-1");
    await rule(BIZIFY, "biz-1");
    await rule(BIZIFY, "biz-2");
    const where = { name: { startsWith: `scope-${tag}` } };

    expect((await db.automationRule.findMany({ where })).map((r) => r.name)).toEqual([`scope-${tag}-isp-1`]);
    expect(await db.automationRule.count({ where })).toBe(1);
    active = BIZIFY;
    expect(await db.automationRule.count({ where })).toBe(2);
    expect((await db.automationRule.aggregate({ where, _count: { _all: true } }))._count._all).toBe(2);
    const grouped = await db.automationRule.groupBy({ by: ["status"], where, _count: { _all: true } });
    expect(grouped).toEqual([expect.objectContaining({ status: "ACTIVE", _count: { _all: 2 } })]);
  });

  it("findUnique by id does not return another project's row", async () => {
    const other = await rule(BIZIFY, "biz-unique");
    expect(await db.automationRule.findUnique({ where: { id: other.id } })).toBeNull();
    await expect(db.automationRule.findUniqueOrThrow({ where: { id: other.id } })).rejects.toThrow();
  });

  it("a list relation reached from a platform model (User) is filtered to the project", async () => {
    await rule(ISP, "isp-rel");
    await rule(BIZIFY, "biz-rel");
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { createdRules: true, _count: { select: { createdRules: true } } } });
    const names = user.createdRules.map((r) => r.name).filter((n) => n.includes("-rel"));
    expect(names).toEqual([`scope-${tag}-isp-rel`]);
    const ispCount = user._count.createdRules;
    active = BIZIFY;
    const asBizify = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { _count: { select: { createdRules: true } } } });
    const total = await prisma.automationRule.count({ where: { createdById: userId } });
    expect(ispCount + asBizify._count.createdRules).toBe(total);
  });
});

describe("writes", () => {
  it("create stamps the active project — unchecked and checked input alike", async () => {
    active = BIZIFY;
    const created = await db.automationRule.create({
      data: { name: `scope-${tag}-created`, type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: [], actions: [] },
    });
    expect(created.projectId).toBe(BIZIFY);

    const account = await db.whatsAppAccount.create({ data: { label: `scope-${tag}-acct` } });
    expect(account.projectId).toBe(BIZIFY);
    // Checked input: the relation given as { connect } rather than a scalar accountId.
    const group = await db.whatsAppGroup.create({
      data: { account: { connect: { id: account.id } }, whatsappGroupId: `${tag}@g.us`, name: `scope-${tag}-group` },
    });
    expect(group.projectId).toBe(BIZIFY);
  });

  it("nested creates land in the active project too, not the database default", async () => {
    active = BIZIFY;
    const created = await db.supportRule.create({
      data: {
        name: `scope-${tag}-nested`,
        keywords: { create: [{ keyword: { create: { value: `scope-${tag}-kw` } } }] },
      },
      include: { keywords: { include: { keyword: true } } },
    });
    expect(created.projectId).toBe(BIZIFY);
    expect(created.keywords[0]!.projectId).toBe(BIZIFY);
    expect(created.keywords[0]!.keyword.projectId).toBe(BIZIFY);
  });

  it("update / delete cannot touch another project's row", async () => {
    const other = await rule(BIZIFY, "biz-protected");
    await expect(db.automationRule.update({ where: { id: other.id }, data: { name: "hijacked" } })).rejects.toThrow();
    expect((await db.automationRule.updateMany({ where: { id: other.id }, data: { name: "hijacked" } })).count).toBe(0);
    expect((await db.automationRule.deleteMany({ where: { id: other.id } })).count).toBe(0);
    expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(`scope-${tag}-biz-protected`);
  });

  it("connect cannot link to another project's row", async () => {
    const bizAccount = await prisma.whatsAppAccount.create({ data: { projectId: BIZIFY, label: `scope-${tag}-biz-acct` } });
    active = ISP;
    await expect(
      db.whatsAppGroup.create({
        data: { account: { connect: { id: bizAccount.id } }, whatsappGroupId: `${tag}-x@g.us`, name: `scope-${tag}-cross` },
      }),
    ).rejects.toThrow();
  });

  it("an interactive transaction is scoped as well", async () => {
    await rule(BIZIFY, "biz-tx");
    const seen = await db.$transaction(async (tx) => tx.automationRule.count({ where: { name: `scope-${tag}-biz-tx` } }));
    expect(seen).toBe(0);
  });
});

describe("fail closed", () => {
  it("a scoped query with no project context throws instead of reading every project", async () => {
    active = null;
    await expect(db.automationRule.findMany({})).rejects.toBeInstanceOf(ProjectScopeError);
    await expect(db.automationRule.count()).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("naming another project explicitly is refused", async () => {
    await expect(db.automationRule.findMany({ where: { projectId: BIZIFY } })).rejects.toBeInstanceOf(ProjectScopeError);
    await expect(
      db.automationRule.create({
        data: { projectId: BIZIFY, name: `scope-${tag}-sneak`, type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: [], actions: [] },
      }),
    ).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("a platform query (users) needs no project at all", async () => {
    active = null;
    expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});

describe("settings singletons and system logs", () => {
  it("id 'global' means THIS project's row; a new project gets its own", async () => {
    active = BIZIFY;
    const biz = await db.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global", aiEngineEnabled: true } });
    expect(biz).toMatchObject({ projectId: BIZIFY, id: BIZIFY, aiEngineEnabled: true });
    active = ISP;
    const isp = await db.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    expect(isp).toMatchObject({ projectId: ISP, id: "global" });
    expect((await db.aiSettings.findUniqueOrThrow({ where: { id: "global" } })).projectId).toBe(ISP);
  });

  it("a project sees its own logs and platform logs, never another project's", async () => {
    const scope = `scope-test-${tag}`;
    await prisma.systemLog.createMany({
      data: [
        { level: "INFO", scope, message: "isp", projectId: ISP },
        { level: "INFO", scope, message: "biz", projectId: BIZIFY },
        { level: "INFO", scope, message: "platform", projectId: null },
      ],
    });
    active = BIZIFY;
    const seen = (await db.systemLog.findMany({ where: { scope } })).map((l) => l.message).sort();
    expect(seen).toEqual(["biz", "platform"]);
  });
});

describe("scopeQueryArgs (pure)", () => {
  it("adds the project to where, data and list includes", () => {
    const args = scopeQueryArgs("AutomationRule", "findMany", { where: { status: "ACTIVE" } }, "p1");
    expect(args.where).toEqual({ status: "ACTIVE", projectId: "p1" });
    const withInclude = scopeQueryArgs("WhatsAppAccount", "findFirst", { include: { groups: true } }, "p1");
    expect(withInclude.include).toEqual({ groups: { where: { projectId: "p1" } } });
  });
});
