import { describe, expect, it } from "vitest";
import { PROJECT_FEATURES } from "../projectFeatures.js";
import {
  BUILT_IN_MODULE_TEMPLATES,
  builtInModuleTemplate,
  enabledAiCapabilities,
  moduleDefinition,
  moduleDependencyCycles,
  moduleSelectionDiff,
  PROJECT_MODULES,
  removalImpact,
  resolveModuleSelection,
  templateModules,
  typeForSelection,
  type ModuleDefinition,
} from "../projectModules.js";

const OPEN = { restricted: false, allowedFeatures: [] };

describe("the module registry", () => {
  it("has exactly one available module per feature, reading the feature's own label, keys and routes", () => {
    const available = PROJECT_MODULES.filter((m) => m.status === "AVAILABLE");
    expect(available.map((m) => m.key).sort()).toEqual(PROJECT_FEATURES.map((f) => f.key).sort());
    for (const feature of PROJECT_FEATURES) {
      const m = moduleDefinition(feature.key)!;
      expect(m.featureKey).toBe(feature.key);
      expect(m.name).toBe(feature.label);
      expect(m.permissionKeys).toEqual(feature.permissionKeys);
      expect(m.routes).toEqual(feature.routes);
    }
  });

  it("never lets a planned module be a feature, and every dependency names a module", () => {
    for (const m of PROJECT_MODULES) {
      if (m.status === "PLANNED") expect(m.featureKey).toBeNull();
      for (const dep of m.dependencies) for (const k of dep.anyOf) expect(moduleDefinition(k), `${m.key} → ${k}`).toBeTruthy();
    }
  });

  it("has no hard dependency cycle, and finds one when there is", () => {
    expect(moduleDependencyCycles()).toEqual([]);
    const a = { ...moduleDefinition("CHAT_UI_V2")!, key: "A", dependencies: [{ kind: "HARD", anyOf: ["B"], why: "" }] } as ModuleDefinition;
    const b = { ...moduleDefinition("CHAT_UI_V2")!, key: "B", dependencies: [{ kind: "HARD", anyOf: ["A"], why: "" }] } as ModuleDefinition;
    expect(moduleDependencyCycles([a, b])).toEqual([["A", "B", "A"]]);
  });

  it("the Default template is exactly today's defaults, so existing projects are unchanged", () => {
    expect(templateModules("DEFAULT")).toEqual(PROJECT_FEATURES.filter((f) => f.defaultEnabled).map((f) => f.key).sort());
  });
});

describe("resolveModuleSelection", () => {
  it("adds a hard dependency automatically, and says why", () => {
    const r = resolveModuleSelection({ requested: ["CLIENT_SMART_IMPORT"], entitlement: OPEN });
    expect(r.ok).toBe(true);
    expect(r.selected).toEqual(["CLIENT_CENTER", "CLIENT_SMART_IMPORT"]);
    expect(r.autoAdded).toEqual([{ key: "CLIENT_CENTER", requiredBy: "CLIENT_SMART_IMPORT", why: expect.any(String) }]);
  });

  it("satisfies a one-of with the first alternative, and adds nothing when one is already chosen", () => {
    expect(resolveModuleSelection({ requested: ["INBOX_COLLABORATION"], entitlement: OPEN }).selected).toEqual(["INBOX_COLLABORATION", "WHATSAPP_CHAT"]);
    const viaOmni = resolveModuleSelection({ requested: ["INBOX_COLLABORATION", "OMNICHANNEL"], entitlement: OPEN });
    expect(viaOmni.selected).toEqual(["INBOX_COLLABORATION", "OMNICHANNEL"]);
    expect(viaOmni.autoAdded).toEqual([]);
  });

  it("shares one dependency between two modules and adds it once", () => {
    const r = resolveModuleSelection({ requested: ["CHAT_UI_V2", "WHATSAPP_AVATARS"], entitlement: OPEN });
    expect(r.selected).toEqual(["CHAT_UI_V2", "WHATSAPP_AVATARS", "WHATSAPP_CHAT"]);
    expect(r.autoAdded.map((a) => a.key)).toEqual(["WHATSAPP_CHAT"]);
  });

  it("offers recommended modules, and stops offering one the admin declined", () => {
    const offered = resolveModuleSelection({ requested: ["AI_REPLY"], entitlement: OPEN });
    expect(offered.selected).toEqual(["AI_REPLY"]);
    expect(offered.recommended.map((r) => r.key)).toEqual(["AI_LEARNING"]);
    const declined = resolveModuleSelection({ requested: ["AI_REPLY"], declined: ["AI_LEARNING"], entitlement: OPEN });
    expect(declined.ok).toBe(true);
    expect(declined.recommended).toEqual([]);
    expect(declined.declined).toEqual(["AI_LEARNING"]);
  });

  it("refuses unknown and planned modules", () => {
    const r = resolveModuleSelection({ requested: ["NOPE", "SOCIAL_MANAGEMENT"], entitlement: OPEN });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["NOT_AVAILABLE", "UNKNOWN_MODULE"]);
    expect(r.selected).toEqual([]);
  });

  it("refuses adding what the plan does not include, but keeps a module that was already on", () => {
    const plan = { restricted: true, allowedFeatures: ["WHATSAPP_CHAT"] };
    const added = resolveModuleSelection({ requested: ["WHATSAPP_CHAT", "OMNICHANNEL"], entitlement: plan });
    expect(added.ok).toBe(false);
    expect(added.issues).toEqual([expect.objectContaining({ code: "NOT_IN_PLAN", key: "OMNICHANNEL" })]);
    const kept = resolveModuleSelection({ requested: ["WHATSAPP_CHAT", "OMNICHANNEL"], entitlement: plan, currentlyEnabled: ["OMNICHANNEL"] });
    expect(kept.ok).toBe(true);
    expect(kept.grandfathered).toEqual(["OMNICHANNEL"]);
  });

  it("reports a hard dependency the plan does not include, instead of adding it", () => {
    const r = resolveModuleSelection({ requested: ["CLIENT_SMART_IMPORT"], entitlement: { restricted: true, allowedFeatures: [] } });
    // Smart Import is manual-only (never decided by a plan); Client Management is not, and is missing.
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ code: "DEPENDENCY_NOT_IN_PLAN", key: "CLIENT_SMART_IMPORT" })]);
    expect(r.issues).toHaveLength(1);
  });

  it("never lets a plan hold back a manual-only module", () => {
    const r = resolveModuleSelection({ requested: ["WHATSAPP_AVATARS", "WHATSAPP_CHAT"], entitlement: { restricted: true, allowedFeatures: ["WHATSAPP_CHAT"] } });
    expect(r.ok).toBe(true);
  });

  it("is deterministic whatever order the browser sends", () => {
    const a = resolveModuleSelection({ requested: ["AI_COPILOT", "CLIENT_SMART_IMPORT", "UNIFIED_REPORTING"], entitlement: OPEN });
    const b = resolveModuleSelection({ requested: ["UNIFIED_REPORTING", "CLIENT_SMART_IMPORT", "AI_COPILOT"], entitlement: OPEN });
    expect(a).toEqual(b);
  });

  it("a removed hard dependency comes back: an invalid state cannot be resolved", () => {
    const r = resolveModuleSelection({ requested: ["CLIENT_SMART_IMPORT"], entitlement: OPEN, currentlyEnabled: ["CLIENT_CENTER", "CLIENT_SMART_IMPORT"] });
    expect(r.selected).toContain("CLIENT_CENTER");
  });
});

