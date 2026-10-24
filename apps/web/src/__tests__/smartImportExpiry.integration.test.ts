import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { autoMapColumns, PERMISSIONS, SMART_REVIEW_ORDER } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Smart Bulk Import — the complete review grid and flexible expiry (SMART_IMPORT.md §11), against a real
 * database: every field shown in the template's order; problems on the cell they concern; a correction
 * revalidated; and every expiry form landing as ONE consistent subscription (or a recorded expiry,
 * never an invented start date) — with no duplicate term and no billing record.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/auth")>()), requireSession: async () => current, getSession: async () => current }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const actions = await import("@/server/actions/smartImport");
const uploadRoute = await import("@/app/p/[project]/api/clients/import/smart-upload/route");
const processor = await import("@/server/smartImportProcessor");
const { IMPORT_TEMPLATE_COLUMNS } = await import("@/server/clientImportTemplate");

let P: { id: string; slug: string; name: string; status: "ACTIVE" };
const people = {} as Record<"seller" | "plain", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(P, fn);
};

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"), "utf8");
async function uploaded(rows: string[][], person = people.seller): Promise<string> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(csv(rows))], "expiry.csv"));
  const res = await as(person, () => uploadRoute.POST(new NextRequest("http://localhost/p/x/api/clients/import/smart-upload", { method: "POST", body: form })));
  const body = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
  return body.jobId!;
}
const review = (id: string, query: Parameters<typeof actions.loadSmartReview>[1] = {}, person = people.seller) =>
  as(person, async () => {
    const r = await actions.loadSmartReview(id, query);
    if ("error" in r) throw new Error(r.error);
    return r;
  });
const mapping = async (id: string, raw: unknown) => {
  const { revision } = await review(id);
  return as(people.seller, () => actions.saveSmartMapping(id, revision, raw));
};
async function importNow(id: string, person = people.seller, acknowledged: string[] = []) {
  const r = await review(id, {}, person);
  const confirmed = await as(person, () => actions.confirmSmartImport(id, { revision: r.revision, policy: "UPDATE", acknowledged }));
  expect(confirmed, confirmed.message).toMatchObject({ ok: true });
  for (let i = 0; i < 20; i++) {
    const claimed = await processor.claimSmartImportJob();
    if (!claimed) break;
    await runWithProject(P, () => processor.processClaimedJob(claimed.id, 120_000));
  }
}
const clientNamed = (name: string) => rawPrisma.client.findFirstOrThrow({ where: { projectId: P.id, name }, include: { subscriptions: true } });
const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

beforeAll(async () => {
  const base = ["clients.view", "clients.create", "clients.update", "clients.import"];
  people.seller = await user("ExpirySeller", await role("Expiry seller", [...base, "clients.manage_subscriptions"]));
  people.plain = await user("ExpiryPlain", await role("Expiry plain", base));
  const p = await createProjectWithDefaults({ name: `Expiry ${tag}`, slug: `expiry-${tag}`, status: "ACTIVE", creatorUserId: people.seller.userId }, rawPrisma);
  ids.projects.push(p.id);
  P = { id: p.id, slug: p.slug, name: `Expiry ${tag}`, status: "ACTIVE" };
  await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
  for (const key of ["CLIENT_CENTER", "CLIENT_SMART_IMPORT"]) {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
  }
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientImportRow.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.client.updateMany({ where, data: { currentSubscriptionId: null } });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("the review grid", () => {
  it("shows every import field, in the official template's order, mapped or not", async () => {
    const id = await uploaded([["Name"], ["Only A Name"]]);
    const r = await review(id);
    expect(r.shownFields).toEqual([...SMART_REVIEW_ORDER]);
    // The order is the template's: pinned against the template itself, header by header.
    const templateOrder = IMPORT_TEMPLATE_COLUMNS.map((c) => Object.entries(autoMapColumns([c.header])).find(([, v]) => v === c.header)?.[0]);
    expect(r.shownFields).toEqual(templateOrder);
    expect(Object.keys(r.rows[0]!.values)).toEqual([...SMART_REVIEW_ORDER]);
    expect(r.rows[0]!.values.email).toBe("");
  });

  it("an empty, unmapped cell can be filled; problems sit on their own cell; a fix revalidates", async () => {
    const id = await uploaded([["Name", "Phone"], ["Cell Test", "123"]]);
    let r = await review(id);
    const row = r.rows[0]!;
    expect(row.status).toBe("INVALID");
    expect(row.issues.filter((i) => i.severity === "error").map((i) => i.field)).toEqual(["phone"]);
    await as(people.seller, () => actions.editSmartRow(id, row.id, "email", "cell@example.com"));
    await as(people.seller, () => actions.editSmartRow(id, row.id, "phone", "01711000123"));
    r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "NEW", issues: [], values: { email: "cell@example.com", phone: "01711000123" }, edited: ["phone", "email"] });
    // Undo one correction: back to the mapped (invalid) value.
    await as(people.seller, () => actions.resetSmartCell(id, row.id, "phone"));
    r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "INVALID", values: { phone: "123", email: "cell@example.com" } });
  });
});

