import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toDataURL } from "qrcode";

/**
 * The linking QR is drawn by us, in black, from the library's raw payload.
 *
 * What it replaced reached operators on screen: `@open-wa/wa-automate` emits the same code twice —
 * the raw payload on `qrData.<session>`, then a rendered PNG on `qr.<session>` which it gets by
 * calling `window.getQrPng()` inside the WhatsApp Web page. That image is WhatsApp's own canvas and
 * comes back brand-coloured, so the dialog showed a RED QR. Red on white clears far less contrast
 * than a scanner expects, and when it fails it reads as a broken camera or a dead session rather
 * than a rendering problem — which is the expensive kind of bug, because nobody looks at the
 * renderer.
 *
 * Only the QR branch changes. A link-code attempt carries the bare nine-character code on both
 * events, so there is nothing to draw and that path is untouched.
 *
 * Pure — no database, no browser.
 */

const PROVIDER = resolve(__dirname, "../provider/openwa/OpenWAProvider.ts");
const source = readFileSync(PROVIDER, "utf8");

/** A realistic WhatsApp linking payload: four comma-separated base64-ish segments. */
const PAYLOAD = "2@aB3dEf5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN,7oP9qR1sT3uV5wX,7yZ9aB1cD3eF,==";

describe("the QR is rendered black, not taken from WhatsApp's coloured canvas", () => {
  it("the provider asks for pure black modules on pure white", () => {
    expect(source).toContain('dark: "#000000ff"');
    expect(source).toContain('light: "#ffffffff"');
  });

  it("it renders from the raw payload event, not the library's image", () => {
    expect(source).toContain('ev.on("qrData.**"');
    expect(source).toContain("renderQrDataUrl");
  });

  it("the library's own image is kept only as a fallback once our render succeeded", () => {
    // The guard that stops the coloured PNG landing on top of the black one a moment later.
    expect(source).toContain("if (this.renderedQrPayload) return;");
  });

  it("a link-code attempt still passes the bare code straight through", () => {
    // `value`, not a rendered data URL — the whole point of the branch. It goes through
    // `writeQrState` rather than `setState` directly because every QR write now shares one
    // generation-guarded path; see the next test for why that matters.
    expect(source).toMatch(
      /if \(this\.pairingMode === "PHONE_CODE"\) \{[\s\S]{0,300}?writeQrState\(generation, \{ qrLength: value\.length \}, value\)/,
    );
  });

  it("every QR write goes through the one generation-guarded path", () => {
    // A stale render finishing after a newer attempt had already published its own code used to
    // overwrite it — a phone link code replaced, on screen, by the raw `data:image/png;base64,…`
    // string of an attempt that no longer existed. The guard is only worth anything if NOTHING
    // writes a QR around it, so this counts the call sites rather than trusting the current ones.
    // Behaviour is pinned end-to-end by qrGenerationRace.integration.test.ts.
    expect(source.match(/setState\("QR_AVAILABLE"/g)).toHaveLength(1);
    expect(source).toContain("if (generation !== this.attemptGeneration) return;");
  });

  it("the QR listeners are attached once per provider, not once per attempt", () => {
    // Registered inside openSession() they accumulated on the library's process-global emitter,
    // one live handler per reconnect, each rewriting the same row on every rotation.
    expect(source).toContain("if (this.qrListenersAttached) return;");
    expect(source).toContain("this.qrListenersAttached = true;");
  });
});

describe("the renderer itself", () => {
  const OPTIONS = {
    errorCorrectionLevel: "M" as const,
    margin: 4,
    scale: 8,
    color: { dark: "#000000ff", light: "#ffffffff" },
  };

  it("produces a PNG data URL the dashboard can render as-is", async () => {
    const url = await toDataURL(PAYLOAD, OPTIONS);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // Big enough to be a real code rather than a blank or 1px image.
    expect(url.length).toBeGreaterThan(1000);
  });

  it("is deterministic, so a redraw of the same code cannot flicker", async () => {
    const [a, b] = await Promise.all([toDataURL(PAYLOAD, OPTIONS), toDataURL(PAYLOAD, OPTIONS)]);
    expect(a).toBe(b);
  });

  it("actually encodes the payload — a different code gives a different image", async () => {
    const other = await toDataURL(`${PAYLOAD}X`, OPTIONS);
    expect(other).not.toBe(await toDataURL(PAYLOAD, OPTIONS));
  });

  it("the colour is genuinely ours: the same payload in red renders differently", async () => {
    // The assertion that would have caught the original bug. If colour were ignored these two
    // would be identical, and "we set it to black" would prove nothing.
    const black = await toDataURL(PAYLOAD, OPTIONS);
    const red = await toDataURL(PAYLOAD, { ...OPTIONS, color: { dark: "#ff0000ff", light: "#ffffffff" } });
    expect(black).not.toBe(red);
  });

  it("carries the spec's four-module quiet zone", async () => {
    const withMargin = await toDataURL(PAYLOAD, OPTIONS);
    const withoutMargin = await toDataURL(PAYLOAD, { ...OPTIONS, margin: 0 });
    expect(withMargin).not.toBe(withoutMargin);
  });
});
