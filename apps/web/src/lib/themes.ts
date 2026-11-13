/**
 * Colour themes: the one catalogue of palettes a person (My account → Appearance) or a Main Admin
 * (Branding → Default theme) may choose. The colours themselves live in globals.css as
 * `:root[data-palette="<id>"]` blocks; this file only names them and carries the few colours the
 * pickers draw as swatches. Shared by the server (validation, the root layout) and the browser (the
 * pickers), so a value the form offers is exactly a value the server accepts.
 *
 * Resolution, in the root layout: the signed-in person's own choice → (signed out) the device's
 * `sa-palette` cookie → the installation's default → "tide".
 */

export const THEME_PALETTE_IDS = ["tide", "indigo", "emerald", "plum", "sunset", "graphite"] as const;
export type ThemePaletteId = (typeof THEME_PALETTE_IDS)[number];

export const DEFAULT_THEME_PALETTE: ThemePaletteId = "tide";

/** The device cookie the root layout reads for signed-out pages (sign-in). Not a secret. */
export const PALETTE_COOKIE = "sa-palette";

/** localStorage key for Light / Dark / System, shared by the header toggle and My account. */
export const THEME_MODE_STORAGE_KEY = "sa-theme";
export type ThemeMode = "light" | "system" | "dark";

export interface ThemePalette {
  id: ThemePaletteId;
  name: string;
  description: string;
  /** For the picker: the deep header/navigation field, its active item, its mark, the page sheet, the accent and the primary button. */
  swatch: { field: string; active: string; mark: string; sheet: string; accent: string; primary: string };
}

export const THEME_PALETTES: readonly ThemePalette[] = [
  {
    id: "tide",
    name: "Tide",
    description: "Deep sea-teal with a marigold mark. The original look.",
    swatch: { field: "#083138", active: "#0f6f79", mark: "#f2b54a", sheet: "#f3f7f7", accent: "#0e7c86", primary: "#0b3d45" },
  },
  {
    id: "indigo",
    name: "Indigo",
    description: "Ink-blue field with a periwinkle mark and a violet-blue accent.",
    swatch: { field: "#151a46", active: "#3b40a8", mark: "#a5b4fc", sheet: "#f4f5fb", accent: "#4f46e5", primary: "#1f2566" },
  },
  {
    id: "emerald",
    name: "Emerald",
    description: "Forest-green field with a gold mark. Calm and fresh.",
    swatch: { field: "#05271c", active: "#0f7a55", mark: "#fcd34d", sheet: "#f3f8f5", accent: "#0a7d57", primary: "#0d3b2a" },
  },
  {
    id: "plum",
    name: "Plum",
    description: "Aubergine field with a rose mark and a violet accent.",
    swatch: { field: "#2a1233", active: "#7a3b8f", mark: "#f9a8d4", sheet: "#f8f5f9", accent: "#8b3fb0", primary: "#3d1a4a" },
  },
  {
    id: "sunset",
    name: "Sunset",
    description: "Warm umber field with a peach mark and a terracotta accent.",
    swatch: { field: "#2f1710", active: "#a3472c", mark: "#fdba74", sheet: "#faf6f3", accent: "#c2410c", primary: "#4a2015" },
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "Neutral slate with a clear blue accent. Quiet and businesslike.",
    swatch: { field: "#121821", active: "#334256", mark: "#60a5fa", sheet: "#f5f6f8", accent: "#2563eb", primary: "#1e293b" },
  },
];

export function isThemePalette(value: unknown): value is ThemePaletteId {
  return typeof value === "string" && (THEME_PALETTE_IDS as readonly string[]).includes(value);
}

export function themePalette(id: ThemePaletteId): ThemePalette {
  return THEME_PALETTES.find((p) => p.id === id) ?? THEME_PALETTES[0];
}

/**
 * A person's choice as it will be stored: a palette id, or null for "use the installation's default"
 * (empty, "default"). Anything else is an error — the value reaches an HTML attribute and a cookie.
 */
export function normalizePersonalPalette(raw: unknown): { value: ThemePaletteId | null } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text === "default") return { value: null };
  return isThemePalette(text) ? { value: text } : { error: "Choose one of the themes shown." };
}

/** The installation default as it will be stored: null for Tide (the built-in), like every other branding field. */
export function normalizeDefaultPalette(raw: unknown): { value: ThemePaletteId | null } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text === DEFAULT_THEME_PALETTE) return { value: null };
  return isThemePalette(text) ? { value: text } : { error: "Choose one of the themes shown." };
}

/** The palette a page renders with. Every input is untrusted until it passes `isThemePalette`. */
export function resolvePalette(input: {
  signedIn: boolean;
  personal: string | null | undefined;
  cookie: string | null | undefined;
  installationDefault: string | null | undefined;
}): ThemePaletteId {
  const fallback = isThemePalette(input.installationDefault) ? input.installationDefault : DEFAULT_THEME_PALETTE;
  // Signed in, the person's own stored choice decides (null = the default) — a cookie left by somebody
  // else on a shared computer never does.
  if (input.signedIn) return isThemePalette(input.personal) ? input.personal : fallback;
  return isThemePalette(input.cookie) ? input.cookie : fallback;
}
