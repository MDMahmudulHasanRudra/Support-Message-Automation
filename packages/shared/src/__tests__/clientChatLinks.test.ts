import { describe, expect, it } from "vitest";
import { chatNumberDigits, isLinkableChatId, suggestedChatIds } from "../clientChatLinks.js";

describe("which chats can be linked", () => {
  it("accepts only an individual chat, never a group, broadcast or channel", () => {
    expect(isLinkableChatId("8801894431220@c.us")).toBe(true);
    expect(isLinkableChatId("161616161616161@lid")).toBe(true);
    for (const bad of ["12036302@g.us", "status@broadcast", "123@newsletter", "@c.us", "", "8801894431220"]) expect(isLinkableChatId(bad), bad).toBe(false);
  });
});

describe("chat numbers and suggestions", () => {
  it("reads a number only from @c.us; a @lid carries none", () => {
    expect(chatNumberDigits("8801894431220@c.us")).toBe("8801894431220");
    expect(chatNumberDigits("161616161616161@lid")).toBeNull();
    expect(chatNumberDigits("abc@c.us")).toBeNull();
  });
  it("suggests a chat whose number equals the client's WhatsApp number, and nothing else", () => {
    const chats = [{ chatId: "8801894431220@c.us" }, { chatId: "8801700000000@c.us" }, { chatId: "8801894431220@lid" }];
    expect([...suggestedChatIds(["8801894431220"], chats)]).toEqual(["8801894431220@c.us"]);
  });
  it("suggests nothing for a client with no WhatsApp number, or an empty one", () => {
    expect(suggestedChatIds([], [{ chatId: "8801894431220@c.us" }]).size).toBe(0);
    expect(suggestedChatIds([""], [{ chatId: "8801894431220@c.us" }]).size).toBe(0);
  });
  it("never suggests a hidden-number chat, even if its digits match", () => {
    expect(suggestedChatIds(["161616161616161"], [{ chatId: "161616161616161@lid" }]).size).toBe(0);
  });
});
