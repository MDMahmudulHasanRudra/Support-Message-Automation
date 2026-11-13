import { describe, expect, it } from "vitest";
import {
  accentStyleSheet,
  brandAssetUrl,
  contrastOnWhite,
  DEFAULT_BRANDING,
  defaultPublicBranding,
  normalizeAccentColor,
  normalizeBrandText,
  sniffBrandImage,
  svgLooksUnsafe,
} from "@/lib/branding";
import { normalizeDefaultPalette, normalizePersonalPalette, resolvePalette, THEME_PALETTE_IDS, THEME_PALETTES } from "@/lib/themes";

/** White labeling's pure rules (lib/branding.ts). No database. */

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("brand text", () => {
  it("trims, collapses a single-line field, and stores the default as 'use the default'", () => {
    expect(normalizeBrandText("  Zoventio   Desk  ", "productName")).toEqual({ value: "Zoventio Desk" });
    expect(normalizeBrandText("", "productName")).toEqual({ value: null });
    expect(normalizeBrandText(DEFAULT_BRANDING.productName, "productName")).toEqual({ value: null });
    expect(normalizeBrandText(null, "loginHeadline")).toEqual({ value: null });
  });

  it("keeps line breaks in the sign-in text, which is a paragraph", () => {
    expect(normalizeBrandText("Line one\nLine two", "loginSubheading")).toEqual({ value: "Line one\nLine two" });
  });

  it("refuses an over-long value and a control character", () => {
    expect(normalizeBrandText("x".repeat(61), "productName")).toHaveProperty("error");
    expect(normalizeBrandText("Bad\u0007Name", "productName")).toHaveProperty("error");
  });
});

describe("brand colour", () => {
  it("accepts #rgb, rgb and #rrggbb in any case, and empty as the built-in colour", () => {
    expect(normalizeAccentColor("#ABC")).toEqual({ value: "#aabbcc" });
    expect(normalizeAccentColor("0d9488")).toEqual({ value: "#0d9488" });
    expect(normalizeAccentColor(" #0D9488 ")).toEqual({ value: "#0d9488" });
    expect(normalizeAccentColor("")).toEqual({ value: null });
  });

  it("refuses anything that is not a hex colour — the value is written into a style sheet", () => {
    for (const bad of ["red", "#12345", "#1234567", "#ggg", "#000;}body{display:none", "url(x)"]) {
      expect(normalizeAccentColor(bad), bad).toHaveProperty("error");
    }
  });

  it("knows a light colour is hard to read on white", () => {
    expect(contrastOnWhite("#4f46e5")).toBeGreaterThan(4.5);
    expect(contrastOnWhite("#ffff66")).toBeLessThan(3);
  });

  it("outranks the default tokens in all three theme states", () => {
    const css = accentStyleSheet("#0d9488");
    // One step above the colour themes too: `:root[data-palette]` is (0,2,0) and its dark blocks (0,3,0).
    expect(css).toContain(":root:root:root{--color-accent:#0d9488");
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:root:root:not([data-theme="light"]){');
    expect(css).toContain(':root:root:root[data-theme="dark"]{');
    expect(css).toContain("--color-focus-ring:#0d9488");
    // Only the accent moves; the ink primary that buttons and the sidebar use is never touched.
    expect(css).not.toContain("--color-primary");
  });
});

describe("image type from the bytes", () => {
  it("recognises each accepted type by its signature", () => {
    expect(sniffBrandImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffBrandImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffBrandImage(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(sniffBrandImage(text("GIF89a"))).toBe("image/gif");
    expect(sniffBrandImage(bytes(0x00, 0x00, 0x01, 0x00, 1, 0))).toBe("image/x-icon");
    expect(sniffBrandImage(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
    expect(sniffBrandImage(text('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
  });

  it("refuses everything else, whatever the file was called", () => {
    expect(sniffBrandImage(text("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffBrandImage(text("%PDF-1.7"))).toBeNull();
    expect(sniffBrandImage(bytes())).toBeNull();
    expect(sniffBrandImage(text("just some text"))).toBeNull();
  });

  it("an SVG carrying script or event handlers is unsafe; a plain one is not", () => {
    expect(svgLooksUnsafe(text('<svg><script>alert(1)</script></svg>'))).toBe(true);
    expect(svgLooksUnsafe(text('<svg onload="alert(1)"></svg>'))).toBe(true);
    expect(svgLooksUnsafe(text('<svg><a href="javascript:alert(1)"/></svg>'))).toBe(true);
    expect(svgLooksUnsafe(text("<svg><foreignObject><div/></foreignObject></svg>"))).toBe(true);
    expect(svgLooksUnsafe(text('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#0d9488"/></svg>'))).toBe(false);
  });
});

describe("the built-in brand", () => {
  it("is the product as it always looked, with the icon served from the same address as a custom one", () => {
    expect(defaultPublicBranding()).toEqual({
      productName: "Chithii",
      loginHeadline: DEFAULT_BRANDING.loginHeadline,
      loginSubheading: DEFAULT_BRANDING.loginSubheading,
      accentColor: null,
      logoUrl: null,
      iconUrl: "/api/brand/icon?v=0",
      hasCustomIcon: false,
      themePalette: "tide",
    });
    expect(brandAssetUrl("logo", 7)).toBe("/api/brand/logo?v=7");
  });
});

describe("colour themes", () => {
  it("offers one catalogue, with Tide first as the built-in default", () => {
    expect(THEME_PALETTES.map((p) => p.id)).toEqual([...THEME_PALETTE_IDS]);
    expect(THEME_PALETTES[0].id).toBe("tide");
    for (const p of THEME_PALETTES) expect(Object.values(p.swatch).every((c) => /^#[0-9a-f]{6}$/.test(c)), p.id).toBe(true);
  });

  it("stores only a known palette; Tide as the installation default is 'use the built-in'", () => {
    expect(normalizeDefaultPalette("indigo")).toEqual({ value: "indigo" });
    expect(normalizeDefaultPalette("tide")).toEqual({ value: null });
    expect(normalizeDefaultPalette("")).toEqual({ value: null });
    expect(normalizePersonalPalette("tide")).toEqual({ value: "tide" });
    expect(normalizePersonalPalette("default")).toEqual({ value: null });
    for (const bad of ["Indigo", "neon", '"><script>', "tide;"]) {
      expect(normalizePersonalPalette(bad), String(bad)).toHaveProperty("error");
      expect(normalizeDefaultPalette(bad), String(bad)).toHaveProperty("error");
    }
  });

  it("resolves the person's choice, then the device, then the installation default", () => {
    const base = { personal: null, cookie: null, installationDefault: null };
    expect(resolvePalette({ ...base, signedIn: false })).toBe("tide");
    expect(resolvePalette({ ...base, signedIn: false, installationDefault: "plum" })).toBe("plum");
    expect(resolvePalette({ ...base, signedIn: false, cookie: "sunset", installationDefault: "plum" })).toBe("sunset");
    expect(resolvePalette({ ...base, signedIn: true, personal: "emerald", cookie: "sunset" })).toBe("emerald");
    // Signed in with no choice: the default, never a cookie somebody else left on this browser.
    expect(resolvePalette({ ...base, signedIn: true, cookie: "sunset", installationDefault: "plum" })).toBe("plum");
    expect(resolvePalette({ ...base, signedIn: false, cookie: "bogus", installationDefault: "nope" })).toBe("tide");
  });
});
