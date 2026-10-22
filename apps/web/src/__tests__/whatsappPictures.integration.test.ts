import "./helpers/requireTestDatabase";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { picturePaths } from "@/server/whatsappPictures";

// Called outside any request, as the original installation on an open address (SAAS_PLATFORM_PLAN.md §12).
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

/**
 * WhatsApp profile pictures in the dashboard (WHATSAPP_AVATARS.md): a project sees only its own
 * accounts' pictures, and nothing at all with its feature off or the server's emergency switch on.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const JID = "123456789012345@lid";
let other: { id: string; slug: string };
const accounts = { isp: "", other: "" };
const isp: ActiveProject = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);

async function setFeature(projectId: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key: "WHATSAPP_AVATARS" } },
    create: { projectId, key: "WHATSAPP_AVATARS", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
}

beforeAll(async () => {
  const creator = await rawPrisma.user.create({ data: { username: `pic_${tag}`, email: `pic_${tag}@example.test`, name: "Pic", passwordHash: "x" } });
  other = await createProjectWithDefaults({ name: `Pictures ${tag}`, slug: `pictures-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma);
  accounts.isp = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `Pic ISP ${tag}` } })).id;
  accounts.other = (await rawPrisma.whatsAppAccount.create({ data: { projectId: other.id, label: `Pic other ${tag}` } })).id;
  for (const [projectId, accountId] of [[ORIGINAL_PROJECT_ID, accounts.isp], [other.id, accounts.other]] as const) {
    await rawPrisma.whatsAppPicture.create({
      data: { projectId, accountId, jid: JID, state: "STORED", mimeType: "image/jpeg", bytes: JPEG, observedAt: new Date(), storedAt: new Date() },
    });
  }
  await setFeature(ORIGINAL_PROJECT_ID, true);
  await setFeature(other.id, true);
});

afterEach(() => {
  delete process.env.WHATSAPP_AVATARS_DISABLED;
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [accounts.isp, accounts.other] } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "WHATSAPP_AVATARS", projectId: { in: [ORIGINAL_PROJECT_ID, other.id] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: other.id } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: other.id } });
  await rawPrisma.project.deleteMany({ where: { id: other.id } }).catch(() => undefined);
  await rawPrisma.user.deleteMany({ where: { username: `pic_${tag}` } });
});

describe("pictures in the dashboard", () => {
  it("gives a project its own account's picture, as an authenticated project path", async () => {
    const paths = await inIsp(() => picturePaths(accounts.isp, [JID]));
    expect(paths[JID]).toMatch(/^\/api\/whatsapp\/avatar\/[^/?]+\?v=\d+$/);
  });

  it("never another project's, even asked by that account's id", async () => {
    expect(await inIsp(() => picturePaths(accounts.other, [JID]))).toEqual({});
  });

  it("nothing with the project's feature off", async () => {
    await setFeature(ORIGINAL_PROJECT_ID, false);
    expect(await inIsp(() => picturePaths(accounts.isp, [JID]))).toEqual({});
    await setFeature(ORIGINAL_PROJECT_ID, true);
  });

  it("nothing under the server's emergency switch", async () => {
    process.env.WHATSAPP_AVATARS_DISABLED = "true";
    expect(await inIsp(() => picturePaths(accounts.isp, [JID]))).toEqual({});
  });
});
