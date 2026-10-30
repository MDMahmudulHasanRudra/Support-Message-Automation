import { describe, expect, it } from "vitest";
import { cleanPathRule, normalizeOrigin, normalizeOriginInput, normalizeWebchatEvent, originAllowed, parseAllowedOrigins, parseWidgetSettings, widgetPathAllowed, widgetTeaserAllowed, wwwVariant, DEFAULT_WIDGET_SETTINGS } from "./webchat.js";

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

describe("Website Chat V3 settings", () => {
  it("a widget saved before V3 reads exactly as before, and keeps its PDFs", () => {
    const old = { title: "Help", color: "#112233", allowAttachments: true, position: "left" };
    const s = parseWidgetSettings(old);
    expect(s.title).toBe("Help");
    expect(s.position).toBe("left");
    expect(s.allowPdf).toBe(true);
    expect(s.launcherStyle).toBe("ICON");
    expect(s.theme).toBe("light");
    expect(s.teaser.enabled).toBe(false);
    expect(s.autoOpen.enabled).toBe(false);
    expect(parseWidgetSettings({ allowAttachments: false }).allowPdf).toBe(false);
    // A new widget (nothing stored) is photos only.
    expect(parseWidgetSettings({}).allowPdf).toBe(false);
    expect(parseWidgetSettings({ allowAttachments: true, allowPdf: false }).allowPdf).toBe(false);
  });

  it("clamps sizes and refuses unknown values", () => {
    const s = parseWidgetSettings({ radius: 400, panelWidth: 2000, panelHeight: 10, launcherSize: 9, theme: "neon", font: "Comic Sans", shadow: "huge", headerColor: "red" });
    expect([s.radius, s.panelWidth, s.panelHeight, s.launcherSize]).toEqual([28, 440, 420, 44]);
    expect([s.theme, s.font, s.shadow, s.headerColor]).toEqual(["light", "system", "soft", null]);
    expect(parseWidgetSettings({ devices: { desktop: false, mobile: false } }).devices).toEqual({ desktop: true, mobile: true });
  });

  it("shows a team photo only with a recorded consent and an uploaded avatar", () => {
    const asset = { id: "asset_avatar_0001", kind: "AVATAR", storageKey: "webchat-brand/p1/c1/asset_avatar_0001.png", mimeType: "image/png", size: 100, uploadedBy: "admin", uploadedAt: "2026-10-30T00:00:00Z" };
    const base = { assets: [asset] };
    expect(parseWidgetSettings({ ...base, team: [{ assetId: asset.id, name: "Rina" }] }).team).toEqual([]);
    expect(parseWidgetSettings({ ...base, team: [{ assetId: "missing_asset_id", name: "Rina", consentBy: "admin", consentAt: "2026-10-30T00:00:00Z" }] }).team).toEqual([]);
    const ok = parseWidgetSettings({ ...base, team: [{ assetId: asset.id, name: "Rina", consentBy: "admin", consentAt: "2026-10-30T00:00:00Z" }] }).team;
    expect(ok).toHaveLength(1);
    // A logo id that names an avatar, or a storage key outside the brand folder, is dropped.
    expect(parseWidgetSettings({ ...base, logoAssetId: asset.id }).logoAssetId).toBeNull();
    expect(parseWidgetSettings({ assets: [{ ...asset, storageKey: "../../etc/passwd.png" }] }).assets).toEqual([]);
  });
});

