import { describe, expect, it } from "vitest";
import { activeSendSeconds, attributeOutbound } from "../outboundAttribution.js";

const row = (over: Partial<Parameters<typeof attributeOutbound>[0]>) => ({ actionType: "AUTO_REPLY", ruleId: null, hasAiDecision: false, idempotencyKey: null, ...over });

describe("attributeOutbound", () => {
  it("a chat reply is a human user's", () => {
    expect(attributeOutbound(row({ actionType: "MANUAL_REPLY", idempotencyKey: "manual-reply:g:1:abc" }))).toEqual({ senderType: "HUMAN_USER", source: "CHAT" });
  });
  it("a template test is a human user's, from the template test", () => {
    expect(attributeOutbound(row({ actionType: "MANUAL_REPLY", idempotencyKey: "template-test:AI_HANDOVER:g:1" }))).toEqual({ senderType: "HUMAN_USER", source: "TEMPLATE_TEST" });
  });
  it("a broadcast is a broadcast, never a conversation reply", () => {
    expect(attributeOutbound(row({ actionType: "GROUP_BROADCAST" })).senderType).toBe("BROADCAST");
  });
  it("the AI's reply is AI even without a rule", () => {
    expect(attributeOutbound(row({ hasAiDecision: true })).senderType).toBe("AI");
  });
  it("a rule's reply is rule automation", () => {
    expect(attributeOutbound(row({ ruleId: "r1" })).senderType).toBe("RULE_AUTOMATION");
  });
  it("an automated send with neither (handover mention, holding reply) is system — not a person", () => {
    expect(attributeOutbound(row({ idempotencyKey: "x:handover-mention" })).senderType).toBe("SYSTEM");
  });
  it("MANUAL_REPLY wins over any stray rule or AI link", () => {
    expect(attributeOutbound(row({ actionType: "MANUAL_REPLY", ruleId: "r1", hasAiDecision: true })).senderType).toBe("HUMAN_USER");
  });
});

describe("activeSendSeconds", () => {
  const M = 60_000;
  const T0 = Date.UTC(2026, 9, 5, 4, 0); // 10:00 Dhaka
  it("one send is zero", () => expect(activeSendSeconds([T0], 30 * M)).toBe(0));
  it("sends within the gap are one stretch", () => expect(activeSendSeconds([T0, T0 + 10 * M, T0 + 25 * M], 30 * M)).toBe(25 * 60));
  it("a quiet spell longer than the gap splits it", () => expect(activeSendSeconds([T0, T0 + 10 * M, T0 + 60 * M, T0 + 70 * M], 30 * M)).toBe(20 * 60));
  it("Dhaka midnight splits it", () => {
    const beforeMidnight = Date.UTC(2026, 9, 5, 17, 50); // 23:50 Dhaka
    expect(activeSendSeconds([beforeMidnight, beforeMidnight + 20 * M], 60 * M)).toBe(0);
  });
  it("order does not matter", () => expect(activeSendSeconds([T0 + 25 * M, T0], 30 * M)).toBe(25 * 60));
});
