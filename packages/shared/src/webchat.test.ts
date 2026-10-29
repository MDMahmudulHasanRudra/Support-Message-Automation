import { describe, expect, it } from "vitest";
import { normalizeOrigin, normalizeWebchatEvent, originAllowed, parseAllowedOrigins, parseWidgetSettings, DEFAULT_WIDGET_SETTINGS } from "./webchat.js";

describe("origins", () => {
  it("normalises to scheme + host, https only except localhost", () => {
    expect(normalizeOrigin("https://Shop.Example.com/path?q=1")).toBe("https://shop.example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://shop.example.com")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("https://user:pw@shop.example.com")).toBeNull();
  });

  it("parses a list and reports bad lines", () => {
    expect(parseAllowedOrigins("https://a.com\nhttps://a.com/x, nope\nhttp://b.com")).toEqual({ origins: ["https://a.com"], invalid: ["nope", "http://b.com"] });
  });

  it("fails closed", () => {
    expect(originAllowed("https://a.com", [])).toBe(false);
    expect(originAllowed(null, ["https://a.com"])).toBe(false);
    expect(originAllowed("https://a.com", ["https://a.com"])).toBe(true);
    expect(originAllowed("https://evil.a.com", ["https://a.com"])).toBe(false);
  });
});

describe("widget settings", () => {
  it("keeps valid values and defaults the rest", () => {
    expect(parseWidgetSettings({ title: "Help", color: "#FF0000", position: "left", askEmail: true, extra: 1 })).toEqual({
      ...DEFAULT_WIDGET_SETTINGS,
      title: "Help",
      color: "#ff0000",
      position: "left",
      askEmail: true,
    });
    expect(parseWidgetSettings({ color: "red; background:url(x)" }).color).toBe(DEFAULT_WIDGET_SETTINGS.color);
  });
});

describe("normalizeWebchatEvent", () => {
  it("turns a recorded visitor message into an inbound message", () => {
    const e = normalizeWebchatEvent({ provider: "WEBCHAT", visitorId: "v_abcdefghijklmnop", nonce: "n1234567", text: " Hello ", name: "Rina (unverified)", email: null, occurredAt: "2026-10-29T10:00:00Z" });
    expect(e).toMatchObject({ type: "MESSAGE", direction: "INBOUND", threadId: "v_abcdefghijklmnop", externalMessageId: "wc-n1234567", text: "Hello", senderName: "Rina (unverified)" });
  });

  it("ignores anything malformed", () => {
    expect(normalizeWebchatEvent({ visitorId: "x", nonce: "n1234567", text: "hi" }).type).toBe("IGNORED");
    expect(normalizeWebchatEvent({ visitorId: "v_abcdefghijklmnop", nonce: "n1234567", text: "   " }).type).toBe("IGNORED");
  });
});
