"use server";

import { revalidatePath } from "next/cache";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import { BRANDING_ID } from "@/server/branding";
import {
  BRANDING_LIMITS,
  isBrandAssetKind,
  normalizeAccentColor,
  normalizeBrandText,
  sniffBrandImage,
  svgLooksUnsafe,
  type BrandAssetKind,
} from "@/lib/branding";

/**
 * White labeling (BRANDING.md): saving the installation's name, sign-in wording, colour, logo and
 * icon. Every action needs `projects.manage` — the brand of the whole installation is a Main Admin's
 * decision — and checks it itself, because a Server Action is a public endpoint whatever page shows
 * its button. Platform data only: nothing here touches a project.
 */

export interface BrandingFormState {
  error?: string;
  fieldErrors?: Partial<Record<"productName" | "loginHeadline" | "loginSubheading" | "accentColor", string>>;
  savedAt?: number;
}

export interface BrandAssetState {
  error?: string;
  savedAt?: number;
}

const MANAGE_DENIED = "Changing the branding needs the “Manage Projects and Project Access” permission (a Main Admin).";

async function requireManage(): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? { session } : { denied: MANAGE_DENIED };
}

/** Every page draws the brand from the root layout, so every page is stale after a save. */
function revalidateEverything() {
  revalidatePath("/", "layout");
}

export async function saveBranding(_prev: BrandingFormState, formData: FormData): Promise<BrandingFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const fieldErrors: NonNullable<BrandingFormState["fieldErrors"]> = {};
  const values: Partial<Record<"productName" | "loginHeadline" | "loginSubheading" | "accentColor", string | null>> = {};
  for (const field of ["productName", "loginHeadline", "loginSubheading"] as const) {
    const result = normalizeBrandText(formData.get(field), field);
    if ("error" in result) fieldErrors[field] = result.error;
    else values[field] = result.value;
  }
  const colour = normalizeAccentColor(formData.get("accentColor"));
  if ("error" in colour) fieldErrors.accentColor = colour.error;
  else values.accentColor = colour.value;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const data = { ...values, updatedByUsername: access.session.username };
  await platformPrisma.platformBranding.upsert({
    where: { id: BRANDING_ID },
    create: { id: BRANDING_ID, ...data },
    update: data,
  });

  await logSystemEvent("INFO", "branding", "Branding updated", {
    productName: values.productName ?? "(default)",
    accentColor: values.accentColor ?? "(default)",
    changedBy: access.session.username,
  });
  revalidateEverything();
  return { savedAt: Date.now() };
}

/**
 * Upload the logo or the icon. The type is read from the bytes (never the file name or the browser's
 * claim), the size is capped, and an SVG carrying script is refused outright. Every change moves
 * `assetVersion`, which is in the image URLs, so browsers fetch the new image at once.
 */
export async function uploadBrandAsset(kind: BrandAssetKind, _prev: BrandAssetState, formData: FormData): Promise<BrandAssetState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (!isBrandAssetKind(kind)) return { error: "Unknown image." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image file first." };
  if (file.size > BRANDING_LIMITS.assetBytes) {
    return { error: `That file is ${Math.ceil(file.size / 1024)} KB. The limit is ${BRANDING_LIMITS.assetBytes / 1024} KB — export a smaller version and try again.` };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = sniffBrandImage(bytes);
  if (!mimeType) return { error: "That file is not a PNG, JPEG, WebP, GIF, ICO or SVG image." };
  if (mimeType === "image/svg+xml" && svgLooksUnsafe(bytes)) {
    return { error: "That SVG contains script or event handlers, which a logo never needs. Export it again as a plain SVG or a PNG." };
  }

  // Prisma 5 stores `Bytes` from a Node Buffer.
  const stored = Buffer.from(bytes);
  const fields = kind === "logo" ? { logo: stored, logoMimeType: mimeType } : { icon: stored, iconMimeType: mimeType };
  await platformPrisma.platformBranding.upsert({
    where: { id: BRANDING_ID },
    create: { id: BRANDING_ID, ...fields, assetVersion: 1, updatedByUsername: access.session.username },
    update: { ...fields, assetVersion: { increment: 1 }, updatedByUsername: access.session.username },
  });

  await logSystemEvent("INFO", "branding", `Branding ${kind} uploaded`, {
    type: mimeType,
    bytes: bytes.byteLength,
    changedBy: access.session.username,
  });
  revalidateEverything();
  return { savedAt: Date.now() };
}

/** Back to the built-in mark (icon) or to the mark and name (logo). */
export async function removeBrandAsset(kind: BrandAssetKind): Promise<BrandAssetState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (!isBrandAssetKind(kind)) return { error: "Unknown image." };

  const existing = await platformPrisma.platformBranding.findUnique({ where: { id: BRANDING_ID }, select: { logoMimeType: true, iconMimeType: true } });
  if (!existing || !(kind === "logo" ? existing.logoMimeType : existing.iconMimeType)) return { savedAt: Date.now() };

  await platformPrisma.platformBranding.update({
    where: { id: BRANDING_ID },
    data: {
      ...(kind === "logo" ? { logo: null, logoMimeType: null } : { icon: null, iconMimeType: null }),
      assetVersion: { increment: 1 },
      updatedByUsername: access.session.username,
    },
  });
  await logSystemEvent("INFO", "branding", `Branding ${kind} removed`, { changedBy: access.session.username });
  revalidateEverything();
  return { savedAt: Date.now() };
}
