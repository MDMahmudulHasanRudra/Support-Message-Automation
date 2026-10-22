import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { rawPrisma } from "./helpers/projectFixtures.js";
import { resetProjectCachesForTests } from "../project/context.js";

/**
 * What the worker does to accounts on every boot must never undo what an operator set.
 *
 * Two things did:
 * - `ensurePrimaryAccountExists` made the OLDEST account Primary in any project that had none. Since
 *   only the Primary answers customers (processIncomingMessage), a "Remove Primary" was quietly
 *   reversed at the next restart — and the oldest account is often a retired or logged-out spare,
 *   so every customer reply in the project stopped. It now promotes only when the project has
 *   exactly ONE account, which is the case it was written for (the migration that introduced the
 *   column, and a project's first number).
 * - `ensureLegacyAccountExists` re-created the original account whenever no row used its session
 *   folder, so deleting it in the dashboard brought it back on the next restart, ready to reconnect
 *   with the old WhatsApp link. It now creates it only on a fresh install, when no account exists.
 *
 * The legacy session folder is read from the environment when the module loads, so it is pointed at
 * a folder no other test uses before the module is imported.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const LEGACY_DIR = `/tmp/legacy-${tag}`;
process.env.WHATSAPP_SESSION_DIR = LEGACY_DIR;
const { ensureLegacyAccountExists, ensurePrimaryAccountExists } = await import("../provider/accountProvisioning.js");

const projects: string[] = [];
let creatorId: string;

async function newProject(name: string) {
  const created = await createProjectWithDefaults(
    { name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: creatorId },
    rawPrisma,
  );
  projects.push(created.id);
  resetProjectCachesForTests(); // the worker caches its project list; this one is new
  return created.id;
}

/**
 * `ensurePrimaryAccountExists` visits EVERY project, so a shared fixture account that happens to be
 * its project's only one would be promoted too — and a Primary left behind in ISP Digital switches off
 * automation for every later suite's accounts (only the Primary answers). Anything promoted outside
 * this file's own projects is put back.
 */
async function ensurePrimaryHere() {
  const before = new Set((await rawPrisma.whatsAppAccount.findMany({ where: { isPrimary: true }, select: { id: true } })).map((a) => a.id));
  await ensurePrimaryAccountExists();
  await rawPrisma.whatsAppAccount.updateMany({
    where: { isPrimary: true, id: { notIn: [...before] }, projectId: { notIn: projects } },
    data: { isPrimary: false },
  });
}

async function addAccount(projectId: string, label: string, createdAt: Date) {
  return rawPrisma.whatsAppAccount.create({ data: { projectId, label: `${label} ${tag}`, status: "DISCONNECTED", createdAt } });
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `prov_${tag}`, email: `prov_${tag}@example.test`, name: "Prov", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { sessionDataPath: LEGACY_DIR } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, projects).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: projects } } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
});

describe("ensurePrimaryAccountExists", () => {
  it("leaves a project with several accounts and no Primary alone — that is an operator's choice", async () => {
    const projectId = await newProject("Several");
    const oldest = await addAccount(projectId, "Retired spare", new Date(Date.now() - 60 * 60_000));
    await addAccount(projectId, "Serving number", new Date());

    await ensurePrimaryHere();

    expect(await rawPrisma.whatsAppAccount.count({ where: { projectId, isPrimary: true } })).toBe(0);
    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: oldest.id } })).isPrimary).toBe(false);
  });

  it("still makes a project's only account Primary", async () => {
    const projectId = await newProject("Single");
    const only = await addAccount(projectId, "Only number", new Date());

    await ensurePrimaryHere();

    expect((await rawPrisma.whatsAppAccount.findUniqueOrThrow({ where: { id: only.id } })).isPrimary).toBe(true);
  });
});

describe("ensureLegacyAccountExists", () => {
  it("does not bring back a deleted original account while other accounts exist", async () => {
    // The test database always holds other accounts; none of them uses this folder.
    expect(await rawPrisma.whatsAppAccount.count()).toBeGreaterThan(0);

    const result = await ensureLegacyAccountExists();

    expect(result).toBeNull();
    expect(await rawPrisma.whatsAppAccount.count({ where: { sessionDataPath: LEGACY_DIR } })).toBe(0);
  });

  it("still returns the original account when it exists", async () => {
    const projectId = await newProject("Legacy");
    const legacy = await rawPrisma.whatsAppAccount.create({
      data: { projectId, label: `Legacy ${tag}`, status: "DISCONNECTED", sessionDataPath: LEGACY_DIR, sessionId: `legacy-${tag}` },
    });

    expect((await ensureLegacyAccountExists())?.id).toBe(legacy.id);
  });
});
