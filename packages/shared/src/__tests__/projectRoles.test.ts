import { describe, expect, it } from "vitest";
import {
  isProjectAssignableKey,
  MAIN_ADMIN_CATEGORY,
  PERMISSIONS,
  PROJECT_ADMIN_CATEGORY,
  PROJECT_ADMIN_KEYS,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  PROJECT_LEAD_KEYS,
  projectMemberActions,
  READ_ONLY_PERMISSION_KEYS,
  resolveRoleKeys,
  sanitizeProjectRoleKeys,
} from "../index.js";

const ALL = PERMISSIONS.map((p) => p.key);
const sorted = (s: Iterable<string>) => [...s].sort();

/** Deterministic pseudo-random subsets of the catalogue (no Math.random: a failure must reproduce). */
function* subsets(count: number): Generator<string[]> {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  yield [];
  yield ALL;
  for (const p of PERMISSIONS) yield [p.key];
  for (let i = 0; i < count; i += 1) yield ALL.filter(() => next() < 0.4);
}

describe("what a project role may hold", () => {
  it("never a Main Admin key, an App Users / Permission Modules key, a project-administration key, or release-note editing", () => {
    for (const p of PERMISSIONS) {
      const platform = p.category === MAIN_ADMIN_CATEGORY || p.category === "Users & Permissions" || p.category === PROJECT_ADMIN_CATEGORY || p.key === "release_notes.manage";
      expect(isProjectAssignableKey(p.key), p.key).toBe(!platform);
    }
    expect(PROJECT_ASSIGNABLE_PERMISSIONS.some((p) => p.key === "projects.manage")).toBe(false);
    expect(isProjectAssignableKey("not.a.key")).toBe(false);
  });

  it("sanitizes a submitted key list: drops platform and unknown keys, de-duplicates, keeps catalogue order", () => {
    expect(sanitizeProjectRoleKeys(["messages.reply", "projects.manage", "users.create", "x.y", "messages.view", "messages.view"])).toEqual([
      "messages.view",
      "messages.reply",
    ]);
  });

  it("a Lead's keys are every project key plus the project's administration — no platform key", () => {
    for (const key of PROJECT_ADMIN_KEYS) expect(PROJECT_LEAD_KEYS).toContain(key);
    for (const key of ["projects.manage", "projects.view", "configuration.manage", "users.create", "permissions.edit", "release_notes.manage"]) {
      expect(PROJECT_LEAD_KEYS).not.toContain(key);
    }
  });

  it("the new administration keys stay out of the seeded Read Only role", () => {
    for (const key of PROJECT_ADMIN_KEYS) expect(READ_ONLY_PERMISSION_KEYS).not.toContain(key);
  });
});

describe("resolveRoleKeys — the compatibility guarantee", () => {
  it("a membership with no project role and no Lead flag (every row that exists today) is EXACTLY the global role", () => {
    for (const global of subsets(300)) {
      expect(sorted(resolveRoleKeys(global, { isLead: false, projectRoleKeys: null }))).toEqual(sorted(global));
    }
  });

  it("outside a project, and with the kill switch on, the global role is the answer whatever the membership says", () => {
    for (const global of subsets(50)) {
      expect(sorted(resolveRoleKeys(global, null))).toEqual(sorted(global));
      expect(sorted(resolveRoleKeys(global, { isLead: true, projectRoleKeys: ["messages.view"] }, true))).toEqual(sorted(global));
    }
  });

  it("a project role replaces the project part only; the platform part of the global role is kept", () => {
    const global = ["users.view", "projects.view", "automation_rules.delete", "messages.view", "release_notes.manage"];
    const result = resolveRoleKeys(global, { isLead: false, projectRoleKeys: ["messages.view", "messages.reply"] });
    expect(sorted(result)).toEqual(sorted(["users.view", "projects.view", "release_notes.manage", "messages.view", "messages.reply"]));
  });

  it("a project role can never smuggle a platform key in, even if one was stored", () => {
    const result = resolveRoleKeys([], { isLead: false, projectRoleKeys: ["projects.manage", "users.create", "project_members.manage", "messages.view"] });
    expect(sorted(result)).toEqual(["messages.view"]);
  });

  it("an empty project role means nothing in this project (it does not fall back to the global role)", () => {
    expect(sorted(resolveRoleKeys(["messages.view", "users.view"], { isLead: false, projectRoleKeys: [] }))).toEqual(["users.view"]);
  });

  it("a Main Admin keeps their global role in every project, whatever a membership row says", () => {
    const global = ["projects.manage", "projects.view", "messages.view", "automation_rules.delete"];
    expect(sorted(resolveRoleKeys(global, { isLead: false, projectRoleKeys: [] }))).toEqual(sorted(global));
    expect(sorted(resolveRoleKeys(global, { isLead: true, projectRoleKeys: ["messages.view"] }))).toEqual(sorted(global));
  });

  it("a Lead holds every project key and the project's administration, plus their own platform keys — never a Main Admin key", () => {
    const result = resolveRoleKeys(["users.view"], { isLead: true, projectRoleKeys: null });
    for (const key of PROJECT_LEAD_KEYS) expect(result.has(key)).toBe(true);
    expect(result.has("users.view")).toBe(true);
    expect(result.has("projects.manage")).toBe(false);
    expect(result.has("users.create")).toBe(false);
  });
});

describe("projectMemberActions — who a project's administrator may manage", () => {
  const base = { actorIsMainAdmin: false, isSelf: false, targetIsPrivileged: false, targetIsLead: false, targetIsProjectOnly: true };

  it("a Lead manages a member who exists for this project alone: role, removal, password and active", () => {
    expect(projectMemberActions(base)).toEqual({ changeRole: true, remove: true, resetPassword: true, setActive: true });
  });

  it("a Lead changes the role of, or removes, a member shared with another project — but never their login", () => {
    expect(projectMemberActions({ ...base, targetIsProjectOnly: false })).toEqual({ changeRole: true, remove: true, resetPassword: false, setActive: false });
  });

  it("nobody manages themselves, not even a Main Admin", () => {
    for (const actorIsMainAdmin of [false, true]) {
      expect(projectMemberActions({ ...base, actorIsMainAdmin, isSelf: true })).toEqual({ changeRole: false, remove: false, resetPassword: false, setActive: false });
    }
  });

  it("a Lead cannot touch another Lead or a privileged account; a Main Admin can", () => {
    for (const target of [{ targetIsLead: true }, { targetIsPrivileged: true }]) {
      expect(Object.values(projectMemberActions({ ...base, ...target })).some(Boolean)).toBe(false);
      expect(projectMemberActions({ ...base, ...target, actorIsMainAdmin: true })).toEqual({ changeRole: true, remove: true, resetPassword: true, setActive: true });
    }
  });
});
