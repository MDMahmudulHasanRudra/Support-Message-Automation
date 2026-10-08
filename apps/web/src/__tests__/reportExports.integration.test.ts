import "./helpers/requireTestDatabase";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";

/**
 * The report download routes, called as the browser calls them (REPORTS.md §2). Only the session
 * check is stubbed — the permission itself is the route's own `requireAccess`, covered by the browser
 * checks — so what is under test is what the files contain and how a too-large request is answered.
 */

vi.mock("@/server/authorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/authorize")>()),
  requireAccess: async () => ({ userId: "test", username: "test", email: "", name: "test" }),
}));

const { runWithProject } = await import("@/server/projectContext");
const reportExport = await import("@/app/p/[project]/api/reports/[report]/export/route");
const reportTableExport = await import("@/app/p/[project]/api/reports/[report]/table-export/route");
const teamTableExport = await import("@/app/p/[project]/api/team-report/table-export/route");

const inIsp = <T,>(fn: () => Promise<T>) => runWithProject({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" }, fn);
const PERIOD = "period=custom&from=2025-03-12&to=2025-03-13";
const url = (path: string) => `http://localhost/p/isp-digital${path}`;
const params = (report: string) => ({ params: Promise.resolve({ report }) });

afterAll(async () => {
  await rawPrisma.$disconnect();
});

describe("report file exports", () => {
  it("CSV is the Detailed table with its own columns, UTF-8 with a BOM", async () => {
    const res = await inIsp(() => reportExport.GET(new NextRequest(url(`/api/reports/missed/export?${PERIOD}&format=csv`)), params("missed")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the BOM Excel needs to read UTF-8
    expect(bytes.subarray(3).toString("utf8").split("\r\n")[0]).toBe("Group,Customer asked,Status,Customer's message,Waited,Target,Answered by,Answered,Charged to");
    expect(decodeURIComponent(res.headers.get("content-disposition") ?? "")).toContain("Missed Support");
  });

  it("Excel has Summary, Detailed and Breakdown sheets", async () => {
    const res = await inIsp(() => reportExport.GET(new NextRequest(url(`/api/reports/response-sla/export?${PERIOD}&format=xlsx`)), params("response-sla")));
    expect(res.status).toBe(200);
    const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    expect(book.SheetNames[0]).toBe("Summary");
    expect(book.SheetNames).toContain("Detailed");
    expect(book.SheetNames.filter((n) => n.startsWith("Breakdown"))).toHaveLength(2);
    const summary = XLSX.utils.sheet_to_json<{ Item: string }>(book.Sheets["Summary"]!).map((r) => r.Item);
    expect(summary).toEqual(expect.arrayContaining(["Report", "Period", "Groups", "WhatsApp account"]));
    expect(summary.some((item) => item.startsWith("Formula:"))).toBe(true);
  });

  it("an unknown report is a 404, not a crash", async () => {
    const res = await inIsp(() => reportExport.GET(new NextRequest(url(`/api/reports/nope/export?format=csv`)), params("nope")));
    expect(res.status).toBe(404);
  });
});

describe("table exports refuse an oversized request out loud", () => {
  const tooMany = { table: "waits", format: "csv", keys: Array.from({ length: 5001 }, (_, i) => `k${i}`) };

  for (const [name, call] of [
    ["a report's table", () => reportTableExport.POST(new NextRequest(url(`/api/reports/missed/table-export?${PERIOD}`), { method: "POST", body: JSON.stringify(tooMany) }), params("missed"))],
    ["the Team Report's table", () => teamTableExport.POST(new NextRequest(url(`/api/team-report/table-export?${PERIOD}`), { method: "POST", body: JSON.stringify({ ...tooMany, table: "groups" }) }))],
  ] as const) {
    it(name, async () => {
      const res = await inIsp(call);
      expect(res.status).toBe(413);
      expect(await res.text()).toMatch(/5,001 rows; a table export takes at most 5,000/);
    });
  }

  it("a request within the limit still exports", async () => {
    const res = await inIsp(() =>
      reportTableExport.POST(new NextRequest(url(`/api/reports/heatmap/table-export?${PERIOD}`), { method: "POST", body: JSON.stringify({ table: "grid", format: "csv", keys: ["0", "3"] }) }), params("heatmap")),
    );
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith("Sunday,")).toBe(true);
    expect(lines[2]!.startsWith("Wednesday,")).toBe(true);
  });
});
