import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argvUsesProfile } from "../provider/openwa/orphanBrowsers.js";

/**
 * An unfinished connect attempt must not leave its Chromium running.
 *
 * Observed on 24 Sep 2026: the first unscanned five-minute window orphaned its browser, every
 * retry then launched a second one against the same profile and died as "App Offline" after
 * ~3.5 minutes instead of five, and the orphan kept writing QR codes to the dashboard after the
 * last retry had given up. Pure: no database, no browser.
 */

describe("matching a browser to its account's profile", () => {
  const profile = "/app/sessions/_IGNORE_support-automation";

  it("matches the flag every process of that browser carries", () => {
    expect(
      argvUsesProfile(["/usr/lib/chromium/chromium", "--type=renderer", `--user-data-dir=${profile}`], profile),
    ).toBe(true);
  });

  it("never matches another account whose id merely starts the same way", () => {
    // A prefix match would kill a healthy second number's browser.
    expect(argvUsesProfile([`--user-data-dir=${profile}-2`], profile)).toBe(false);
    expect(argvUsesProfile([`--user-data-dir=/app/sessions/_IGNORE_support`], profile)).toBe(false);
  });

  it("ignores processes that are not browsers at all", () => {
    expect(argvUsesProfile(["node", "dist/index.js"], profile)).toBe(false);
    expect(argvUsesProfile([], profile)).toBe(false);
  });
});

describe("the provider kills what an unfinished attempt leaves behind", () => {
  const source = readFileSync(resolve(__dirname, "../provider/openwa/OpenWAProvider.ts"), "utf8");
  const openSession = source.slice(source.indexOf("private async openSession()"), source.indexOf("async disconnect()"));

  it("before launching, and before the lock files that would let a second browser start", () => {
    const kill = openSession.indexOf('await this.killOrphanedBrowsers("before launching")');
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(openSession.indexOf("await this.clearStaleChromiumLock();"));
    expect(kill).toBeLessThan(openSession.indexOf("create({"));
  });

  it("and in the failure path, because after the last retry there is no next launch", () => {
    const failure = openSession.slice(openSession.indexOf("} catch (err) {"), openSession.indexOf("} finally {"));
    expect(failure).toContain("killOrphanedBrowsers(");
    // Only for THIS attempt — never a newer one's browser.
    expect(failure).toMatch(/if \(generation === this\.attemptGeneration\) \{\s*await this\.killOrphanedBrowsers/);
  });

  it("and a code arriving with no attempt running is never published", () => {
    const write = source.slice(source.indexOf("private writeQrState("), source.indexOf("private async publishRenderedQr("));
    expect(write).toContain("if (!this.connecting) return;");
  });
});