describe("website address input", () => {
  it("reads a bare domain as https and keeps only the origin", () => {
    expect(normalizeOriginInput("getassist.pro")).toBe("https://getassist.pro");
    expect(normalizeOriginInput(" GetAssist.pro/pricing?x=1 ")).toBe("https://getassist.pro");
    expect(normalizeOriginInput("https://www.example.com/")).toBe("https://www.example.com");
    expect(normalizeOriginInput("shop.example.co.uk:8443")).toBe("https://shop.example.co.uk:8443");
    expect(normalizeOriginInput("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("refuses other schemes, wildcards, credentials, plain http and non-hosts", () => {
    for (const bad of ["ftp://example.com", "javascript:alert(1)", "*.example.com", "https://*.example.com", "http://example.com", "https://user:pw@example.com", "localhost.", "example", "exa mple.com", "https://", "a..b.com", "-bad.com"]) {
      expect(normalizeOriginInput(bad), bad).toBeNull();
    }
    expect(parseAllowedOrigins("getassist.pro\nhttps://shop.getassist.pro\nnot a site")).toEqual({ origins: ["https://getassist.pro", "https://shop.getassist.pro"], invalid: ["not a site"] });
  });

  it("offers the www address for a bare domain, never for a subdomain", () => {
    expect(wwwVariant("https://getassist.pro")).toBe("https://www.getassist.pro");
    expect(wwwVariant("https://shop.getassist.pro")).toBeNull();
    expect(wwwVariant("https://www.getassist.pro")).toBeNull();
    expect(wwwVariant("http://localhost:3000")).toBeNull();
  });
});

describe("page targeting (run by the widget as-is)", () => {
  const all = { mode: "ALL", paths: [] as string[], hideCheckout: true };
  it("hides on checkout, cart and payment pages by default", () => {
    for (const p of ["/checkout", "/checkout/", "/checkout/order-pay/12?key=x", "/cart", "/checkouts/abc", "/payment"]) expect(widgetPathAllowed(p, all), p).toBe(false);
    for (const p of ["/", "/checkout-guide", "/cartoons", "/blog/payment-options"]) expect(widgetPathAllowed(p, all), p).toBe(true);
    expect(widgetPathAllowed("/checkout", { ...all, hideCheckout: false })).toBe(true);
  });
  it("includes or excludes exact paths and path/*", () => {
    const include = { mode: "INCLUDE", paths: ["/pricing", "/help/*"], hideCheckout: false };
    expect(["/pricing", "/Pricing/", "/help", "/help/a/b", "/pricing/x", "/helpdesk"].map((p) => widgetPathAllowed(p, include))).toEqual([true, true, true, true, false, false]);
    const exclude = { mode: "EXCLUDE", paths: ["/admin/*"], hideCheckout: false };
    expect(["/admin", "/admin/x", "/about"].map((p) => widgetPathAllowed(p, exclude))).toEqual([false, false, true]);
    expect(cleanPathRule("/blog/*")).toBe("/blog/*");
    expect(cleanPathRule("blog")).toBeNull();
    expect(cleanPathRule("/a*/b*")).toBeNull();
    expect(cleanPathRule("/<script>")).toBeNull();
  });
  it("is self-contained, so the widget can embed its source", () => {
    const rebuilt = new Function(`return (${widgetPathAllowed.toString()})`)() as typeof widgetPathAllowed;
    expect(rebuilt("/cart", all)).toBe(false);
  });
});

describe("greeting teaser frequency (run by the widget as-is)", () => {
  const teaser = { enabled: true, oncePerSession: true, capDays: 3, mobile: false };
  const fresh = { shownAt: null, dismissedAt: null, shownThisSession: false };
  const ctx = { now: 10 * 86_400_000, mobile: false, hasConversation: false, panelOpen: false };
  it("shows once, then respects the session, the cap, a dismissal, phones and a running conversation", () => {
    expect(widgetTeaserAllowed(teaser, fresh, ctx)).toBe(true);
    expect(widgetTeaserAllowed(teaser, { ...fresh, shownThisSession: true }, ctx)).toBe(false);
    expect(widgetTeaserAllowed(teaser, { ...fresh, shownAt: ctx.now - 2 * 86_400_000 }, ctx)).toBe(false);
    expect(widgetTeaserAllowed(teaser, { ...fresh, shownAt: ctx.now - 4 * 86_400_000 }, ctx)).toBe(true);
    expect(widgetTeaserAllowed({ ...teaser, capDays: 0 }, { ...fresh, dismissedAt: ctx.now - 3_600_000 }, ctx)).toBe(false);
    expect(widgetTeaserAllowed({ ...teaser, capDays: 0 }, { ...fresh, dismissedAt: ctx.now - 25 * 3_600_000 }, ctx)).toBe(true);
    expect(widgetTeaserAllowed(teaser, fresh, { ...ctx, mobile: true })).toBe(false);
    expect(widgetTeaserAllowed({ ...teaser, mobile: true }, fresh, { ...ctx, mobile: true })).toBe(true);
    expect(widgetTeaserAllowed(teaser, fresh, { ...ctx, hasConversation: true })).toBe(false);
    expect(widgetTeaserAllowed(teaser, fresh, { ...ctx, panelOpen: true })).toBe(false);
    expect(widgetTeaserAllowed({ ...teaser, enabled: false }, fresh, ctx)).toBe(false);
  });
});
