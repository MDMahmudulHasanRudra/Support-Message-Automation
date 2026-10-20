"use client";

import type { ReportScope } from "@support-automation/shared";

const OPTIONS: Array<{ value: ReportScope; label: string }> = [
  { value: "group", label: "Groups" },
  { value: "personal", label: "Personal chats" },
  { value: "combined", label: "Both" },
];

/**
 * Which conversations the Team Report covers (UNIFIED_REPORTING): a three-way segmented control inside
 * the filters' own GET form, so the choice is a URL (`scope=…`) like every other filter. Rendered only
 * for someone who may see personal chats; for everyone else the form carries no scope at all.
 */
export function ScopeSelector({ value, onChange }: { value: ReportScope; onChange: () => void }) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Show</legend>
      <div className="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="relative flex h-9.5 cursor-pointer items-center px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-foreground)] has-[:checked]:bg-[var(--color-accent-bg)] has-[:checked]:text-[color:var(--color-foreground)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-focus-ring)] [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--color-border)]"
          >
            <input
              type="radio"
              name="scope"
              value={option.value}
              defaultChecked={option.value === value}
              onChange={onChange}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
