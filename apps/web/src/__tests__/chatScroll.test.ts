import { describe, expect, it } from "vitest";
import { decideOnArrival, shouldLoadOlder, scrollTopAfterPrepend } from "@/lib/chatScroll";

/** Pure — no database. The v2 conversation view's scroll rules (CHAT_UI_V2.md). */
const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

describe("a newer message arriving", () => {
  it("is followed when the reader was at the bottom, or when it is their own send", () => {
    expect(decideOnArrival(false, at(1400))).toBe("bottom");
    expect(decideOnArrival(false, at(1350))).toBe("bottom");
    expect(decideOnArrival(true, at(0))).toBe("bottom");
  });

  it("holds still while the reader is back in history", () => {
    expect(decideOnArrival(false, at(1200))).toBe("hold");
    expect(decideOnArrival(false, at(0))).toBe("hold");
  });
});

describe("loading older history", () => {
  it("loads near the top on a person's scroll", () => {
    expect(shouldLoadOlder({ userScroll: true, geometry: at(40), hasMore: true, loading: false })).toBe(true);
  });

  it("never on a programmatic scroll, a short thread, a load in flight, or with nothing older", () => {
    expect(shouldLoadOlder({ userScroll: false, geometry: at(0), hasMore: true, loading: false })).toBe(false);
    expect(shouldLoadOlder({ userScroll: true, geometry: at(0, 500, 600), hasMore: true, loading: false })).toBe(false);
    expect(shouldLoadOlder({ userScroll: true, geometry: at(0), hasMore: true, loading: true })).toBe(false);
    expect(shouldLoadOlder({ userScroll: true, geometry: at(0), hasMore: false, loading: false })).toBe(false);
    expect(shouldLoadOlder({ userScroll: true, geometry: at(300), hasMore: true, loading: false })).toBe(false);
  });

  it("keeps the message the reader was looking at in place after a prepend", () => {
    // 900px of older messages appear above; the reader was 30px from the top.
    expect(scrollTopAfterPrepend(at(30, 2000), 2900)).toBe(930);
    expect(scrollTopAfterPrepend(at(0, 2000), 2000)).toBe(0);
  });
});
