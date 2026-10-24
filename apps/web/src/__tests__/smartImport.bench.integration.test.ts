import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS, SMART_IMPORT_LIMITS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Smart Bulk Import benchmark (SMART_IMPORT.md §7) — synthetic data only, the throwaway database only.
 * Skipped unless SMART_IMPORT_BENCH=1. Prints timings and heap growth; asserts only that the work
 * completes correctly, because times depend on the machine.
 */

const enabled = process.env.SMART_IMPORT_BENCH === "1";
let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let projectId = "";

vi.mock("@/server/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/auth")>()), requireSession: async () => current, getSession: async () => current }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const actions = await import("@/server/actions/smartImport");
const uploadRoute = await import("@/app/p/[project]/api/clients/import/smart-upload/route");
const processor = await import("@/server/smartImportProcessor");

let P: { id: string; slug: string; name: string; status: "ACTIVE" };
const inP = <T,>(fn: () => Promise<T>) => runWithProject(P, fn);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const timed = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const heap = process.memoryUsage().heapUsed;
  const t = performance.now();
  const r = await fn();
  console.log(`[bench] ${label}: ${Math.round(performance.now() - t)} ms, heap +${mb(process.memoryUsage().heapUsed - heap)} (rss ${mb(process.memoryUsage().rss)})`);
  return r;
};
function workbook(rows: number, noteChars: number): Buffer {
  const aoa: unknown[][] = [["Name", "Phone", "Email", "Company", "Note"]];
  for (let i = 0; i < rows; i++) aoa.push([`Bench Client ${i}`, `+88019${String(10000000 + i)}`, `bench${i}@example.com`, `Company ${i % 50}`, noteChars ? randomBytes(noteChars).toString("base64").slice(0, noteChars) : ""]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Clients");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
async function upload(bytes: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "bench.xlsx"));
  const res = await inP(() => uploadRoute.POST(new NextRequest("http://localhost/p/x/api/clients/import/smart-upload", { method: "POST", body: form })));
  return { status: res.status, body: (await res.json()) as { ok: boolean; jobId?: string; error?: string } };
}

describe.skipIf(!enabled)("Smart Bulk Import benchmark", () => {
  beforeAll(async () => {
    const def = (key: string) => PERMISSIONS.find((p) => p.key === key)!;
    const perms = await Promise.all(["clients.view", "clients.create", "clients.update", "clients.import"].map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: def(key).label, category: def(key).category }, update: {}, select: { id: true } })));
    const role = await rawPrisma.permissionModule.create({ data: { name: `Bench ${tag}`, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
    const u = await rawPrisma.user.create({ data: { username: `bench_${tag}`, email: `bench.${tag}@example.test`, name: "Bench", passwordHash: "x", permissionModuleId: role.id } });
    current = { userId: u.id, username: u.username, email: u.email!, name: "Bench" } as Session;
    const p = await createProjectWithDefaults({ name: `Bench ${tag}`, slug: `bench-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
    projectId = p.id;
    P = { id: p.id, slug: p.slug, name: `Bench ${tag}`, status: "ACTIVE" };
    await rawPrisma.projectAccess.createMany({ data: [{ projectId: p.id, userId: u.id }], skipDuplicates: true });
    for (const key of ["CLIENT_CENTER", "CLIENT_SMART_IMPORT"]) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
    forgetProjectFeatureStates();
  });
  afterAll(async () => {
    const where = { projectId };
    await rawPrisma.clientImportRow.deleteMany({ where });
    await rawPrisma.clientImportJob.deleteMany({ where });
    await rawPrisma.clientActivity.deleteMany({ where });
    await rawPrisma.clientChannel.deleteMany({ where });
    await rawPrisma.client.deleteMany({ where });
  });

  it("5,000 rows: upload, review, import", async () => {
    const bytes = workbook(5000, 0);
    console.log(`[bench] 5,000-row workbook: ${mb(bytes.length)}`);
    const up = await timed("upload + parse + stage 5,000 rows", () => upload(bytes));
    expect(up.status).toBe(200);
    const id = up.body.jobId!;
    const review = await timed("first review (full analysis)", () => inP(() => actions.loadSmartReview(id, {})));
    if ("error" in review) throw new Error(review.error);
    await timed("next page (cached)", () => inP(() => actions.loadSmartReview(id, { page: 50 })));
    expect(review.summary.ready).toBe(5000);
    await inP(() => actions.confirmSmartImport(id, { revision: review.revision, policy: "SKIP", acknowledged: [] }));
    await timed("import 5,000 clients (processor)", async () => {
      for (let i = 0; i < 500; i++) {
        const claimed = await processor.claimSmartImportJob();
        if (!claimed) break;
        await runWithProject(P, () => processor.processClaimedJob(claimed.id, 600_000));
      }
    });
    expect(await rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "COMPLETED", importedCount: 5000 });
  }, 1_800_000);

  it("a file near 15 MB", async () => {
    const bytes = workbook(5000, 2800);
    console.log(`[bench] large workbook: ${mb(bytes.length)} (limit ${mb(SMART_IMPORT_LIMITS.maxBytes)})`);
    const up = await timed("upload + parse + stage large file", () => upload(bytes));
    console.log(`[bench] large file result: ${up.status} ${up.body.error ?? "ok"}`);
    expect([200, 413, 422]).toContain(up.status);
  }, 600_000);
});
