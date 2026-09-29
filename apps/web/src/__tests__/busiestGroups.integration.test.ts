import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { getBusiestGroups } from "@/server/actions/dashboardMetrics";

/**
 * "Busiest groups" on the Overview must be the same answer every time it is asked. It ordered by
 * message count alone, so groups with EQUAL counts came back in whatever order Postgres's plan
 * produced — the chart could reorder, and at the six-group cut-off swap which groups it showed,
 * between two refreshes with nothing new. That is also what made the Phase 6 "ISP Digital's figures
 * do not move" test flaky whenever ISP Digital held tied groups.
 *
 * Nine groups with the same count, created with ids in DESCENDING order, so insertion order and id
 * order disagree and a lucky plan cannot pass the test by accident.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let project: ActiveProject;
let creatorId: string;
const NOW = new Date();

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `busy_${tag}`, email: `busy_${tag}@example.test`, name: "Busy", passwordHash: "x" } })).id;
  const created = await createProjectWithDefaults({ name: `Busy ${tag}`, slug: `busy-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Busy ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `busy ${tag}` } });
  // One clear leader, then nine tied groups.
  const plan: Array<[string, number]> = [[`g-${tag}-leader`, 5], ...Array.from({ length: 9 }, (_, i) => [`g-${tag}-${9 - i}`, 2] as [string, number])];
  for (const [id, count] of plan) {
    await rawPrisma.whatsAppGroup.create({ data: { ...pid, id, accountId: account.id, whatsappGroupId: `${id}@g.us`, name: id } });
    for (let m = 0; m < count; m++) {
      await rawPrisma.message.create({
        data: {
          ...pid,
          accountId: account.id,
          groupId: id,
          chatId: `${id}@g.us`,
          whatsappMessageId: `wamid-${randomUUID()}`,
          senderPhone: "8801711000333",
          direction: "INCOMING",
          body: "x",
          normalizedBody: "x",
          timestampWa: NOW,
        },
      });
    }
  }
});

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("busiest groups", () => {
  it("orders by count, and breaks ties by group — the same six every time", async () => {
    const result = await runWithProject(project, () => getBusiestGroups(NOW.getTime() + 60_000));
    expect(result.groups.map((g) => [g.id, g.value])).toEqual([
      [`g-${tag}-leader`, 5],
      [`g-${tag}-1`, 2],
      [`g-${tag}-2`, 2],
      [`g-${tag}-3`, 2],
      [`g-${tag}-4`, 2],
      [`g-${tag}-5`, 2],
    ]);
  });

  it("asking again gives the identical answer", async () => {
    const ask = () => runWithProject(project, () => getBusiestGroups(NOW.getTime() + 60_000));
    const first = await ask();
    for (let i = 0; i < 5; i++) expect(await ask()).toEqual(first);
  });
});
