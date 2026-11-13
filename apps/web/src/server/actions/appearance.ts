"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { globalPrisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { normalizePersonalPalette, PALETTE_COOKIE, type ThemePaletteId } from "@/lib/themes";

/**
 * My account → Appearance: the colour theme this person sees. Self only (the user comes from the
 * session, never the form), and a support session cannot change it, like every other account field.
 * The value is checked against the one catalogue (lib/themes.ts) before it is stored, because it is
 * rendered into an HTML attribute on every page.
 *
 * Also written to a device cookie, so the sign-in page on this browser keeps the same look. Signed in,
 * the stored choice always decides (the session row already carries it), so the cookie is only a hint.
 */

export interface AppearanceState {
  error?: string;
  palette?: ThemePaletteId | null;
  savedAt?: number;
}

const SUPPORT_REFUSAL = "A support session cannot change this account.";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export async function saveMyPalette(raw: string): Promise<AppearanceState> {
  const session = await requireSession();
  if (session.support) return { error: SUPPORT_REFUSAL };
  const parsed = normalizePersonalPalette(raw);
  if ("error" in parsed) return { error: parsed.error };

  const user = await globalPrisma.user.findUnique({ where: { id: session.userId }, select: { supportOperatorId: true } });
  if (!user) return { error: "Your account no longer exists. Sign in again." };
  if (user.supportOperatorId) return { error: SUPPORT_REFUSAL };

  await globalPrisma.user.update({ where: { id: session.userId }, data: { themePalette: parsed.value } });

  const store = await cookies();
  if (parsed.value) {
    store.set(PALETTE_COOKIE, parsed.value, {
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    });
  } else {
    store.delete(PALETTE_COOKIE);
  }
  // The palette is an attribute on <html>, drawn by the root layout.
  revalidatePath("/", "layout");
  return { palette: parsed.value, savedAt: Date.now() };
}
