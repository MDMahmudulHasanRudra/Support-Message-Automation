import { describe, expect, it } from "vitest";
import { approvedModulesFor, modulesToWithdraw, validateApprovalReason, type ModuleApprovalRow } from "../moduleApprovals.js";
import { resolveModuleSelection } from "../projectModules.js";

const row = (over: Partial<ModuleApprovalRow>): ModuleApprovalRow => ({ customerId: "cust_a", targetProjectId: null, featureKey: "SOCIAL_STUDIO", revokedAt: null, ...over });

describe("approvedModulesFor", () => {
  it("a customer-wide approval covers every project of that customer", () => {
    expect(approvedModulesFor([row({})], { customerId: "cust_a", projectId: "p1" })).toEqual(["SOCIAL_STUDIO"]);
    expect(approvedModulesFor([row({})], { customerId: "cust_a", projectId: null })).toEqual(["SOCIAL_STUDIO"]);
  });

  it("a project approval covers that project only", () => {
    const rows = [row({ targetProjectId: "p1", featureKey: "WHATSAPP_AVATARS" })];
    expect(approvedModulesFor(rows, { customerId: "cust_a", projectId: "p1" })).toEqual(["WHATSAPP_AVATARS"]);
    expect(approvedModulesFor(rows, { customerId: "cust_a", projectId: "p2" })).toEqual([]);
    // A new project is not covered by another project's approval.
    expect(approvedModulesFor(rows, { customerId: "cust_a", projectId: null })).toEqual([]);
  });

  it("never reaches across customers, even when the row names the project", () => {
    const rows = [row({ customerId: "cust_b" }), row({ customerId: "cust_b", targetProjectId: "p1", featureKey: "CLIENT_SMART_IMPORT" })];
    expect(approvedModulesFor(rows, { customerId: "cust_a", projectId: "p1" })).toEqual([]);
    expect(approvedModulesFor(rows, { customerId: null, projectId: "p1" })).toEqual([]);
  });

  it("a revoked approval counts for nothing; another active one still does", () => {
    const revoked = row({ revokedAt: new Date() });
    expect(approvedModulesFor([revoked], { customerId: "cust_a", projectId: "p1" })).toEqual([]);
    expect(approvedModulesFor([revoked, row({ targetProjectId: "p1" })], { customerId: "cust_a", projectId: "p1" })).toEqual(["SOCIAL_STUDIO"]);
  });

  it("ignores a row for a module that is not approval-only", () => {
    expect(approvedModulesFor([row({ featureKey: "OMNICHANNEL" })], { customerId: "cust_a", projectId: "p1" })).toEqual([]);
  });
});

describe("modulesToWithdraw", () => {
  it("switches off an unapproved approval-only module and nothing else", () => {
    expect(modulesToWithdraw(["CLIENT_CENTER", "CLIENT_SMART_IMPORT", "WHATSAPP_CHAT"], [])).toEqual(["CLIENT_SMART_IMPORT"]);
    expect(modulesToWithdraw(["SOCIAL_STUDIO", "WHATSAPP_AVATARS", "WHATSAPP_CHAT", "CHAT_UI_V2"], ["SOCIAL_STUDIO"])).toEqual(["WHATSAPP_AVATARS"]);
  });

  it("leaves approved and plan-only modules alone", () => {
    expect(modulesToWithdraw(["SOCIAL_STUDIO", "OMNICHANNEL"], ["SOCIAL_STUDIO"])).toEqual([]);
  });

  it("leaves a configuration the resolver accepts (no module without its hard dependency)", () => {
    const enabled = ["CLIENT_CENTER", "CLIENT_SMART_IMPORT", "SOCIAL_STUDIO", "WHATSAPP_AVATARS", "WHATSAPP_CHAT", "CHAT_UI_V2"];
    const off = modulesToWithdraw(enabled, []);
    const after = enabled.filter((k) => !off.includes(k));
    const r = resolveModuleSelection({ requested: after, entitlement: { restricted: false, allowedFeatures: [], approvedFeatures: [] }, currentlyEnabled: after });
    expect(r.ok).toBe(true);
    expect(r.selected).toEqual([...after].sort());
  });
});

describe("validateApprovalReason", () => {
  it("requires a reason of sensible length", () => {
    expect(validateApprovalReason("Lab test passed")).toBeNull();
    expect(validateApprovalReason("  ")).not.toBeNull();
    expect(validateApprovalReason("x".repeat(501))).not.toBeNull();
  });
});
