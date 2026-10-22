/**
 * White labeling (BRANDING.md): the built-in brand, the limits, and the pure rules for what a Main
 * Admin may save. Shared by the server (reading and saving) and the browser (the Branding form's
 * own checks and preview), so the two cannot disagree.
 *
 * A NULL stored value means "use the default below", the same shape as Notification Templates, and
 * Reset is forgetting the edit rather than copying today's default into the database. The default
 * is "Nexora" (21 Oct 2026). An install that existed before then had "Softify Assist" stored for it
 * by the 20261021090000_nexora_white_label_defaults migration, so only a NEW install shows Nexora.
 */

import { DEFAULT_PRODUCT_NAME } from "@support-automation/shared";

export const DEFAULT_BRANDING = {
  productName: DEFAULT_PRODUCT_NAME,
  loginHeadline: "WhatsApp support that answers before anyone has to.",
  loginSubheading:
    "Deterministic rules decide what gets an instant reply, what waits for a human, and what escalates — with the whole decision trace recorded for every message.",
} as const;

export const BRANDING_LIMITS = {
  productName: 60,
  loginHeadline: 120,
  loginSubheading: 400,
  /** Per image. Small on purpose: these are loaded on every page and stored in the database. */
  assetBytes: 512 * 1024,
} as const;

export type BrandAssetKind = "logo" | "icon";

export function isBrandAssetKind(value: unknown): value is BrandAssetKind {
  return value === "logo" || value === "icon";
}

/** What every page needs to draw the brand. Never carries image bytes — only where to fetch them. */
export interface PublicBranding {
  productName: string;
  loginHeadline: string;
  loginSubheading: string;
  /** `#rrggbb`, or null for the built-in accent. */
  accentColor: string | null;
  /** The wide logo, or null when none was uploaded (the sign-in page then shows the mark and name). */
  logoUrl: string | null;
  /** Always set: the uploaded icon, or the built-in one served from the same address. */
  iconUrl: string;
  hasCustomIcon: boolean;
}

/** The URL an image is served from. The version makes a new upload a new URL. */
export function brandAssetUrl(kind: BrandAssetKind, version: number): string {
  return `/api/brand/${kind}?v=${version}`;
}

export function defaultPublicBranding(): PublicBranding {
  return {
    productName: DEFAULT_BRANDING.productName,
    loginHeadline: DEFAULT_BRANDING.loginHeadline,
    loginSubheading: DEFAULT_BRANDING.loginSubheading,
    accentColor: null,
    logoUrl: null,
    iconUrl: brandAssetUrl("icon", 0),
    hasCustomIcon: false,
  };
}

/**
 * A text field as it will be stored: trimmed, inner whitespace collapsed for single-line fields,
 * and null when empty or identical to the default (so saving the default text is the same as
 * Reset, and the field keeps following the built-in wording).
 */
export function normalizeBrandText(
  raw: unknown,
  field: "productName" | "loginHeadline" | "loginSubheading",
): { value: string | null } | { error: string } {
  const singleLine = field !== "loginSubheading";
  let text = typeof raw === "string" ? raw.trim() : "";
  if (singleLine) text = text.replace(/\s+/g, " ");
  const label = field === "productName" ? "Product name" : field === "loginHeadline" ? "Sign-in headline" : "Sign-in text";
  if (text.length > BRANDING_LIMITS[field]) return { error: `${label} can be at most ${BRANDING_LIMITS[field]} characters.` };
  // A control character would reach page titles and the AI assistant's instructions verbatim.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { error: `${label} contains a character that cannot be shown.` };
  if (!text || text === DEFAULT_BRANDING[field]) return { value: null };
  return { value: text };
}

/** `#abc` / `abc` / `#AABBCC` → `#aabbcc`; empty → null (the built-in accent); anything else → error. */
export function normalizeAccentColor(raw: unknown): { value: string | null } | { error: string } {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return { value: null };
  const hex = text.startsWith("#") ? text.slice(1) : text;
  if (/^[0-9a-f]{3}$/.test(hex)) return { value: `#${hex.split("").map((c) => c + c).join("")}` };
  if (/^[0-9a-f]{6}$/.test(hex)) return { value: `#${hex}` };
  return { error: "Brand colour must be a hex colour such as #4f46e5." };
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio of the colour as text on a white page. Below 3 a link in it is hard to read. */
export function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/**
 * The accent tokens for a brand colour, for both themes. Mixed in the browser with `color-mix`, so
 * one colour yields the hover, tint and border shades the design system already uses. Only the
 * ACCENT moves: the near-black "ink" primary is the console's chrome and stays, so a brand colour
 * can never make the buttons or the sidebar unreadable.
 */
export function accentStyleSheet(hex: string): string {
  const light = [
    `--color-accent:${hex}`,
    `--color-accent-hover:color-mix(in oklab,${hex} 82%,black)`,
    `--color-accent-bg:color-mix(in oklab,${hex} 9%,white)`,
    `--color-accent-border:color-mix(in oklab,${hex} 32%,white)`,
    `--color-accent-fg:color-mix(in oklab,${hex} 80%,black)`,
    `--color-focus-ring:${hex}`,
  ].join(";");
  const dark = [
    `--color-accent:color-mix(in oklab,${hex} 85%,white)`,
    `--color-accent-hover:color-mix(in oklab,${hex} 65%,white)`,
    `--color-accent-bg:color-mix(in oklab,${hex} 22%,#0b1220)`,
    `--color-accent-border:color-mix(in oklab,${hex} 55%,#0b1220)`,
    `--color-accent-fg:color-mix(in oklab,${hex} 55%,white)`,
    `--color-focus-ring:color-mix(in oklab,${hex} 75%,white)`,
  ].join(";");
  // Same three-state structure as globals.css: light by default, dark by OS preference unless the
  // user chose light, and dark when the user chose dark. Each selector is one step MORE specific
  // than its globals.css counterpart (`:root:root`), so it wins wherever the browser happens to put
  // this sheet relative to the stylesheet.
  return `:root:root{${light}}@media (prefers-color-scheme: dark){:root:root:not([data-theme="light"]){${dark}}}:root:root[data-theme="dark"]{${dark}}`;
}

/** Image types accepted for a logo or icon. */
export const BRAND_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/svg+xml"] as const;
export type BrandImageType = (typeof BRAND_IMAGE_TYPES)[number];

/**
 * The image type, read from the bytes themselves — never from the file name or the browser's claim.
 * Null when it is none of the accepted types.
 */
export function sniffBrandImage(bytes: Uint8Array): BrandImageType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  // SVG is text: look for the root element near the start (after an XML prolog, comments, BOM).
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * An SVG is a document that can carry script. It is only ever shown through `<img>` (where script
 * never runs) and served with a sandboxing CSP, so this is a second line rather than the defence:
 * refuse the obvious carriers outright, so a file that relies on them is never stored at all.
 */
export function svgLooksUnsafe(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).toLowerCase();
  return /<script|<foreignobject|javascript:|\bon[a-z]+\s*=/.test(text);
}

/** The built-in icon, served when none is uploaded (it is also the favicon). */
export const DEFAULT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#18181b"/>
  <g stroke="#fafafa" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M8.5 21V11.6A3.1 3.1 0 0 1 11.6 8.5h5"/>
    <path d="M23.5 11v9.4a3.1 3.1 0 0 1-3.1 3.1h-5"/>
  </g>
  <circle cx="21.8" cy="8.6" r="3" fill="#fafafa"/>
  <circle cx="10.2" cy="23.4" r="3" fill="#fafafa"/>
</svg>
`;
