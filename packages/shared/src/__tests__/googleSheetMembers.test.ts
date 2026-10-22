import { describe, expect, it } from "vitest";
import {
  decideMemberChange,
  isSheetMemberRole,
  membersAt,
  NOT_ALLOWED_TO_STAFF,
  ONLY_MANAGER_FOR_LEADS,
  roleAt,
  roleCanWork,
  SHEET_MEMBER_ROLES,
  type MemberChange,
  type MemberChangeActor,
  type MemberPeriod,
} from "../googleSheetMembers.js";

const manager: MemberChangeActor = { hasManage: true, hasEdit: false, actorRole: null };
const lead: MemberChangeActor = { hasManage: false, hasEdit: true, actorRole: "LEAD" };

describe("roles", () => {
  it("leads and editors work on a sheet; a monitor never does", () => {
    expect(SHEET_MEMBER_ROLES).toEqual(["LEAD", "EDITOR", "MONITOR"]);
    expect(roleCanWork("LEAD")).toBe(true);
    expect(roleCanWork("EDITOR")).toBe(true);
    expect(roleCanWork("MONITOR")).toBe(false);
    expect(roleCanWork(null)).toBe(false);
    expect(isSheetMemberRole("OWNER")).toBe(false);
    expect(isSheetMemberRole("EDITOR")).toBe(true);
  });
});

describe("who may change a sheet's members", () => {
  const every: MemberChange[] = [
    { kind: "ADD", role: "LEAD" },
    { kind: "ADD", role: "EDITOR" },
    { kind: "ADD", role: "MONITOR" },
    { kind: "CHANGE_ROLE", fromRole: "LEAD", toRole: "EDITOR" },
    { kind: "CHANGE_ROLE", fromRole: "EDITOR", toRole: "LEAD" },
    { kind: "CHANGE_ROLE", fromRole: "EDITOR", toRole: "MONITOR" },
    { kind: "REMOVE", fromRole: "LEAD" },
    { kind: "REMOVE", fromRole: "MONITOR" },
  ];

  it("a manager may make any change", () => {
    for (const change of every) expect(decideMemberChange(manager, change)).toEqual({ allowed: true });
  });

  it("a Lead staffs editors and monitors", () => {
    expect(decideMemberChange(lead, { kind: "ADD", role: "EDITOR" }).allowed).toBe(true);
    expect(decideMemberChange(lead, { kind: "ADD", role: "MONITOR" }).allowed).toBe(true);
    expect(decideMemberChange(lead, { kind: "CHANGE_ROLE", fromRole: "EDITOR", toRole: "MONITOR" }).allowed).toBe(true);
    expect(decideMemberChange(lead, { kind: "REMOVE", fromRole: "EDITOR" }).allowed).toBe(true);
  });

  it("but never creates, re-roles or removes a Lead — themselves included", () => {
    for (const change of [
      { kind: "ADD", role: "LEAD" },
      { kind: "CHANGE_ROLE", fromRole: "EDITOR", toRole: "LEAD" },
      { kind: "CHANGE_ROLE", fromRole: "LEAD", toRole: "EDITOR" },
      { kind: "REMOVE", fromRole: "LEAD" },
    ] as MemberChange[]) {
      expect(decideMemberChange(lead, change)).toEqual({ allowed: false, reason: ONLY_MANAGER_FOR_LEADS });
    }
  });

  it("a Lead without the edit permission, an editor and a stranger may change nothing", () => {
    for (const actor of [
      { hasManage: false, hasEdit: false, actorRole: "LEAD" },
      { hasManage: false, hasEdit: true, actorRole: "EDITOR" },
      { hasManage: false, hasEdit: true, actorRole: "MONITOR" },
      { hasManage: false, hasEdit: true, actorRole: null },
    ] as MemberChangeActor[]) {
      expect(decideMemberChange(actor, { kind: "ADD", role: "EDITOR" })).toEqual({ allowed: false, reason: NOT_ALLOWED_TO_STAFF });
    }
  });
});

describe("a role at a moment", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 9, h));
  const periods: MemberPeriod[] = [
    { userId: "borhan", role: "EDITOR", startedAt: t(9), endedAt: t(12) },
    { userId: "borhan", role: "MONITOR", startedAt: t(12), endedAt: null },
    { userId: "rudra", role: "LEAD", startedAt: t(8), endedAt: null },
    { userId: "istiyak", role: "EDITOR", startedAt: t(9), endedAt: t(10) },
  ];

  it("follows each period, half-open: no gap and no overlap at a role change", () => {
    expect(roleAt(periods, "borhan", t(8))).toBeNull();
    expect(roleAt(periods, "borhan", t(9))).toBe("EDITOR");
    expect(roleAt(periods, "borhan", new Date(t(12).getTime() - 1))).toBe("EDITOR");
    expect(roleAt(periods, "borhan", t(12))).toBe("MONITOR");
    expect(roleAt(periods, "istiyak", t(10))).toBeNull();
    expect(roleAt(periods, "nobody", t(11))).toBeNull();
  });

  it("lists who was a member then", () => {
    expect(Object.fromEntries(membersAt(periods, t(9)))).toEqual({ borhan: "EDITOR", rudra: "LEAD", istiyak: "EDITOR" });
    expect(Object.fromEntries(membersAt(periods, t(13)))).toEqual({ borhan: "MONITOR", rudra: "LEAD" });
  });
});
