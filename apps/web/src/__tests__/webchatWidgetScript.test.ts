import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { widgetPathAllowed, widgetTeaserAllowed } from "@support-automation/shared";
import { WIDGET_SCRIPT } from "@/server/channels/webchatWidgetScript";
import { GET } from "@/app/api/webchat/widget.js/route";

/**
 * The widget script as served (Website Chat V3). No DOM here — the real browser runs are in docs/website-chat-v3.
 * What is pinned: it parses; it keeps the embed contract every installed site relies on (data-key, the
 * GetAssistChat object, the same endpoints); it never writes untrusted text as HTML; it runs the SAME page
 * targeting and teaser rules the shared tests check; and it stays small.
 */
describe("website chat widget script", () => {
  it("parses as one script", () => {
    expect(() => new Function(WIDGET_SCRIPT)).not.toThrow();
  });

  it("keeps the pre-V3 embed contract", () => {
    for (const piece of ['getAttribute("data-key")', "window.GetAssistChat", '"/session"', '"/messages"', '"/files"', '"/typing"', "__getAssistChatLoaded", "getassist-chat-"]) {
      expect(WIDGET_SCRIPT, piece).toContain(piece);
    }
  });

  it("never renders text as HTML", () => {
    expect(WIDGET_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(WIDGET_SCRIPT).toContain('attachShadow({ mode: "closed" })');
  });

  it("embeds the shared page-targeting and teaser rules as source", () => {
    expect(WIDGET_SCRIPT).toContain(widgetPathAllowed.toString());
    expect(WIDGET_SCRIPT).toContain(widgetTeaserAllowed.toString());
  });

  // Found in the browser pass (docs/website-chat-v3/02-browser-e2e.md): a host rule like `div { outline: … }` drew a box
  // around the launcher, the launcher covered Send on a full-screen phone panel, and a reply read on one page came back
  // as "1 new" on the next.
  it("keeps the host page's rules off its own container", () => {
    expect(WIDGET_SCRIPT).toContain('root.style.cssText = "all:initial!important;position:fixed!important;');
    expect(WIDGET_SCRIPT).toContain('root.style.setProperty("display", ok && S.shown ? "block" : "none", "important")');
    expect(WIDGET_SCRIPT).not.toMatch(/root\.style\.display\s*=/);
  });

  it("hides the launcher over a full-screen phone panel and remembers what the visitor read", () => {
    expect(WIDGET_SCRIPT).toContain(".b.op{display:none}");
    expect(WIDGET_SCRIPT).toContain('bubble.classList.toggle("op", open)');
    expect(WIDGET_SCRIPT).toMatch(/!seeing && !\(readTo && m\.at <= readTo\)\) S\.unread\+\+/);
  });

  it("sends no request in preview mode", () => {
    expect(WIDGET_SCRIPT).toMatch(/if \(preview\) return Promise\.reject/);
  });

  it("stays small enough for any website (budget: 70 KB raw, 20 KB gzip)", () => {
    const raw = Buffer.byteLength(WIDGET_SCRIPT);
    const gz = gzipSync(WIDGET_SCRIPT).length;
    expect(raw).toBeLessThan(70 * 1024);
    expect(gz).toBeLessThan(20 * 1024);
  });

  it("is served as cacheable JavaScript to any site", async () => {
    const response = GET();
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.text()).toBe(WIDGET_SCRIPT);
  });
});
