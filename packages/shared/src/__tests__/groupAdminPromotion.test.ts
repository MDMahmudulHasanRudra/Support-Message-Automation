import { describe, expect, it } from "vitest";
import {
  classifyPromotionFailure,
  decideAdminPromotion,
  normalizeAdminTargetNumber,
  targetParticipantId,
} from "../groupAdminPromotion.js";

const T = "8801711000111";
const me = "8801999000999@c.us";

describe("target number", () => {
  it("accepts the international forms and the Bangladeshi local form as one person", () => {
    expect(normalizeAdminTargetNumber("+8801711000111")).toBe(T);
    expect(normalizeAdminTargetNumber("8801711000111")).toBe(T);
    expect(normalizeAdminTargetNumber("01711000111")).toBe(T);
    expect(normalizeAdminTargetNumber("+880 1711-000111")).toBe(T);
  });

  it("refuses what is not a number, exactly as Add Number to Groups does", () => {
    expect(normalizeAdminTargetNumber("")).toBeNull();
    expect(normalizeAdminTargetNumber("abc")).toBeNull();
    expect(normalizeAdminTargetNumber("12345")).toBeNull();
  });
});

describe("what to do in a group where the account is an admin", () => {
  it("promotes a member who is not an admin", () => {
    expect(decideAdminPromotion({ participantIds: [me, `${T}@c.us`], adminIds: [me], targetDigits: T })).toBe("PROMOTE");
  });

  it("leaves an existing admin alone", () => {
    expect(decideAdminPromotion({ participantIds: [me, `${T}@c.us`], adminIds: [me, `${T}@c.us`], targetDigits: T })).toBe("ALREADY_ADMIN");
  });

  it("never adds: a non-member is NOT_MEMBER when every id is a phone number", () => {
    expect(decideAdminPromotion({ participantIds: [me, "8801700000001@c.us"], adminIds: [me], targetDigits: T })).toBe("NOT_MEMBER");
  });

  it("cannot call somebody absent when the list holds LIDs", () => {
    expect(decideAdminPromotion({ participantIds: [me, "123456789012345@lid"], adminIds: [me], targetDigits: T })).toBe("CANNOT_VERIFY");
  });

  it("an empty member list or unreadable admin list is a failed read, not an answer", () => {
    expect(decideAdminPromotion({ participantIds: [], adminIds: [me], targetDigits: T })).toBe("READ_FAILED");
    expect(decideAdminPromotion({ participantIds: [me, `${T}@c.us`], adminIds: null, targetDigits: T })).toBe("READ_FAILED");
  });

  it("does not mistake a LID that happens to share digits for the number", () => {
    expect(decideAdminPromotion({ participantIds: [me, `${T}@lid`], adminIds: [me], targetDigits: T })).toBe("CANNOT_VERIFY");
  });

  it("promotes the exact id the member list carries", () => {
    expect(targetParticipantId([me, `${T}@c.us`], T)).toBe(`${T}@c.us`);
  });
});

describe("WhatsApp refusals", () => {
  it("documented codes settle the group's result; anything else may pass", () => {
    expect(classifyPromotionFailure("INSUFFICIENT_PERMISSIONS")).toBe("NOT_ACCOUNT_ADMIN");
    expect(classifyPromotionFailure("NOT_A_PARTICIPANT")).toBe("NOT_MEMBER");
    expect(classifyPromotionFailure("GROUP_DOES_NOT_EXIST")).toBe("GROUP_UNAVAILABLE");
    expect(classifyPromotionFailure("NOT_A_GROUP_CHAT")).toBe("GROUP_UNAVAILABLE");
    expect(classifyPromotionFailure("Protocol error: Target closed")).toBe("RETRY_OR_FAIL");
    expect(classifyPromotionFailure(null)).toBe("RETRY_OR_FAIL");
  });
});
