"use client";

import { Check } from "lucide-react";
import { useRef } from "react";
import { THEME_PALETTES, themePalette, type ThemePalette, type ThemePaletteId } from "@/lib/themes";

/**
 * The colour-theme picker shared by My account → Appearance and Main Admin → Branding: one card per
 * palette, each a small drawing of the console in that palette (the deep field, its active item and
 * mark, the sheet, a primary button and an accent link). A radio group: arrow keys move between cards.
 *
 * `DEFAULT_CHOICE` is the person's "use the installation's default" option; it is offered only when
 * `defaultPalette` is given, and draws that palette.
 */

export const DEFAULT_CHOICE = "default";
export type PaletteChoice = ThemePaletteId | typeof DEFAULT_CHOICE;

export function PalettePicker({
  value,
  onChange,
  defaultPalette,
  disabled,
  label,
}: {
  value: PaletteChoice;
  onChange: (next: PaletteChoice) => void;
  /** When set, a first card "Installation default" is offered, drawn in this palette. */
  defaultPalette?: ThemePaletteId;
  disabled?: boolean;
  label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const options: Array<{ choice: PaletteChoice; palette: ThemePalette; title: string; description: string }> = [
    ...(defaultPalette
      ? [
          {
            choice: DEFAULT_CHOICE as PaletteChoice,
            palette: themePalette(defaultPalette),
            title: "Installation default",
            description: `Follows what your administrator chose, now ${themePalette(defaultPalette).name}.`,
          },
        ]
      : []),
    ...THEME_PALETTES.map((p) => ({ choice: p.id as PaletteChoice, palette: p, title: p.name, description: p.description })),
  ];

  function move(from: number, step: number) {
    const next = (from + step + options.length) % options.length;
    onChange(options[next].choice);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
      {options.map((option, index) => {
        const selected = option.choice === value;
        return (
          <button
            key={option.choice}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (index === 0 && !options.some((o) => o.choice === value)) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.choice)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(index, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(index, -1);
              }
            }}
            className={`group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--color-surface)] text-left transition-[border-color,box-shadow,transform] duration-[var(--duration-fast)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${
              selected
                ? "border-[var(--color-accent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_22%,transparent)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)]"
            }`}
          >
            <PaletteDrawing palette={option.palette} />
            <span className="flex items-start gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[color:var(--color-foreground)]">{option.title}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[color:var(--color-muted-foreground)]">{option.description}</span>
              </span>
              <span
                aria-hidden
                className={`mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  selected ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white" : "border-[var(--color-border-strong)] bg-[var(--color-surface)]"
                }`}
              >
                {selected ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A tiny drawing of the console: deep field across the top and down the left, the sheet inside it.
 * Pure colour from the catalogue, so it shows a palette that is not the one the page is using.
 */
export function PaletteDrawing({ palette, accentOverride, className = "h-[86px]" }: { palette: ThemePalette; accentOverride?: string | null; className?: string }) {
  const s = palette.swatch;
  const accent = accentOverride ?? s.accent;
  const field = accentOverride ? `color-mix(in oklab, ${accentOverride} 26%, #04181d)` : s.field;
  const active = accentOverride ? `color-mix(in oklab, ${accentOverride} 62%, #083138)` : s.active;
  const mark = accentOverride ? `color-mix(in oklab, ${accentOverride} 62%, white)` : s.mark;
  return (
    <span aria-hidden className={`relative block w-full ${className}`} style={{ background: field }}>
      {/* Header: the mark and a search pill. */}
      <span className="absolute left-2.5 top-2 block size-3 rounded-[3px]" style={{ background: mark }} />
      <span className="absolute left-7 right-[46%] top-2.5 block h-2 rounded-full bg-white/12" />
      <span className="absolute right-2.5 top-2 block size-3 rounded-full bg-white/20" />
      {/* Navigation: one active item. */}
      <span className="absolute left-2 top-8 block h-2.5 w-[18%] rounded-[3px]" style={{ background: active }} />
      <span className="absolute left-2 top-[46px] block h-1.5 w-[14%] rounded-full bg-white/18" />
      <span className="absolute left-2 top-[58px] block h-1.5 w-[16%] rounded-full bg-white/18" />
      <span className="absolute left-2 top-[70px] block h-1.5 w-[12%] rounded-full bg-white/18" />
      {/* The sheet, with a card holding a primary button and an accent link. */}
      <span className="absolute bottom-0 left-[26%] right-0 top-7 block rounded-tl-[8px]" style={{ background: s.sheet }}>
        <span className="absolute left-2.5 top-2.5 block h-1.5 w-[42%] rounded-full" style={{ background: s.primary, opacity: 0.75 }} />
        <span className="absolute left-2.5 right-2.5 top-6 block h-[34px] rounded-[5px] border border-black/5 bg-white">
          <span className="absolute left-2 top-2 block h-1.5 w-[38%] rounded-full bg-black/10" />
          <span className="absolute bottom-2 left-2 block h-2.5 w-[30%] rounded-[3px]" style={{ background: s.primary }} />
          <span className="absolute bottom-[11px] left-[40%] block h-1 w-[22%] rounded-full" style={{ background: accent }} />
          <span className="absolute right-2 top-2 block size-2 rounded-full" style={{ background: accent }} />
        </span>
      </span>
    </span>
  );
}
