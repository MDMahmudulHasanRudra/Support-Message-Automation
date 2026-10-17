import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import Link from "@/components/ProjectLink";
import { ACCENT, type Accent } from "./[id]/ProfileParts";

/**
 * The shared look of the Client module's list pages (All Clients, Subscriptions, Billing List,
 * Payments & Receipts): KPI cards with an icon, chip tabs with counts, a days-left bar. Presentational
 * only — every figure is computed and authorised by the page.
 */

export const surface = "rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]";
export const mutedText = "text-[color:var(--color-muted-foreground)]";

const VALUE_TONE: Partial<Record<Accent, string>> = {
  red: "text-[color:var(--color-danger-fg)]",
  amber: "text-[color:var(--color-warning-fg)]",
  green: "text-[color:var(--color-success-fg)]",
};

/** A KPI card. With `href` it is a real link (middle-click, open in new tab), like Overview's tiles. */
export function KpiCard({
  icon: Icon,
  accent,
  label,
  value,
  hint,
  badge,
  href,
  toneValue = false,
}: {
  icon: LucideIcon;
  accent: Accent;
  label: string;
  value: string;
  hint?: string;
  badge?: ReactNode;
  href?: string;
  toneValue?: boolean;
}) {
  const body = (
    <>
      <span className={`flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] ${ACCENT[accent]}`}>
        <Icon className="size-[22px]" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className={`truncate text-[13px] ${mutedText}`}>{label}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span
            className={`font-semibold tabular-nums tracking-[-0.02em] ${value.length > 12 ? "line-clamp-2 text-base leading-snug" : "truncate text-2xl"} ${toneValue ? (VALUE_TONE[accent] ?? "") : ""}`}
            title={value}
          >
            {value}
          </span>
          {badge}
        </p>
        {hint ? (
          <p className={`truncate text-xs ${mutedText}`} title={hint}>
            {hint}
          </p>
        ) : null}
      </div>
    </>
  );
  const cls = `${surface} flex min-w-0 items-center gap-4 px-4 py-4`;
  return href ? (
    <Link href={href} className={`${cls} transition-[box-shadow,border-color] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export interface Chip {
  key: string;
  label: string;
  count?: number;
  href: string;
  active: boolean;
  tone?: "danger" | "warning";
}

/** Chip tabs with counts. A link each, so a view can be shared and survives a refresh. */
export function ChipTabs({ chips, label }: { chips: Chip[]; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 overflow-x-auto overflow-y-hidden px-1 pb-1">
      <ul className="flex min-w-max gap-2">
        {chips.map((c) => (
          <li key={c.key}>
            <Link
              href={c.href}
              aria-current={c.active ? "true" : undefined}
              className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-[13px] font-medium tabular-nums transition-colors ${
                c.active
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)]"
              }`}
            >
              {c.label}
              {c.count !== undefined ? (
                <span
                  className={
                    c.active
                      ? "opacity-80"
                      : c.tone === "danger" && c.count
                        ? "text-[color:var(--color-danger-fg)]"
                        : c.tone === "warning" && c.count
                          ? "text-[color:var(--color-warning-fg)]"
                          : mutedText
                  }
                >
                  ({c.count.toLocaleString()})
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Days left on a term, with a bar: green with room, amber inside a month, red inside a week. */
export function DaysLeftBar({ daysLeft, totalDays }: { daysLeft: number | null; totalDays: number }) {
  if (daysLeft === null) return <span className={mutedText}>—</span>;
  if (daysLeft < 0) return <span className="text-[13px] font-medium text-[color:var(--color-danger-fg)]">{Math.abs(daysLeft)} days ago</span>;
  const pct = Math.max(4, Math.min(100, (daysLeft / Math.max(1, totalDays)) * 100));
  const color = daysLeft <= 7 ? "bg-[var(--color-danger)]" : daysLeft <= 30 ? "bg-[var(--color-warning)]" : "bg-[var(--color-success)]";
  return (
    <div className="w-24">
      <p className="text-[13px]">
        <span className="font-semibold tabular-nums">{daysLeft}</span> <span className={mutedText}>day{daysLeft === 1 ? "" : "s"}</span>
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** "BD" to its flag (Windows shows the two letters instead, which still reads correctly). */
export function flag(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const DAY_MS = 86_400_000;
/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
