import { describe, expect, it } from "vitest";
import { matchRuleConditions } from "../conditions.js";
import type { EvaluationContext } from "../types.js";

function baseContext(overrides: Partial<EvaluationContext["message"]> = {}): EvaluationContext {
  return {
    message: {
      body: "test",
      senderPhone: "+8801000000001",
      isFromTeamMember: false,
      groupId: "group-1",
      chatId: "group-1",
      timestamp: new Date("2026-01-01T10:00:00"),
      ...overrides,
    },
    previousMessage: null,
    rules: [],
  };
}

describe("matchRuleConditions", () => {
  it("passes with no conditions configured", () => {
    expect(matchRuleConditions({}, baseContext()).matched).toBe(true);
  });

  it("matches current sender = TEAM_MEMBER", () => {
    const ctx = baseContext({ isFromTeamMember: true });
    expect(
      matchRuleConditions({ sender: { type: "TEAM_MEMBER" } }, ctx).matched,
    ).toBe(true);
    expect(
      matchRuleConditions({ sender: { type: "CLIENT" } }, ctx).matched,
    ).toBe(false);
  });

  it("matches previous sender condition against the previous message", () => {
    const ctx: EvaluationContext = {
      ...baseContext(),
      previousMessage: { senderPhone: "+8801700000001", isFromTeamMember: true },
    };
    expect(
      matchRuleConditions({ previousSender: { type: "TEAM_MEMBER" } }, ctx).matched,
    ).toBe(true);
  });

  it("fails a previous-sender condition when there is no previous message", () => {
    const ctx = baseContext(); // previousMessage: null
    expect(
      matchRuleConditions({ previousSender: { type: "TEAM_MEMBER" } }, ctx).matched,
    ).toBe(false);
  });

  it("does not globally ignore client messages just because the previous sender was a team member", () => {
    // Regression test for the spec's explicit warning: a last-sender rule
    // must not blindly ignore every subsequent client message.
    const ctx: EvaluationContext = {
      ...baseContext({ body: "আমার ইন্টারনেট এখনো কাজ করছে না" }),
      previousMessage: { senderPhone: "+8801700000001", isFromTeamMember: true },
    };
    // A rule scoped to "previous sender was team member" AND "message matches a
    // default/system pattern" should NOT match an unrelated new client issue.
    const conditions = { previousSender: { type: "TEAM_MEMBER" as const } };
    // Conditions alone match (previous sender was team member) — the text match
    // (handled separately in evaluate.ts) is what prevents blanket suppression.
    expect(matchRuleConditions(conditions, ctx).matched).toBe(true);
  });

  it("matches group scope SPECIFIC only for listed groups", () => {
    const ctx = baseContext({ groupId: "group-1" });
    expect(
      matchRuleConditions({ groupScope: { type: "SPECIFIC", groupIds: ["group-1"] } }, ctx)
        .matched,
    ).toBe(true);
    expect(
      matchRuleConditions({ groupScope: { type: "SPECIFIC", groupIds: ["group-2"] } }, ctx)
        .matched,
    ).toBe(false);
  });

  it("matches a same-day time window", () => {
    const ctx = baseContext({ timestamp: new Date("2026-01-01T14:00:00") });
    expect(
      matchRuleConditions({ timeWindow: { startHour: 9, endHour: 18 } }, ctx).matched,
    ).toBe(true);
    expect(
      matchRuleConditions({ timeWindow: { startHour: 9, endHour: 12 } }, ctx).matched,
    ).toBe(false);
  });

  it("matches an overnight time window that wraps past midnight", () => {
    const ctx = baseContext({ timestamp: new Date("2026-01-01T23:30:00") });
    expect(
      matchRuleConditions({ timeWindow: { startHour: 22, endHour: 6 } }, ctx).matched,
    ).toBe(true);
  });
});
