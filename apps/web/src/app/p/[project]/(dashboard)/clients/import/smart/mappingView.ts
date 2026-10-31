/**
 * Which Advanced Mapping screen this browser shows (Smart Import V5 §1). The Visual Mapping grid
 * ("Spreadsheet view") is the DEFAULT and must stay the default: anything but an explicit "detailed" — nothing
 * stored, private mode, an old or unknown value — opens the grid. Remembered per browser only; never data.
 */
export type MappingView = "grid" | "detailed";

export const MAPPING_VIEW_KEY = "smart-import-mapping-view";

const listeners = new Set<() => void>();

export function readMappingView(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage): MappingView {
  try {
    return storage?.getItem(MAPPING_VIEW_KEY) === "detailed" ? "detailed" : "grid";
  } catch {
    return "grid";
  }
}

export function writeMappingView(view: MappingView): void {
  try {
    window.localStorage.setItem(MAPPING_VIEW_KEY, view);
  } catch {
    /* private mode: the toggle still works for this page */
  }
  listeners.forEach((l) => l());
}

export function subscribeMappingView(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
