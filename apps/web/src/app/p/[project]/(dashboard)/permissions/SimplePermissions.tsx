"use client";

import { ADMIN_GRANTED_KEYS, MAIN_ADMIN_CATEGORY, PERMISSIONS, VENDOR_PERMISSION_KEYS } from "@support-automation/shared";

/**
 * The role form's Simple view: one choice per module (No access / View / Full) instead of every key. It only
 * ever writes the same permission keys the Detailed view does. Sensitive keys are never set from here: the
 * administration categories, Main Admin, and the keys only a Main Admin may grant are Detailed only, and a
 * sensitive key already on the role is kept when Full is chosen.
 */
export type SimpleLevel = "NONE" | "VIEW" | "FULL" | "CUSTOM";

const DETAILED_ONLY_CATEGORIES = new Set([MAIN_ADMIN_CATEGORY, "Users & Permissions", "Project Administration"]);
const NEVER_FROM_SIMPLE = new Set([...ADMIN_GRANTED_KEYS, ...VENDOR_PERMISSION_KEYS]);

export const SIMPLE_CATEGORIES = Array.from(new Set(PERMISSIONS.map((p) => p.category)))
  .filter((c) => !DETAILED_ONLY_CATEGORIES.has(c))
  .map((category) => {
    const keys = PERMISSIONS.filter((p) => p.category === category).map((p) => p.key);
    return {
      category,
      all: keys,
      view: keys.filter((k) => k.endsWith(".view")),
      full: keys.filter((k) => !NEVER_FROM_SIMPLE.has(k)),
    };
  });

export const DETAILED_ONLY = Array.from(DETAILED_ONLY_CATEGORIES).filter((c) => PERMISSIONS.some((p) => p.category === c));

export function levelOf(entry: (typeof SIMPLE_CATEGORIES)[number], checked: ReadonlySet<string>): SimpleLevel {
  const on = entry.all.filter((k) => checked.has(k));
  if (on.length === 0) return "NONE";
  const managed = on.filter((k) => !NEVER_FROM_SIMPLE.has(k));
  if (managed.length === entry.full.length) return "FULL";
  if (entry.view.length > 0 && on.length === entry.view.length && entry.view.every((k) => checked.has(k))) return "VIEW";
  return "CUSTOM";
}

export function applyLevel(entry: (typeof SIMPLE_CATEGORIES)[number], level: "NONE" | "VIEW" | "FULL", checked: ReadonlySet<string>): Set<string> {
  const next = new Set(checked);
  const keepSensitive = level === "FULL" ? entry.all.filter((k) => NEVER_FROM_SIMPLE.has(k) && checked.has(k)) : [];
  for (const k of entry.all) next.delete(k);
  const add = level === "NONE" ? [] : level === "VIEW" ? entry.view : entry.full;
  for (const k of [...add, ...keepSensitive]) next.add(k);
  return next;
}

const LEVELS: Array<{ key: "NONE" | "VIEW" | "FULL"; label: string }> = [
  { key: "NONE", label: "No access" },
  { key: "VIEW", label: "View" },
  { key: "FULL", label: "Full" },
];

export function SimplePermissions({ checked, onChange, onDetailed }: { checked: ReadonlySet<string>; onChange: (next: Set<string>) => void; onDetailed: () => void }) {
  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
        {SIMPLE_CATEGORIES.map((entry) => {
          const level = levelOf(entry, checked);
          return (
            <li key={entry.category} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0 text-[13.5px] font-medium text-[color:var(--color-foreground)]">
                {entry.category}
                {level === "CUSTOM" ? (
                  <button type="button" onClick={onDetailed} className="ml-2 rounded-full bg-[var(--color-neutral-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                    Custom · see Detailed
                  </button>
                ) : null}
              </span>
              <div role="radiogroup" aria-label={`${entry.category} access`} className="inline-flex rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-0.5">
                {LEVELS.filter((l) => l.key !== "VIEW" || entry.view.length > 0).map((l) => {
                  const active = level === l.key;
                  return (
                    <button
                      key={l.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onChange(applyLevel(entry, l.key, checked))}
                      className={`rounded-[calc(var(--radius-md)-2px)] px-3 py-1 text-[12.5px] font-medium transition-colors ${
                        active
                          ? l.key === "NONE"
                            ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]"
                            : "bg-[var(--color-accent)] text-white shadow-[var(--shadow-xs)]"
                          : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        View lets them look; Full lets them do everything in that module. {DETAILED_ONLY.join(", ")} and sensitive permissions such as deleting client records are set in{" "}
        <button type="button" onClick={onDetailed} className="font-medium text-[color:var(--color-accent-fg)] hover:underline">
          Detailed
        </button>
        .
      </p>
    </div>
  );
}