describe("removalImpact", () => {
  it("lists every module that would lose a hard dependency, transitively", () => {
    expect(removalImpact(["CLIENT_CENTER", "CLIENT_SMART_IMPORT", "WHATSAPP_CHAT"], "CLIENT_CENTER")).toEqual(["CLIENT_SMART_IMPORT"]);
    expect(removalImpact(["TEAM_REPORTS", "UNIFIED_REPORTING"], "TEAM_REPORTS")).toEqual(["UNIFIED_REPORTING"]);
  });

  it("keeps a one-of dependent while another alternative remains", () => {
    expect(removalImpact(["INBOX_COLLABORATION", "OMNICHANNEL", "WHATSAPP_CHAT"], "WHATSAPP_CHAT")).toEqual([]);
    expect(removalImpact(["AI_COPILOT", "INBOX_COLLABORATION", "WHATSAPP_CHAT"], "WHATSAPP_CHAT")).toEqual(["AI_COPILOT", "INBOX_COLLABORATION"]);
  });

  it("removing a recommended module removes nothing else", () => {
    expect(removalImpact(["AI_LEARNING", "AI_REPLY"], "AI_LEARNING")).toEqual([]);
  });
});

describe("project types", () => {
  it("records a base type when the selection is its template, otherwise Custom Mix with that base", () => {
    expect(typeForSelection(templateModules("DEFAULT"), null)).toEqual({ projectType: "DEFAULT", baseType: "DEFAULT" });
    expect(typeForSelection(templateModules("ECOMMERCE"), "ECOMMERCE")).toEqual({ projectType: "ECOMMERCE", baseType: "ECOMMERCE" });
    // E-commerce plus the Default Team Management: Custom Mix (E-commerce base), not a conversion.
    expect(typeForSelection([...templateModules("ECOMMERCE"), "TEAM_MANAGEMENT"], "ECOMMERCE")).toEqual({ projectType: "CUSTOM_MIX", baseType: "ECOMMERCE" });
  });

  it("the diff names exactly what changes", () => {
    expect(moduleSelectionDiff(["A", "B"], ["B", "C"])).toEqual({ added: ["C"], removed: ["A"] });
  });

  it("AI capabilities follow what is on, never the type label", () => {
    expect(enabledAiCapabilities(["WHATSAPP_CHAT"])).toEqual([]);
    expect(enabledAiCapabilities(["AI_COPILOT", "AI_REPLY"])).toContain("Draft a reply");
    // Orders without Courier Management: the AI must not claim delivery tracking (Custom Mix rule).
    expect(enabledAiCapabilities(["ORDERS", "PRODUCT_CATALOG"]).some((c) => /delivery/i.test(c))).toBe(false);
    expect(enabledAiCapabilities(["ORDERS", "PRODUCT_CATALOG", "COURIER"]).some((c) => /delivery/i.test(c))).toBe(true);
  });
});

describe("built-in templates", () => {
  it("every built-in resolves exactly as written: nothing added, nothing unavailable, nothing unknown", () => {
    for (const t of BUILT_IN_MODULE_TEMPLATES) {
      const r = resolveModuleSelection({ requested: t.modules, entitlement: OPEN });
      expect(r.ok, t.key).toBe(true);
      expect(r.autoAdded, t.key).toEqual([]);
      expect(r.selected, t.key).toEqual([...t.modules].sort());
    }
  });

  it("the Default and E-commerce built-ins are the type templates, and keys are unique", () => {
    expect(builtInModuleTemplate("builtin:DEFAULT")!.modules).toEqual(templateModules("DEFAULT"));
    expect(builtInModuleTemplate("builtin:ECOMMERCE")!.modules).toEqual(templateModules("ECOMMERCE"));
    expect(new Set(BUILT_IN_MODULE_TEMPLATES.map((t) => t.key)).size).toBe(BUILT_IN_MODULE_TEMPLATES.length);
  });
});