describe("expiry → subscription", () => {
  it("monthly, nine-month and yearly terms calculate on the calendar", async () => {
    const id = await uploaded([
      ["Name", "Service", "Start Date", "Duration", "Duration Unit"],
      ["Monthly", "IPTV", "2026-10-24", "1", "Month"],
      ["Nine", "IPTV", "24/10/2026", "9", "Months"],
      ["Yearly", "IPTV", "2026-10-24", "1", "Year"],
      ["Month End", "IPTV", "2027-01-31", "1", "Month"],
    ]);
    const r = await review(id);
    expect(r.rows.map((x) => [x.values.name, x.values.expiryDate, x.expiryBasis])).toEqual([
      ["Monthly", "2026-11-24", expect.stringMatching(/Start date \+ 1 month/)],
      ["Nine", "2027-07-24", expect.stringMatching(/9 months/)],
      ["Yearly", "2027-10-24", expect.stringMatching(/1 year/)],
      ["Month End", "2027-02-28", expect.any(String)],
    ]);
    await importNow(id);
    expect((await clientNamed("Nine")).subscriptions).toEqual([expect.objectContaining({ service: "IPTV", durationValue: 9, durationUnit: "MONTH" })]);
    expect(day((await clientNamed("Nine")).subscriptions[0]!.endDate)).toBe("2027-07-24");
    expect(day((await clientNamed("Month End")).subscriptions[0]!.endDate)).toBe("2027-02-28");
  });

  it("separate year / month / day columns compose the expiry; an impossible day is a cell error", async () => {
    const id = await uploaded([
      ["Name", "Service", "Start Date", "Expire Year", "Expire Month", "Expire Day"],
      ["Parts OK", "IPTV", "2026-07-24", "2027", "07", "24"],
      ["Parts Bad", "IPTV", "2026-07-24", "2027", "02", "29"],
    ]);
    const r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "NEW", values: { expiryDate: "2027-07-24" } });
    expect(r.rows[1]!.issues).toEqual([expect.objectContaining({ field: "expiryDate", severity: "error", message: expect.stringMatching(/no day 29/) })]);
    await importNow(id, people.seller, ["MOSTLY_INVALID"]);
    expect(day((await clientNamed("Parts OK")).subscriptions[0]!.endDate)).toBe("2027-07-24");
    expect(await rawPrisma.client.count({ where: { projectId: P.id, name: "Parts Bad" } })).toBe(0);
  });

  it("an expiry with no start date is recorded on the client — no start invented, no term, no billing", async () => {
    const id = await uploaded([["Client Name", "Service", "Expiry Date"], ["ABC Network", "IPTV", "2027-07-24"]]);
    const r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "NEW", recordedExpiry: true, values: { expiryDate: "2027-07-24", startDate: "" } });
    expect(r.rows[0]!.issues).toEqual([expect.objectContaining({ field: "expiryDate", severity: "warning" })]);
    await importNow(id);
    const c = await clientNamed("ABC Network");
    expect(c.subscriptions).toEqual([]);
    expect(c.currentSubscriptionId).toBeNull();
    expect([day(c.recordedExpiryDate), c.recordedExpiryService]).toEqual(["2027-07-24", "IPTV"]);
    expect(await rawPrisma.clientDue.count({ where: { clientId: c.id } })).toBe(0);
  });

  it("without the subscription right, neither a term nor a recorded expiry is written", async () => {
    const id = await uploaded([["Name", "Service", "Expiry Date"], ["No Right Ltd", "IPTV", "2027-07-24"]], people.plain);
    await importNow(id, people.plain);
    const c = await clientNamed("No Right Ltd");
    expect([c.recordedExpiryDate, c.subscriptions.length]).toEqual([null, 0]);
  });

  it("a conflicting expiry is never silently accepted; a choice resolves it consistently", async () => {
    const rows = [["Name", "Service", "Start Date", "Duration", "Duration Unit", "Expiry Date"], ["Conflict Co", "IPTV", "2026-10-24", "9", "Months", "2027-08-24"]];
    const id = await uploaded(rows);
    let r = await review(id);
    expect(r.rows[0]!.status).toBe("INVALID");
    expect(r.rows[0]!.issues.map((i) => i.field)).toEqual(["expiryDate", "duration"]);
    const { revision } = r;
    expect(await as(people.seller, () => actions.confirmSmartImport(id, { revision, policy: "SKIP", acknowledged: [] }))).toMatchObject({ ok: false });
    // The person chooses: the file's expiry. The term then ends there, with no duration that contradicts it.
    const current = (await review(id)).revision;
    const fields = { name: { mode: "source", column: "Name" }, service: { mode: "source", column: "Service" }, startDate: { mode: "source", column: "Start Date" }, duration: { mode: "source", column: "Duration" }, durationUnit: { mode: "source", column: "Duration Unit" }, expiryDate: { mode: "source", column: "Expiry Date" } };
    await as(people.seller, () => actions.saveSmartMapping(id, current, { fields, options: { expiryConflict: "SOURCE" } }));
    r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "NEW", values: { expiryDate: "2027-08-24" } });
    await importNow(id);
    const term = (await clientNamed("Conflict Co")).subscriptions;
    expect(term).toHaveLength(1);
    expect([day(term[0]!.endDate), term[0]!.durationValue]).toEqual(["2027-08-24", null]);
  });

  it("typing an expiry on a row with a duration clears the duration, and says so", async () => {
    const id = await uploaded([["Name", "Service", "Start Date", "Duration"], ["Typed Expiry", "IPTV", "2026-10-24", "1"]]);
    const row = (await review(id)).rows[0]!;
    const saved = await as(people.seller, () => actions.editSmartRow(id, row.id, "expiryDate", "2027-01-31"));
    expect(saved.message).toMatch(/duration on this row was cleared/);
    const after = (await review(id)).rows[0]!;
    expect(after).toMatchObject({ status: "NEW", values: { expiryDate: "2027-01-31", duration: "" } });
  });

  it("month + year: kept in review by default, the last day only when chosen", async () => {
    const id = await uploaded([["Name", "Service", "Start Date", "Expiry"], ["Month Only", "IPTV", "2026-07-01", "July 2027"]]);
    let r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "INVALID", values: { expiryDate: "July 2027" } });
    const fields = { name: { mode: "source", column: "Name" }, service: { mode: "source", column: "Service" }, startDate: { mode: "source", column: "Start Date" }, expiryDate: { mode: "source", column: "Expiry" } };
    expect(await mapping(id, { fields, options: { expiryMode: "MONTH_YEAR", monthYearPolicy: "LAST_DAY" } })).toMatchObject({ ok: true });
    r = await review(id);
    expect(r.rows[0]).toMatchObject({ status: "NEW", values: { expiryDate: "2027-07-31" } });
    await importNow(id);
    expect(day((await clientNamed("Month Only")).subscriptions[0]!.endDate)).toBe("2027-07-31");
  });

  it("re-importing the same term adds no duplicate subscription", async () => {
    const rows = [["Name", "Phone", "Service", "Start Date", "Duration"], ["Repeat Term", "01711000999", "IPTV", "2026-10-24", "3"]];
    await importNow(await uploaded(rows));
    await importNow(await uploaded(rows));
    expect((await clientNamed("Repeat Term")).subscriptions).toHaveLength(1);
  });
});
