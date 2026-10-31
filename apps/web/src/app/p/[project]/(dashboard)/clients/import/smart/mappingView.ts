/**
 * Which Advanced Mapping screen this browser shows (Smart Import V5 §1). The Visual Mapping grid
 * ("Spreadsheet view") is the DEFAULT and must stay the default: anything but an explicit "detailed" — nothing
 * stored, private mode, an old or unknown value — opens the grid. Remembered per browser only; never data.
 */
import type { SmartFieldRule, SmartMapping, SmartRuleKey } from "@support-automation/shared";

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

/**
 * The mapping exactly as the editor sends it to the server: every part it holds (fields, expiry options, the
 * auto-fill switch, amounts, kept columns), with a "From file" rule whose column is not chosen yet sent as empty,
 * never as a guess, and blank amount rows left out. Both views save through this.
 */
export function mappingToSave(mapping: SmartMapping): SmartMapping {
  const fields: SmartMapping["fields"] = {};
  for (const [k, rule] of Object.entries(mapping.fields) as Array<[SmartRuleKey, SmartFieldRule]>) {
    if (rule.mode === "source" && !rule.column) continue;
    fields[k] = rule;
  }
  const money = mapping.money?.mode === "MULTI" ? { ...mapping.money, columns: mapping.money.columns.filter((c) => c.column || c.currency) } : mapping.money;
  return {
    version: 2,
    fields,
    ...(mapping.options ? { options: mapping.options } : {}),
    ...(mapping.fillLocale === false ? { fillLocale: false } : {}),
    ...(mapping.useFileCodes === true ? { useFileCodes: true } : {}),
    ...(money ? { money } : {}),
    ...(mapping.keepColumns?.length ? { keepColumns: mapping.keepColumns } : {}),
  };
}
