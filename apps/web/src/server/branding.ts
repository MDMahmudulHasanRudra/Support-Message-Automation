import { cache } from "react";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { platformPrisma } from "@/server/db";
import { brandAssetUrl, defaultPublicBranding, DEFAULT_BRANDING, type BrandAssetKind, type PublicBranding } from "@/lib/branding";

/**
 * Reading the installation's brand (BRANDING.md). Platform data — one row, no project — so it goes
 * through the platform client, never the project-scoped one.
 */

const BRANDING_ID = "default";

/** Every column except the image bytes, which only the image route ever reads. */
const TEXT_SELECT = {
  productName: true,
  loginHeadline: true,
  loginSubheading: true,
  accentColor: true,
  logoMimeType: true,
  iconMimeType: true,
  assetVersion: true,
  updatedByUsername: true,
  updatedAt: true,
} as const;

/**
 * The brand every page draws. Once per request (React `cache`): the root layout and its metadata
 * both ask.
 *
 * FAILS OPEN to the built-in brand. A missing row is the normal state of a fresh install, and an
 * unreadable database (an undeployed migration, a blip) must cost the custom logo, never the page —
 * this runs in the root layout, so a throw here would take down sign-in itself.
 */
export const getBranding = cache(async (): Promise<PublicBranding> => {
  // `next build` has no database. Every page is dynamic, so nothing built here is ever served —
  // but Next still tries each route once while deciding that, and asking the database then only
  // fills the build log with connection errors.
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return defaultPublicBranding();
  try {
    const row = await platformPrisma.platformBranding.findUnique({ where: { id: BRANDING_ID }, select: TEXT_SELECT });
    if (!row) return defaultPublicBranding();
    return {
      productName: row.productName ?? DEFAULT_BRANDING.productName,
      loginHeadline: row.loginHeadline ?? DEFAULT_BRANDING.loginHeadline,
      loginSubheading: row.loginSubheading ?? DEFAULT_BRANDING.loginSubheading,
      accentColor: row.accentColor,
      logoUrl: row.logoMimeType ? brandAssetUrl("logo", row.assetVersion) : null,
      iconUrl: brandAssetUrl("icon", row.assetVersion),
      hasCustomIcon: Boolean(row.iconMimeType),
    };
  } catch (err) {
    console.warn("[branding] could not read the brand — showing the built-in one", err);
    return defaultPublicBranding();
  }
});

/** What the Branding page edits: the STORED values (null = default), not the resolved ones. */
export interface BrandingSettings {
  productName: string | null;
  loginHeadline: string | null;
  loginSubheading: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  updatedAt: Date | null;
  updatedByUsername: string | null;
}

export async function getBrandingSettings(): Promise<BrandingSettings> {
  const row = await platformPrisma.platformBranding.findUnique({ where: { id: BRANDING_ID }, select: TEXT_SELECT });
  return {
    productName: row?.productName ?? null,
    loginHeadline: row?.loginHeadline ?? null,
    loginSubheading: row?.loginSubheading ?? null,
    accentColor: row?.accentColor ?? null,
    logoUrl: row?.logoMimeType ? brandAssetUrl("logo", row.assetVersion) : null,
    iconUrl: row?.iconMimeType ? brandAssetUrl("icon", row.assetVersion) : null,
    updatedAt: row?.updatedAt ?? null,
    updatedByUsername: row?.updatedByUsername ?? null,
  };
}

/**
 * One image, for the image route. Null when there is no branding row at all; empty bytes when the
 * row exists but this image was never uploaded (or was removed) — the version still matters then.
 */
export async function getBrandAsset(kind: BrandAssetKind): Promise<{ bytes: Uint8Array; mimeType: string; version: number } | null> {
  if (kind === "logo") {
    const row = await platformPrisma.platformBranding.findUnique({
      where: { id: BRANDING_ID },
      select: { logo: true, logoMimeType: true, assetVersion: true },
    });
    if (!row) return null;
    return { bytes: row.logo ?? new Uint8Array(), mimeType: row.logoMimeType ?? "", version: row.assetVersion };
  }
  const row = await platformPrisma.platformBranding.findUnique({
    where: { id: BRANDING_ID },
    select: { icon: true, iconMimeType: true, assetVersion: true },
  });
  if (!row) return null;
  return { bytes: row.icon ?? new Uint8Array(), mimeType: row.iconMimeType ?? "", version: row.assetVersion };
}

export { BRANDING_ID };
