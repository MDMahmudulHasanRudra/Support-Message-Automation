import { describe, expect, it } from "vitest";
import { collectedChatKind, isPersonalChatId, selectCatchUpChats } from "../whatsappChats.js";

const SINCE = Date.UTC(2026, 9, 16, 6, 0, 0);
const after = (seconds: number) => Math.floor(SINCE / 1000) + seconds;

describe("which chats are conversations", () => {
  it("is decided by WhatsApp's own domain, never anything else", () => {
    expect(collectedChatKind("120363000000000000@g.us")).toBe("GROUP");
    expect(collectedChatKind("8801700000000@c.us")).toBe("PERSONAL");
    expect(collectedChatKind("123456789012345@lid")).toBe("PERSONAL");
    for (const id of ["status@broadcast", "120363000000000000@newsletter", "1700000000@broadcast", "@c.us", "@lid", "@g.us", "", "8801700000000"]) {
      expect(collectedChatKind(id)).toBeNull();
    }
    expect(isPersonalChatId("8801700000000@c.us")).toBe(true);
    expect(isPersonalChatId("120363000000000000@g.us")).toBe(false);
  });
});

describe("the chats a gap sweep reads", () => {
  it("reads personal chats as well as groups — the gap Phase 2 closes", () => {
    const picked = selectCatchUpChats(
      [
        { id: "a@g.us", t: after(60) },
        { id: "8801700000001@c.us", t: after(120) },
        { id: "123456789012345@lid", t: after(30) },
      ],
      SINCE,
    );
    expect(picked.map((chat) => [chat.id, chat.kind])).toEqual([
      ["8801700000001@c.us", "PERSONAL"],
      ["a@g.us", "GROUP"],
      ["123456789012345@lid", "PERSONAL"],
    ]);
  });

  it("never reads status, channels or broadcast lists, however active", () => {
    const picked = selectCatchUpChats(
      [
        { id: "status@broadcast", t: after(10) },
        { id: "1@newsletter", t: after(10) },
        { id: "1700000000@broadcast", t: after(10) },
      ],
      SINCE,
    );
    expect(picked).toEqual([]);
  });

  it("skips chats untouched since the gap began, and chats with no activity time", () => {
    const picked = selectCatchUpChats(
      [
        { id: "old@g.us", t: after(-60) },
        { id: "edge@g.us", t: after(0) },
        { id: "8801700000002@c.us", t: null },
        { id: "8801700000003@c.us", t: Number.NaN },
        { id: "new@g.us", t: after(1) },
      ],
      SINCE,
    );
    expect(picked.map((chat) => chat.id)).toEqual(["new@g.us"]);
  });

  it("reads a chat listed twice once, most recently active first, ties by id", () => {
    const picked = selectCatchUpChats(
      [
        { id: "b@g.us", t: after(50) },
        { id: "a@g.us", t: after(50) },
        { id: "b@g.us", t: after(50) },
        { id: "c@g.us", t: after(90) },
      ],
      SINCE,
    );
    expect(picked.map((chat) => chat.id)).toEqual(["c@g.us", "a@g.us", "b@g.us"]);
  });
});
