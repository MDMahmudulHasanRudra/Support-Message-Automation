import { describe, expect, it } from "vitest";
import {
  conversationRefColumns,
  extractNoteMentions,
  normaliseConversationTags,
  parseConversationRef,
  parseCopilotAssist,
} from "./inboxWorkspace.js";

describe("parseConversationRef", () => {
  it("accepts a WhatsApp group, personal and LID chat", () => {
    expect(parseConversationRef({ kind: "whatsapp", accountId: "acc_1", chatId: "1203630-1@g.us" })).toEqual({ kind: "whatsapp", accountId: "acc_1", chatId: "1203630-1@g.us" });
    expect(parseConversationRef({ kind: "whatsapp", accountId: "a", chatId: "8801712345678@c.us" })).not.toBeNull();
    expect(parseConversationRef({ kind: "whatsapp", accountId: "a", chatId: "123456789012345@lid" })).not.toBeNull();
  });

  it("refuses status, broadcast, newsletters and malformed ids", () => {
    expect(parseConversationRef({ kind: "whatsapp", accountId: "a", chatId: "status@broadcast" })).toBeNull();
    expect(parseConversationRef({ kind: "whatsapp", accountId: "a", chatId: "1@newsletter" })).toBeNull();
    expect(parseConversationRef({ kind: "whatsapp", accountId: "a b", chatId: "1@c.us" })).toBeNull();
    expect(parseConversationRef({ kind: "channel", conversationId: "x'; drop" })).toBeNull();
    expect(parseConversationRef({ kind: "other" })).toBeNull();
    expect(parseConversationRef(null)).toBeNull();
  });

  it("fills exactly one side of the columns", () => {
    expect(conversationRefColumns({ kind: "channel", conversationId: "c1" })).toEqual({ accountId: null, chatId: null, channelConversationId: "c1" });
    expect(conversationRefColumns({ kind: "whatsapp", accountId: "a", chatId: "1@g.us" })).toEqual({ accountId: "a", chatId: "1@g.us", channelConversationId: null });
  });
});

describe("normaliseConversationTags", () => {
  it("lowercases, joins words, drops symbols and duplicates", () => {
    expect(normaliseConversationTags(["  Billing Issue ", "#billing-issue", "VIP!", "", "--"])).toEqual(["billing-issue", "vip"]);
  });

  it("keeps Bengali", () => {
    expect(normaliseConversationTags("বিল সমস্যা, refund")).toEqual(["বিল-সমস্যা", "refund"]);
  });

  it("caps count and length", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(normaliseConversationTags(many)).toHaveLength(12);
    expect(normaliseConversationTags(["x".repeat(50)])[0]).toHaveLength(32);
  });
});

describe("extractNoteMentions", () => {
  const users = [
    { id: "u1", username: "Rudra" },
    { id: "u2", username: "rifat.k" },
  ];

  it("finds mentions case-insensitively, once each", () => {
    expect(extractNoteMentions("@rudra please check, cc @Rifat.k and @rudra.", users)).toEqual(["u1", "u2"]);
  });

  it("ignores emails and unknown names", () => {
    expect(extractNoteMentions("mail rudra@example.com or @nobody", users)).toEqual([]);
  });
});

describe("parseCopilotAssist", () => {
  it("reads the three sections", () => {
    const parsed = parseCopilotAssist(
      "**SUMMARY:** Customer cannot log in\nafter the password reset.\nINTENT: login problem\nNEXT_STEPS:\n1. Ask for the username\n- Check the account status\n",
    );
    expect(parsed).toEqual({
      summary: "Customer cannot log in after the password reset.",
      intent: "login problem",
      nextSteps: ["Ask for the username", "Check the account status"],
    });
  });

  it("never throws on junk and caps steps", () => {
    expect(parseCopilotAssist("nothing useful")).toEqual({ summary: null, intent: null, nextSteps: [] });
    const steps = parseCopilotAssist(`NEXT STEPS:\n${Array.from({ length: 9 }, (_, i) => `- s${i}`).join("\n")}`);
    expect(steps.nextSteps).toHaveLength(5);
  });
});
