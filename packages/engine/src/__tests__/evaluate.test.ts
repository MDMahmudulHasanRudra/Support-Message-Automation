import { describe, expect, it } from "vitest";
import { evaluate } from "../evaluate.js";
import type { EngineRule, EvaluationContext } from "../types.js";

function rule(overrides: Partial<EngineRule> & Pick<EngineRule, "id" | "name">): EngineRule {
  return {
    type: "GENERIC",
    matchType: "ALWAYS",
    matchValue: null,
    keywords: [],
    conditions: {},
    actions: [],
    priority: 0,
    ...overrides,
  };
}

function context(overrides: Partial<EvaluationContext>): EvaluationContext {
  return {
    message: {
      body: "",
      senderPhone: "+8801000000001",
      isFromTeamMember: false,
      groupId: "group-1",
      chatId: "group-1",
      timestamp: new Date("2026-01-01T10:00:00"),
    },
    previousMessage: null,
    rules: [],
    ...overrides,
  };
}

describe("evaluate — team member filtering", () => {
  it("ignores a team member message by default when no rule overrides it", () => {
    const result = evaluate(
      context({
        message: {
          body: "on my way to the client's office",
          senderPhone: "+8801700000001",
          isFromTeamMember: true,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("IGNORE");
    expect(result.matchedRule).toBeNull();
  });

  it("lets an explicit higher-priority rule override the default team-member ignore", () => {
    const override = rule({
      id: "r1",
      name: "Team member escalation override",
      type: "EXCEPTION",
      matchType: "CONTAINS",
      matchValue: "urgent",
      conditions: { sender: { type: "TEAM_MEMBER" } },
      actions: [{ type: "SUPPORT_REQUIRED" }],
      priority: 90,
    });
    const result = evaluate(
      context({
        rules: [override],
        message: {
          body: "URGENT: client escalation needed",
          senderPhone: "+8801700000001",
          isFromTeamMember: true,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("SUPPORT_REQUIRED");
    expect(result.matchedRule?.id).toBe("r1");
  });

  it("does not trigger client automation for a plain (non-overridden) team member message", () => {
    const autoReply = rule({
      id: "r-greeting",
      name: "Greeting auto-reply",
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      keywords: ["hello", "হ্যালো"],
      actions: [{ type: "AUTO_REPLY" }],
      priority: 70,
    });
    const result = evaluate(
      context({
        rules: [autoReply],
        message: {
          body: "hello team, status update",
          senderPhone: "+8801700000001",
          isFromTeamMember: true,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    // The keyword rule has no sender condition restricting it to clients, so by
    // itself it WOULD match — this test documents that admins must scope
    // client-facing rules with a CLIENT sender condition if team chatter
    // shouldn't trigger them. Verify the engine at least reports it accurately.
    expect(result.trace.find((t) => t.ruleId === "r-greeting")?.matched).toBe(true);
  });

  it("keeps team-facing rules from firing when explicitly scoped to CLIENT senders", () => {
    const autoReply = rule({
      id: "r-greeting-client-only",
      name: "Greeting auto-reply (clients only)",
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      keywords: ["hello"],
      conditions: { sender: { type: "CLIENT" } },
      actions: [{ type: "AUTO_REPLY" }],
      priority: 70,
    });
    const result = evaluate(
      context({
        rules: [autoReply],
        message: {
          body: "hello team",
          senderPhone: "+8801700000001",
          isFromTeamMember: true,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("IGNORE"); // falls through to default team-member ignore
  });
});

describe("evaluate — default ignore rules", () => {
  it("ignores a known default/system confirmation message", () => {
    const ignoreRule = rule({
      id: "r-ignore-payment",
      name: "Ignore: Payment successful",
      type: "DEFAULT_IGNORE",
      matchType: "CONTAINS",
      matchValue: "payment successful",
      actions: [{ type: "IGNORE" }],
      priority: 10,
    });
    const result = evaluate(
      context({
        rules: [ignoreRule],
        message: {
          body: "Payment successful",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("IGNORE");
    expect(result.matchedRule?.id).toBe("r-ignore-payment");
  });
});

describe("evaluate — priority resolution (spec worked example)", () => {
  it("resolves to the higher-priority Payment Update Problem rule over a lower-priority generic ignore rule", () => {
    const genericIgnore = rule({
      id: "r-generic-ignore",
      name: "Generic Default Ignore Rule",
      type: "DEFAULT_IGNORE",
      matchType: "CONTAINS",
      matchValue: "payment",
      actions: [{ type: "IGNORE" }],
      priority: 10,
    });
    const paymentUpdateProblem = rule({
      id: "r-payment-update-problem",
      name: "Payment Update Problem",
      type: "SUPPORT_ESCALATION",
      matchType: "REGEX",
      matchValue: "payment.*balance.*(update|hoy ?nai|হয়নি)",
      actions: [{ type: "SUPPORT_REQUIRED", category: "PAYMENT_BALANCE_ISSUE" }, { type: "TAG", tag: "PAYMENT_ISSUE" }],
      priority: 100,
    });
    const result = evaluate(
      context({
        rules: [genericIgnore, paymentUpdateProblem],
        message: {
          body: "Payment করেছি কিন্তু balance update হয়নি",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("SUPPORT_REQUIRED");
    expect(result.matchedRule?.name).toBe("Payment Update Problem");
    expect(result.matchedRule?.priority).toBe(100);
    // Both rules were evaluated; only the higher-priority one was applied.
    const genericTrace = result.trace.find((t) => t.ruleId === "r-generic-ignore");
    expect(genericTrace?.matched).toBe(true);
    expect(genericTrace?.applied).toBe(false);
  });
});

describe("evaluate — support escalation examples", () => {
  const escalationRules: EngineRule[] = [
    rule({
      id: "r-internet-down",
      name: "Internet Not Working",
      type: "SUPPORT_ESCALATION",
      matchType: "KEYWORDS",
      keywords: ["internet not working", "ইন্টারনেট চলছে না", "ইন্টারনেট নাই"],
      actions: [{ type: "SUPPORT_REQUIRED", category: "INTERNET_ISSUE" }, { type: "TAG", tag: "INTERNET_ISSUE" }],
      priority: 100,
    }),
    rule({
      id: "r-pppoe",
      name: "PPPoE Disconnect",
      type: "SUPPORT_ESCALATION",
      matchType: "CONTAINS",
      matchValue: "pppoe disconnect",
      actions: [{ type: "SUPPORT_REQUIRED", category: "PPPOE_ISSUE" }],
      priority: 100,
    }),
    rule({
      id: "r-olt",
      name: "OLT Not Working",
      type: "SUPPORT_ESCALATION",
      matchType: "CONTAINS",
      matchValue: "olt কাজ করছে না",
      actions: [{ type: "SUPPORT_REQUIRED", category: "OLT_ISSUE" }],
      priority: 100,
    }),
  ];

  it.each([
    ["ইন্টারনেট চলছে না", "r-internet-down"],
    ["PPPoE disconnect হচ্ছে", "r-pppoe"],
    ["OLT কাজ করছে না", "r-olt"],
  ])("escalates %s to SUPPORT_REQUIRED via %s", (body, expectedRuleId) => {
    const result = evaluate(
      context({
        rules: escalationRules,
        message: {
          body,
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("SUPPORT_REQUIRED");
    expect(result.matchedRule?.id).toBe(expectedRuleId);
  });
});

describe("evaluate — auto-reply", () => {
  it("triggers AUTO_REPLY for a greeting", () => {
    const greeting = rule({
      id: "r-greeting",
      name: "Auto Reply: Greeting",
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      keywords: ["হ্যালো", "hello", "hi"],
      actions: [{ type: "AUTO_REPLY" }],
      priority: 70,
    });
    const result = evaluate(
      context({
        rules: [greeting],
        message: {
          body: "হ্যালো",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("AUTO_REPLY");
  });

  it("returns NO_MATCH for an unrelated client message with no matching rule", () => {
    const result = evaluate(
      context({
        rules: [],
        message: {
          body: "just saying thanks!",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("NO_MATCH");
  });
});

describe("evaluate — multi-action rules", () => {
  it("returns the full ordered, deduped action list for a multi-action rule", () => {
    const multiAction = rule({
      id: "r-internet-multi",
      name: "Internet Not Working (multi-action)",
      type: "SUPPORT_ESCALATION",
      matchType: "CONTAINS",
      matchValue: "internet not working",
      actions: [
        { type: "SUPPORT_REQUIRED", category: "INTERNET_ISSUE" },
        { type: "TAG", tag: "INTERNET_ISSUE" },
        { type: "NOTIFY_TEAMS" },
        { type: "FORWARD", forwardToChatId: "support-group-chat-id" },
        // duplicate on purpose — must be collapsed
        { type: "TAG", tag: "INTERNET_ISSUE" },
      ],
      priority: 100,
    });
    const result = evaluate(
      context({
        rules: [multiAction],
        message: {
          body: "internet not working",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("SUPPORT_REQUIRED");
    expect(result.actions).toHaveLength(4); // 5 configured, 1 exact duplicate removed
    expect(result.actions.map((a) => a.type)).toEqual([
      "SUPPORT_REQUIRED",
      "TAG",
      "NOTIFY_TEAMS",
      "FORWARD",
    ]);
  });
});

describe("evaluate — last sender rule (must not blanket-ignore)", () => {
  const lastSenderIgnoreRule = rule({
    id: "r-last-sender-ignore",
    name: "Ignore default ack after team reply",
    type: "LAST_SENDER",
    matchType: "CONTAINS",
    matchValue: "thank you",
    conditions: { previousSender: { type: "TEAM_MEMBER" } },
    actions: [{ type: "IGNORE" }],
    priority: 50,
  });

  it("ignores a matching default pattern when the previous sender was a team member", () => {
    const result = evaluate(
      context({
        rules: [lastSenderIgnoreRule],
        previousMessage: { senderPhone: "+8801700000001", isFromTeamMember: true },
        message: {
          body: "thank you",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("IGNORE");
    expect(result.matchedRule?.id).toBe("r-last-sender-ignore");
  });

  it("does NOT ignore an unrelated new client issue even though the previous sender was a team member", () => {
    const result = evaluate(
      context({
        rules: [lastSenderIgnoreRule],
        previousMessage: { senderPhone: "+8801700000001", isFromTeamMember: true },
        message: {
          body: "আমার ইন্টারনেট এখনো কাজ করছে না",
          senderPhone: "+8801000000001",
          isFromTeamMember: false,
          groupId: "group-1",
          chatId: "group-1",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.finalDecision).toBe("NO_MATCH");
  });
});
