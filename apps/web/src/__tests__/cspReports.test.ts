import { beforeEach, describe, expect, it } from "vitest";
import { blockedOrigin, pagePath, resetCspReportMemory, summariseCspReports } from "@/server/cspReports";

/**
 * P1-14: reports from the Report-Only CSP (api/csp-report). Only the directive, the blocked origin and the
 * page path are ever logged, each at most once per 10 minutes. Pure.
 */

beforeEach(() => resetCspReportMemory());

const legacy = (blocked: string, page = "https://app.example/p/acme/clients?token=SECRET") =>
  JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": blocked, "document-uri": page, "script-sample": "alert(document.cookie)" } });

describe("summariseCspReports", () => {
  it("reads the report-uri shape and keeps only directive, origin and path", () => {
    const [line] = summariseCspReports(legacy("https://cdn.evil.example/x.js?key=abc"));
    expect(line).toBe("[csp] report-only: script-src-elem would block https://cdn.evil.example on /p/acme/clients");
    expect(line).not.toMatch(/SECRET|key=abc|cookie/);
  });

  it("reads the Reporting API shape", () => {
    const body = JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://img.example/a.png", documentURL: "https://app.example/overview" } }]);
    expect(summariseCspReports(body)).toEqual(["[csp] report-only: img-src would block https://img.example on /overview"]);
  });

  it("writes each distinct report once per 10 minutes", () => {
    const t = 5_000_000;
    expect(summariseCspReports(legacy("inline"), t)).toHaveLength(1);
    expect(summariseCspReports(legacy("inline"), t + 60_000)).toHaveLength(0);
    expect(summariseCspReports(legacy("inline"), t + 10 * 60_000)).toHaveLength(1);
  });

  it("ignores anything that is not a report", () => {
    expect(summariseCspReports("not json")).toEqual([]);
    expect(summariseCspReports(JSON.stringify({ hello: "world" }))).toEqual([]);
    expect(summariseCspReports(JSON.stringify([{ type: "deprecation", body: {} }]))).toEqual([]);
  });
});

describe("blockedOrigin and pagePath", () => {
  it.each([
    ["inline", "inline"],
    ["eval", "eval"],
    ["data:image/png;base64,AAAA", "data"],
    ["blob:https://app.example/uuid", "blob"],
    ["https://x.example:8443/a?b=c", "https://x.example:8443"],
    ["", "unknown"],
    ["::not a url::", "other"],
  ])("%s -> %s", (input: string, expected: string) => {
    expect(blockedOrigin(input)).toBe(expected);
  });

  it("drops the query from the page", () => {
    expect(pagePath("https://app.example/p/acme/chat?contact=8801712345678")).toBe("/p/acme/chat");
  });
});
