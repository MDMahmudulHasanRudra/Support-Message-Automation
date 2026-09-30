import { describe, expect, it } from "vitest";
import { PERMISSIONS, MAIN_ADMIN_CATEGORY } from "../permissions.js";
import { keysUnderLevel, levelAllows, PROJECT_ACCESS_LEVELS } from "../projectAccessLevels.js";

/**
 * Project access levels only ever take rights AWAY from a role (MAIN_ADMIN_WORKSPACE.md §4). These
 * tests are the rulebook: each level is checked against every key in the catalogue, so a key added
 * later is classified by the same rule rather than by accident.
 */

const ALL = PERMISSIONS.map((p) => p.key);
const exempt = (key: string) => {
  const category = PERMISSIONS.find((p) => p.key === key)!.category;
  return category === "Users & Permissions" || category === "Release Notes" || category === MAIN_ADMIN_CATEGORY;
};

describe("project access levels", () => {
  it("FULL — and a missing level, which every existing row has — is exactly the role", () => {
    for (const key of ALL) {
      expect(levelAllows("FULL", key), key).toBe(true);
      expect(levelAllows(null, key), key).toBe(true);
      expect(levelAllows(undefined, key), key).toBe(true);
    }
  });

  it("READ keeps only read keys of the project's modules", () => {
    for (const key of ALL.filter((k) => !exempt(k))) {
      expect(levelAllows("READ", key), key).toBe(key.endsWith(".view") || key.endsWith(".bulk_export"));
    }
    expect(levelAllows("READ", "messages.view")).toBe(true);
    expect(levelAllows("READ", "messages.reply")).toBe(false);
    expect(levelAllows("READ", "automation_rules.bulk_export")).toBe(true);
    expect(levelAllows("READ", "whatsapp.manage")).toBe(false);
  });

  it("WRITE keeps day-to-day work but never deleting or the project's automation and AI settings", () => {
    expect(levelAllows("WRITE", "messages.reply")).toBe(true);
    expect(levelAllows("WRITE", "automation_rules.edit")).toBe(true);
    expect(levelAllows("WRITE", "whatsapp.manage")).toBe(true);
    expect(levelAllows("WRITE", "bulk_messaging.manage")).toBe(true);
    expect(levelAllows("WRITE", "automation_rules.delete")).toBe(false);
    expect(levelAllows("WRITE", "settings.edit")).toBe(false);
    expect(levelAllows("WRITE", "ai_settings.edit")).toBe(false);
    for (const key of ALL.filter((k) => !exempt(k))) {
      if (key.endsWith(".delete")) expect(levelAllows("WRITE", key), key).toBe(false);
      if (levelAllows("READ", key)) expect(levelAllows("WRITE", key), `${key}: WRITE must include READ`).toBe(true);
    }
  });

  it("levels are ordered: each allows everything the one below it allows", () => {
    for (const key of ALL) {
      if (levelAllows("READ", key)) expect(levelAllows("WRITE", key), key).toBe(true);
      if (levelAllows("WRITE", key)) expect(levelAllows("FULL", key), key).toBe(true);
    }
  });

  it("keys that describe no project are not affected by a project's level", () => {
    for (const key of ["users.create", "permissions.edit", "security_settings.edit", "release_notes.manage", "projects.manage", "configuration.manage"]) {
      expect(levelAllows("READ", key), key).toBe(true);
    }
  });

  it("an unknown key is refused under any limited level, and a level never adds a key", () => {
    expect(levelAllows("READ", "made.up")).toBe(false);
    expect(levelAllows("WRITE", "made.up")).toBe(false);
    for (const level of PROJECT_ACCESS_LEVELS) {
      const role = ["messages.view", "messages.reply", "automation_rules.delete"];
      expect(keysUnderLevel(role, level).every((k) => role.includes(k)), level).toBe(true);
    }
    expect(keysUnderLevel(["messages.view", "messages.reply", "settings.edit"], "READ")).toEqual(["messages.view"]);
    expect(keysUnderLevel(["messages.view", "messages.reply", "settings.edit"], "WRITE")).toEqual(["messages.view", "messages.reply"]);
  });
});
