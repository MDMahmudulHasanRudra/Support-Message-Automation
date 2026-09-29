import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { ISP_DIGITAL, rawPrisma } from "./helpers/projectFixtures.js";

/**
 * Multi-project Phase 7 (MULTI_PROJECT_PLAN.md §6.5, §10.7): the DATABASE refuses a row whose
 * parent belongs to another project, and refuses to move a row between projects — whatever the
 * application does. Every write here goes through the RAW, unscoped client on purpose: the scoped
 * clients would refuse these writes first, and the point is what happens when something gets past
 * them.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let bizId: string;
let creatorId: string;
let ispAccountId: string;
let ispGroupId: string;
let bizAccountId: string;
let bizGroupId: string;

function messageData(projectId: string, accountId: string, groupId: string | null) {
  return {
    projectId,
    accountId,
    groupId,
    chatId: `${tag}-integrity@g.us`,
    whatsappMessageId: `wamid-${randomUUID()}`,
    senderPhone: "8801711000222",
    direction: "INCOMING" as const,
    body: "x",
    normalizedBody: "x",
    timestampWa: new Date(),
  };
}

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `int_${tag}`, email: `int_${tag}@example.test`, name: "Integrity", passwordHash: "x" } });
  creatorId = user.id;
  bizId = (await createProjectWithDefaults({ name: `Bizify ${tag}`, slug: `bizify-int-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma)).id;
  ispAccountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `ISP int ${tag}` } })).id;
  bizAccountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: bizId, label: `BIZ int ${tag}` } })).id;
  ispGroupId = (await rawPrisma.whatsAppGroup.create({ data: { projectId: ISP_DIGITAL, accountId: ispAccountId, whatsappGroupId: `isp-${tag}@g.us`, name: "ISP" } })).id;
  bizGroupId = (await rawPrisma.whatsAppGroup.create({ data: { projectId: bizId, accountId: bizAccountId, whatsappGroupId: `biz-${tag}@g.us`, name: "BIZ" } })).id;
});

afterAll(async () => {
  for (const accountId of [ispAccountId, bizAccountId]) {
    await rawPrisma.message.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
  }
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, bizId).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: bizId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("every project-owned reference is guarded", () => {
  it("each foreign key between two project-owned tables has a consistency trigger — none missing", async () => {
    const references = await rawPrisma.$queryRaw<Array<{ name: string }>>`
      SELECT child.relname || '_' || att.attname || '_same_project' AS name
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND att.attname <> 'projectId'
        AND parent.relname <> 'Project' AND child.relname <> 'SystemLog'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'projectId' AND NOT a.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'projectId' AND NOT a.attisdropped)`;
    const triggers = new Set(
      (await rawPrisma.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%\\_same\\_project'`).map((t) => t.tgname),
    );
    const missing = references.map((r) => r.name).filter((name) => !triggers.has(name));
    expect(missing).toEqual([]);
    expect(references.length).toBeGreaterThanOrEqual(96);
  });

  it("every project-owned table refuses to change a row's project", async () => {
    const tables = await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'projectId' AND table_schema = 'public' AND table_name <> 'SystemLog'`;
    const triggers = new Set(
      (await rawPrisma.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%\\_projectId\\_immutable'`).map((t) => t.tgname),
    );
    expect(tables.map((t) => `${t.table_name}_projectId_immutable`).filter((name) => !triggers.has(name))).toEqual([]);
  });
});

describe("the database refuses cross-project references", () => {
  it("a Bizify message on an ISP Digital account is refused — and the same row in its own project is accepted", async () => {
    const cross = messageData(bizId, ispAccountId, null);
    await expect(rawPrisma.message.create({ data: cross })).rejects.toThrow();
    expect(await rawPrisma.message.count({ where: { whatsappMessageId: cross.whatsappMessageId } })).toBe(0);
    await expect(rawPrisma.message.create({ data: messageData(bizId, bizAccountId, bizGroupId) })).resolves.toBeTruthy();
  });

  it("a message in its own project's account but another project's group is refused", async () => {
    await expect(rawPrisma.message.create({ data: messageData(ISP_DIGITAL, ispAccountId, bizGroupId) })).rejects.toThrow();
  });

  it("pointing an existing row at another project's parent is refused", async () => {
    const message = await rawPrisma.message.create({ data: messageData(ISP_DIGITAL, ispAccountId, ispGroupId) });
    await expect(rawPrisma.message.update({ where: { id: message.id }, data: { groupId: bizGroupId } })).rejects.toThrow();
    expect((await rawPrisma.message.findUniqueOrThrow({ where: { id: message.id } })).groupId).toBe(ispGroupId);
  });

  it("raw SQL is held to the same rule", async () => {
    await expect(
      rawPrisma.$executeRawUnsafe(
        `INSERT INTO "WhatsAppGroup" ("id", "projectId", "accountId", "whatsappGroupId", "name", "updatedAt") VALUES ($1, $2, $3, $4, 'raw', now())`,
        randomUUID(),
        bizId,
        ispAccountId,
        `raw-${tag}@g.us`,
      ),
    ).rejects.toThrow(/23503|Cross-project/);
  });

  it("a row cannot be moved into another project", async () => {
    await expect(rawPrisma.whatsAppGroup.update({ where: { id: ispGroupId }, data: { projectId: bizId } })).rejects.toThrow();
    expect((await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: ispGroupId } })).projectId).toBe(ISP_DIGITAL);
  });
});

describe("ordinary behaviour is unchanged", () => {
  it("deleting a parent still nulls or cascades its children exactly as before", async () => {
    const group = await rawPrisma.whatsAppGroup.create({ data: { projectId: ISP_DIGITAL, accountId: ispAccountId, whatsappGroupId: `tmp-${tag}@g.us`, name: "tmp" } });
    const message = await rawPrisma.message.create({ data: messageData(ISP_DIGITAL, ispAccountId, group.id) });
    await rawPrisma.whatsAppGroup.delete({ where: { id: group.id } }); // Message.groupId is SET NULL
    expect((await rawPrisma.message.findUniqueOrThrow({ where: { id: message.id } })).groupId).toBeNull();
  });

  it("a same-project update of a reference is accepted", async () => {
    const other = await rawPrisma.whatsAppGroup.create({ data: { projectId: ISP_DIGITAL, accountId: ispAccountId, whatsappGroupId: `other-${tag}@g.us`, name: "other" } });
    const message = await rawPrisma.message.create({ data: messageData(ISP_DIGITAL, ispAccountId, ispGroupId) });
    await rawPrisma.message.update({ where: { id: message.id }, data: { groupId: other.id } });
    expect((await rawPrisma.message.findUniqueOrThrow({ where: { id: message.id } })).groupId).toBe(other.id);
  });
});
