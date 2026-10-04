import { describe, expect, it } from "vitest";
import { featureForPath, GENERIC_REPORT_IDS, PERMISSIONS, REPORT_CATALOGUE } from "@support-automation/shared";
import { navGroupsFor, navPermissionFor, REPORT_PAGES, reportPagesFor } from "@/app/p/[project]/(dashboard)/navigation";
import { REPORT_DEFINITION_IDS, reportPermission } from "@/server/reports";
import { workspaceTabsFor } from "@/lib/workspace";

/**
 * REPORTS.md §5: every report at /reports/<id> is reachable exactly where its existing permission
 * key and its project feature allow, and nowhere else — the card, the page, the export and the
 * workspace tabs all agree.
 */

const ALL_KEYS = new Set(PERMISSIONS.map((p) => p.key));

describe("report catalogue ⇄ pages", () => {
  it("every generic report has a builder, and every builder a catalogue entry", () => {
    expect([...REPORT_DEFINITION_IDS].sort()).toEqual([...GENERIC_REPORT_IDS].sort());
  });

  it("the card's permission is the page's permission", () => {
    for (const id of GENERIC_REPORT_IDS) {
      expect(navPermissionFor(`/reports/${id}`), id).toBe(reportPermission(id));
    }
    expect(reportPermission("duty-workload")).toBe("team_management.view");
    expect(GENERIC_REPORT_IDS.filter((id) => id !== "duty-workload").every((id) => reportPermission(id) === "support_activity.view")).toBe(true);
  });

  it("each report, its export and its table export belong to one project feature", () => {
    for (const id of GENERIC_REPORT_IDS) {
      const feature = id === "duty-workload" ? "TEAM_MANAGEMENT" : "TEAM_REPORTS";
      expect(featureForPath(`/reports/${id}`), id).toBe(feature);
      expect(featureForPath(`/api/reports/${id}/export`), id).toBe(feature);
      expect(featureForPath(`/api/reports/${id}/table-export`), id).toBe(feature);
    }
    // The hub itself belongs to no feature, as before.
    expect(featureForPath("/reports")).toBeNull();
  });

  it("the three existing reports keep their routes and their cards", () => {
    for (const href of ["/team-report", "/support-activity/reports", "/team-management/attendance"]) {
      expect(REPORT_PAGES.map((p) => p.href)).toContain(href);
    }
    expect(REPORT_PAGES).toHaveLength(REPORT_CATALOGUE.length);
  });
});

describe("who sees which card", () => {
  it("support activity only: the Team Report family, not the duty reports", () => {
    const hrefs = reportPagesFor(new Set(["support_activity.view"])).map((p) => p.href);
    expect(hrefs).toContain("/reports/response-sla");
    expect(hrefs).not.toContain("/reports/duty-workload");
    expect(hrefs).not.toContain("/team-management/attendance");
    expect(hrefs).toHaveLength(18);
  });

  it("team management only: the two duty reports", () => {
    expect(reportPagesFor(new Set(["team_management.view"])).map((p) => p.href).sort()).toEqual(["/reports/duty-workload", "/team-management/attendance"]);
  });

  it("a feature switched off removes its reports, and only those", () => {
    const off = reportPagesFor(ALL_KEYS, new Set(["TEAM_REPORTS"])).map((p) => p.href);
    expect(off.some((href) => href.startsWith("/reports/") && href !== "/reports/duty-workload")).toBe(false);
    expect(off).toContain("/reports/duty-workload");
    expect(off).toContain("/support-activity/reports");
    const teamOff = reportPagesFor(ALL_KEYS, new Set(["TEAM_MANAGEMENT"])).map((p) => p.href);
    expect(teamOff).not.toContain("/reports/duty-workload");
    expect(teamOff).toContain("/reports/missed");
  });

  it("no role gains or loses the All Reports entry it had", () => {
    for (const keys of [new Set<string>(), new Set(["messages.view"]), new Set(["support_activity.view"]), ALL_KEYS]) {
      const hasHub = navGroupsFor(keys).some((g) => g.links.some((l) => l.href === "/reports"));
      const couldBefore = keys.has("support_activity.view") || keys.has("team_management.view");
      expect(hasHub).toBe(couldBefore);
    }
  });

  it("in the Main Admin Workspace, a report is a tab only where its feature is on", () => {
    const projects = [
      { id: "a", slug: "isp-digital", name: "ISP Digital", status: "ACTIVE", disabledFeatures: [] },
      { id: "b", slug: "bizify", name: "Bizify", status: "ACTIVE", disabledFeatures: ["TEAM_REPORTS"] },
    ];
    const slugs = (path: string) => workspaceTabsFor(projects as never, path).map((p: { slug: string }) => p.slug);
    expect(slugs("/reports/response-sla")).toEqual(["isp-digital"]);
    expect(slugs("/reports/duty-workload")).toEqual(["isp-digital", "bizify"]);
  });
});
