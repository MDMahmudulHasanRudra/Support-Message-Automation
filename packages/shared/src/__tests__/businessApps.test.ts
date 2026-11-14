import { describe, expect, it } from "vitest";
import {
  BUSINESS_APP_CONNECT_CLAIM_MS,
  BUSINESS_APP_KEYS,
  BUSINESS_APPS,
  BUSINESS_APP_STATUSES,
  canStartConnect,
  decideCapability,
  decideLaunch,
  installRefusal,
  sanitizeRequestedAddOns,
} from "../businessApps.js";

/**
 * The Business Apps rules (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md). The database CHECKs repeat the key and
 * status lists, and the web's integration suite proves the server applies these rules; this pins the rules.
 */

describe("the registry", () => {
  it("holds exactly the three apps, with no address or secret in any field", () => {
    expect(BUSINESS_APPS.map((a) => a.key)).toEqual([...BUSINESS_APP_KEYS]);
    for (const app of BUSINESS_APPS) {
      expect(JSON.stringify(app)).not.toMatch(/https?:\/\/|secret|token|password/i);
      expect(app.contractVersion).toBeTruthy();
    }
  });

  it("lets a project add only an installable app", () => {
    expect(installRefusal("commerce")).toBeNull();
    expect(installRefusal("education")).toMatch(/not available/);
    expect(installRefusal("travel")).toMatch(/not available/);
    expect(installRefusal("PRODUCT_CATALOG")).toBe("Unknown Business App.");
  });

  it("keeps a Create Project form's add-ons to known, installable keys, each once", () => {
    expect(sanitizeRequestedAddOns([])).toEqual([]);
    expect(sanitizeRequestedAddOns(["commerce", "commerce", "travel", "nope", 7, null])).toEqual(["commerce"]);
  });
});

describe("launching", () => {
  const base = { appKey: "commerce", projectStatus: "ACTIVE" as const, installation: { status: "ACTIVE" as const }, mayOpen: true };

  it("opens only an ACTIVE installation, for a person allowed to open it, in a project that operates", () => {
    expect(decideLaunch(base)).toEqual({ ok: true });
    for (const status of BUSINESS_APP_STATUSES.filter((s) => s !== "ACTIVE")) {
      expect(decideLaunch({ ...base, installation: { status } }).ok, status).toBe(false);
    }
    expect(decideLaunch({ ...base, installation: { status: "DISABLED" } })).toEqual({ ok: false, refusal: "DISABLED" });
    expect(decideLaunch({ ...base, installation: null })).toEqual({ ok: false, refusal: "NOT_INSTALLED" });
    expect(decideLaunch({ ...base, mayOpen: false })).toEqual({ ok: false, refusal: "NO_PERMISSION" });
    expect(decideLaunch({ ...base, projectStatus: "SUSPENDED" })).toEqual({ ok: false, refusal: "PROJECT_SUSPENDED" });
    expect(decideLaunch({ ...base, projectStatus: "ARCHIVED" })).toEqual({ ok: false, refusal: "PROJECT_ARCHIVED" });
    expect(decideLaunch({ ...base, appKey: "unknown" })).toEqual({ ok: false, refusal: "UNKNOWN_APP" });
  });
});

describe("capabilities", () => {
  const base = { appKey: "commerce", capability: "commerce.getCurrentPrice", projectStatus: "ACTIVE" as const, installationStatus: "ACTIVE" as const };

  it("allows a declared capability of an ACTIVE installation only", () => {
    expect(decideCapability(base)).toEqual({ allowed: true });
    expect(decideCapability({ ...base, installationStatus: "DISABLED" })).toEqual({ allowed: false, reason: "INSTALLATION_DISABLED" });
    expect(decideCapability({ ...base, installationStatus: "PENDING" })).toEqual({ allowed: false, reason: "INSTALLATION_PENDING" });
    expect(decideCapability({ ...base, installationStatus: null })).toEqual({ allowed: false, reason: "NOT_INSTALLED" });
    expect(decideCapability({ ...base, projectStatus: "SUSPENDED" })).toEqual({ allowed: false, reason: "PROJECT_SUSPENDED" });
    expect(decideCapability({ ...base, capability: "commerce.refundOrder" })).toEqual({ allowed: false, reason: "UNKNOWN_CAPABILITY" });
    expect(decideCapability({ ...base, appKey: "travel", capability: "commerce.getCurrentPrice" })).toEqual({ allowed: false, reason: "UNKNOWN_CAPABILITY" });
  });
});

describe("connecting", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  it("starts from waiting, a problem or connected; never from disabled; takes over only an abandoned claim", () => {
    expect(canStartConnect("PENDING", now, now)).toBe(true);
    expect(canStartConnect("ERROR", now, now)).toBe(true);
    expect(canStartConnect("ACTIVE", now, now)).toBe(true);
    expect(canStartConnect("DISABLED", now, now)).toBe(false);
    expect(canStartConnect("CONNECTING", now, now)).toBe(false);
    expect(canStartConnect("CONNECTING", new Date(now.getTime() - BUSINESS_APP_CONNECT_CLAIM_MS - 1), now)).toBe(true);
  });
});
