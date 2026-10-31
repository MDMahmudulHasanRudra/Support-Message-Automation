import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Smart Import V5 against a real database (§4–5): what an import STORES.
 *   - a number that can be read with certainty is stored in E.164 (never "++", never the code twice), a local one
 *     read in the project's default country, and one Excel damaged is kept as written and flagged;
 *   - country, currency and language are derived from a valid number only where the file says nothing, and an
 *     existing client's value is never replaced by a derived one;
 *   - a number an older import stored as bare digits is recognised, not added a second time;
 *   - the "fill from phone" switch is honoured.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const actions = await import("@/server/actions/smartImport");
const uploadRoute = await import("@/app/p/[project]/api/clients/import/smart-upload/route");
const processor = await import("@/server/smartImportProcessor");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let P: Project;
let importer: Session;

const as = <T,>(fn: () => Promise<T>) => {
  current = importer;
  return runWithProject(P, fn);
};
function xlsx(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Clients");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
async function uploaded(bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "v5.xlsx"));
  const res = await as(() => uploadRoute.POST(new NextRequest("http://localhost/p/x/api/clients/import/smart-upload", { method: "POST", body: form })));
  const body = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
  return body.jobId!;
}
async function importAll(jobId: string, mapping?: unknown) {
  if (mapping) {
    const j = await rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id: jobId } });
    const saved = await as(() => actions.saveSmartMapping(jobId, j.revision, mapping));
    expect(saved, saved.message).toMatchObject({ ok: true });
  }
  const review = await as(async () => {
    const r = await actions.loadSmartReview(jobId, {});
    if ("error" in r) throw new Error(r.error);
    return r;
  });
  const r = await as(() => actions.confirmSmartImport(jobId, { revision: review.revision, policy: "UPDATE", acknowledged: review.assessment.warnings.map((w) => w.code) }));
  expect(r, r.message).toMatchObject({ ok: true });
  for (let i = 0; i < 20; i++) {
    const claimed = await processor.claimSmartImportJob();
    if (!claimed) break;
    await runWithProject(P, () => processor.processClaimedJob(claimed.id, 120_000));
  }
  return review;
}
const clientByName = (name: string) =>
  rawPrisma.client.findFirstOrThrow({ where: { projectId: P.id, name }, include: { channels: { select: { kind: true, value: true, normalizedValue: true } } } });

beforeAll(async () => {
  const permissions = await Promise.all(
    ["clients.view", "clients.create", "clients.update", "clients.import"].map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `V5 importer ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `v5_${tag}`, email: `v5.${tag}@example.test`, name: "V5", passwordHash: "x", permissionModuleId: role.id } });
  ids.users.push(u.id);
  importer = { userId: u.id, username: u.username, email: u.email!, name: "V5" } as Session;
  const p = await createProjectWithDefaults({ name: `V5 ${tag}`, slug: `v5-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.projects.push(p.id);
  P = { id: p.id, slug: p.slug, name: `V5 ${tag}`, status: "ACTIVE" };
  await rawPrisma.projectAccess.createMany({ data: [{ projectId: p.id, userId: u.id }], skipDuplicates: true });
  for (const key of ["CLIENT_CENTER", "CLIENT_SMART_IMPORT"]) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
  forgetProjectFeatureStates();
  // The project reads numbers written without a code as Saudi numbers.
  await rawPrisma.clientModuleSettings.upsert({ where: { projectId: p.id }, create: { projectId: p.id, defaultCountry: "SA" }, update: { defaultCountry: "SA" } });
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientImportRow.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientModuleSettings.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("Smart Import V5: what is stored", () => {
  it("stores numbers in E.164, reads local ones in the default country, and keeps a damaged one as written", async () => {
    const id = await uploaded(
      xlsx([
        ["Name", "Mobile"],
        [`Ahmed ${tag}`, 966551234567],
        [`Rina ${tag}`, "8801712345678"],
        [`Local ${tag}`, "0501234567"],
        [`Plus ${tag}`, "++971501234567"],
        [`Damaged ${tag}`, "9.66551E+11"],
      ]),
    );
    await importAll(id);
    const ahmed = await clientByName(`Ahmed ${tag}`);
    expect(ahmed.channels).toEqual([{ kind: "PHONE", value: "+966551234567", normalizedValue: "966551234567" }]);
    expect(ahmed).toMatchObject({ country: "SA", preferredCurrency: "SAR", preferredLanguage: "Arabic" });
    const rina = await clientByName(`Rina ${tag}`);
    expect(rina.channels[0]).toMatchObject({ value: "+8801712345678" });
    expect(rina.country).toBe("BD");
    expect(rina.preferredCurrency).toBe("BDT");
    expect((await clientByName(`Local ${tag}`)).channels[0]).toMatchObject({ value: "+966501234567", normalizedValue: "966501234567" });
    expect((await clientByName(`Plus ${tag}`)).channels[0]).toMatchObject({ value: "+971501234567" });
    // Damaged: imported as the file wrote it, never "repaired" into a different number, no country guessed.
    // Excel's float form is refused with its row (shown in the review), never imported as a guessed number.
    expect(await rawPrisma.client.findFirst({ where: { projectId: P.id, name: `Damaged ${tag}` } })).toBeNull();
  }, 120_000);

  it("never replaces an existing client's country or currency with a derived one, and recognises an old digits-only number", async () => {
    // An older import stored this client's number as bare local digits, with a country and currency someone chose.
    const existing = await rawPrisma.client.create({
      data: {
        projectId: P.id,
        code: `OLD-${tag}`,
        name: `Old ${tag}`,
        country: "AE",
        preferredCurrency: "USD",
        channels: { create: { projectId: P.id, kind: "PHONE", value: "0551112222", normalizedValue: "0551112222", isPrimary: true } },
      },
    });
    const id = await uploaded(xlsx([["Name", "Mobile"], [`Old ${tag}`, "0551112222"]]));
    const review = await importAll(id);
    expect(review.summary.matchExisting).toBe(1);
    const after = await rawPrisma.client.findUniqueOrThrow({ where: { id: existing.id }, include: { channels: true } });
    expect(after.channels).toHaveLength(1); // not added again as +966551112222
    expect(after.country).toBe("AE");
    expect(after.preferredCurrency).toBe("USD");
  }, 120_000);

  it("keeps the file's own country and currency, and fills nothing when the switch is off", async () => {
    const id = await uploaded(xlsx([["Name", "Mobile", "Country", "Currency"], [`Filed ${tag}`, "966561234567", "United Arab Emirates", "TK"]]));
    await importAll(id);
    expect(await clientByName(`Filed ${tag}`)).toMatchObject({ country: "AE", preferredCurrency: "BDT" });

    const off = await uploaded(xlsx([["Name", "Mobile"], [`Off ${tag}`, "966571234567"]]));
    const j = await rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id: off } });
    await importAll(off, { ...(j.mapping as object), fillLocale: false });
    const c = await clientByName(`Off ${tag}`);
    expect(c.channels[0]).toMatchObject({ value: "+966571234567" }); // the number is still normalized
    expect(c).toMatchObject({ country: null, preferredCurrency: null, preferredLanguage: null });
  }, 120_000);
});
