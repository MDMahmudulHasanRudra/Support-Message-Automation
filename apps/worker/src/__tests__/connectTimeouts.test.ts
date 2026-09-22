import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Four timeouts govern a connection attempt, three of them belonging to `@open-wa/wa-automate`, and
 * they are only correct RELATIVE TO EACH OTHER. Nothing enforced that, and on 23 Sep 2026 it cost a
 * live account its ability to link.
 *
 * The order that has to hold, innermost first:
 *
 *   authTimeout            the library's own `isAuthenticated()` race. Runs BEFORE a code is
 *                          requested, and again AFTER a scan while the session loads.
 *   + oorTimeout           on expiry it races `phoneIsOutOfReach` before finally throwing.
 *   < firstCode deadline   ours. "No code appeared, so nothing can be scanned — retry."
 *   < connect watchdog     ours. The outer bound, generous enough for a human to walk to a phone.
 *
 * With `authTimeout: 120` and `oorTimeout: 60` the longest LEGITIMATE codeless window was 180s,
 * while the first-code deadline stood at 150 — inside it. The deadline was cutting in while the
 * library was still working, abandoning attempts it had no evidence against and replacing the
 * library's accurate diagnosis ("App Offline", "Auth Timeout") with its own vaguer one.
 *
 * Asserted against the SOURCE rather than by importing the module, because the numbers are what is
 * being protected and importing would drag in `@open-wa/wa-automate` and a live provider. Pure: no
 * database, no browser.
 */

const PROVIDER = resolve(__dirname, "../provider/openwa/OpenWAProvider.ts");
const source = readFileSync(PROVIDER, "utf8");

/** Reads `const NAME = ... || <number>;` — the shape every tunable on this path uses. */
function numericConstant(name: string): number {
  const digits = source.match(new RegExp(`const ${name}\\s*=[^;]*?(\\d[\\d_]*)\\s*;`))?.[1];
  // Throwing beats returning NaN: a silently unparsed constant would make every comparison below
  // pass vacuously, which is the failure mode this whole file exists to prevent.
  if (!digits) throw new Error(`${name} is no longer declared as a plain numeric constant`);
  return Number(digits.replace(/_/g, ""));
}

describe("the connect timeouts are ordered, not merely chosen", () => {
  const authTimeoutSeconds = numericConstant("AUTH_TIMEOUT_SECONDS");
  const outOfReachSeconds = numericConstant("LIBRARY_OUT_OF_REACH_TIMEOUT_SECONDS");
  const firstCodeMs = numericConstant("MIN_FIRST_CODE_TIMEOUT_MS");

  it("the first-code deadline clears the library's own codeless window", () => {
    // The exact inequality that was false. 150_000 < (120 + 60) * 1000 fails here.
    const libraryCodelessWindowMs = (authTimeoutSeconds + outOfReachSeconds) * 1000;
    expect(firstCodeMs).toBeGreaterThan(libraryCodelessWindowMs);
  });

  it("and clears it by enough to cover the browser launch and page load before it", () => {
    // Observed 4-16s for Chromium plus ~10s for WhatsApp Web, on a host that was not busy. A
    // deadline that clears the library's window by seconds would still fire on a slow morning.
    const libraryCodelessWindowMs = (authTimeoutSeconds + outOfReachSeconds) * 1000;
    expect(firstCodeMs - libraryCodelessWindowMs).toBeGreaterThanOrEqual(45_000);
  });

  it("the outer watchdog is longer than the deadline inside it", () => {
    // Otherwise the watchdog fires first and the specific, actionable "no code appeared" error is
    // replaced by the generic "did not settle" one — losing the distinction between a session that
    // never offered anything to scan and a human who has not scanned yet.
    const watchdogMinutes = source.match(/WHATSAPP_CONNECT_WATCHDOG_MS\) \|\| (\d+) \* 60_000/)?.[1];
    expect(watchdogMinutes).toBeDefined();
    expect(Number(watchdogMinutes) * 60_000).toBeGreaterThan(firstCodeMs);
  });

  it("the post-scan settle window is long enough for a phone to finish a first sync", () => {
    // The library's own 120 was observed cutting off a pairing that had genuinely succeeded: the
    // scan was accepted and AUTHENTICATED recorded, then "Authentication timed out. Shutting
    // down." → "App Offline" two minutes later. A first sync is real work over a real network.
    expect(authTimeoutSeconds).toBeGreaterThanOrEqual(180);
  });

  it("but not so long that a broken pairing takes forever to report", () => {
    // Every second here is also a second a poisoned profile hangs before `shouldResetProfile()`
    // can act on it, and a second an operator watches nothing happen.
    expect(authTimeoutSeconds).toBeLessThanOrEqual(300);
  });
});

describe("a profile that cannot produce a code gets replaced rather than retried into", () => {
  it("the reset needs REPEATED codeless failures, not one", () => {
    // A browser that failed to launch also fails codelessly, and fixes itself next try. Wiping on
    // the first would force a re-scan over a blip.
    expect(source).toContain("const CODELESS_FAILURES_BEFORE_PROFILE_RESET = 2;");
    expect(source).toContain("if (this.codelessFailures < CODELESS_FAILURES_BEFORE_PROFILE_RESET) return false;");
  });

  it("and refuses while session data still exists", () => {
    // This is what makes it safe rather than merely effective: while `<sessionId>.data.json` is
    // present a restore is possible and the profile is what would restore it. Deleting it there
    // turns a recoverable session into a mandatory re-scan, which on an unattended worker means an
    // account down until somebody notices.
    expect(source).toContain("`${this.sessionId}.data.json`");
    expect(source).toMatch(/await access\(sessionDataFile\);[\s\S]{0,200}?return false;/);
  });

  it("logout removes the profile whether or not a client existed", () => {
    // The asymmetry this replaces: only the no-client branch cleaned up, so logging out a LIVE
    // session left a half-authenticated profile behind and no subsequent attempt could produce a
    // code. Exactly one call site, outside the if/else.
    const logout = source.slice(source.indexOf("async logout()"), source.indexOf("private async removeSessionProfile"));
    expect(logout.match(/await this\.removeSessionProfile\(\);/g)).toHaveLength(1);
    // After the client is released, not before — otherwise it races the browser for the same files.
    expect(logout.indexOf("this.client = null;")).toBeLessThan(logout.indexOf("await this.removeSessionProfile();"));
  });

  it("the removal retries, because ENOTEMPTY is the normal case here", () => {
    // Node's `rm` defaults to 0 retries. Chromium writes into its own IndexedDB while closing, so
    // a single pass deletes a subtree and then finds a file recreated underneath it — which is
    // precisely how the library's own attempt failed, as an unhandled rejection.
    expect(source).toContain("maxRetries: 5");
  });
});
