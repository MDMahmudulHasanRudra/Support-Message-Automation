"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useToast } from "@/components/ui";
import { DEFAULT_CHOICE, PalettePicker, type PaletteChoice } from "@/components/theme/PalettePicker";
import { saveMyPalette } from "@/server/actions/appearance";
import { applyThemeMode, useThemeMode } from "@/lib/themeMode";
import { themePalette, type ThemeMode, type ThemePaletteId } from "@/lib/themes";

const MODES: Array<{ value: ThemeMode; label: string; hint: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", hint: "Always light", icon: Sun },
  { value: "dark", label: "Dark", hint: "Always dark", icon: Moon },
  { value: "system", label: "System", hint: "Follows this device", icon: Monitor },
];

/**
 * My account → Appearance. The colour theme is saved to the person's login (every device they sign in
 * on); Light / Dark / System is this browser's own choice, the same one the header toggle sets.
 * Picking a theme repaints the page at once, then saves; a refused save puts the old one back.
 */
export function AppearancePanel({
  current,
  installationDefault,
  disabled,
}: {
  current: ThemePaletteId | null;
  installationDefault: ThemePaletteId;
  disabled: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [choice, setChoice] = useState<PaletteChoice>(current ?? DEFAULT_CHOICE);
  const [pending, startTransition] = useTransition();
  const mode = useThemeMode();

  function paint(next: PaletteChoice) {
    document.documentElement.setAttribute("data-palette", next === DEFAULT_CHOICE ? installationDefault : next);
  }

  function choose(next: PaletteChoice) {
    if (next === choice || disabled) return;
    const previous = choice;
    setChoice(next);
    paint(next);
    startTransition(async () => {
      const result = await saveMyPalette(next);
      if (result.error) {
        setChoice(previous);
        paint(previous);
        showToast({ tone: "danger", title: "Theme not saved", description: result.error });
        return;
      }
      const name = next === DEFAULT_CHOICE ? `the default (${themePalette(installationDefault).name})` : themePalette(next).name;
      showToast({ tone: "success", title: "Theme saved", description: `You now see ${name} on every device you sign in on.` });
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Colour theme</h3>
          <span className="text-xs text-[color:var(--color-muted-foreground)]" aria-live="polite">
            {pending ? "Saving…" : "Saved to your login"}
          </span>
        </div>
        <PalettePicker label="Colour theme" value={choice} onChange={choose} defaultPalette={installationDefault} disabled={disabled} />
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Light or dark</h3>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Set on this browser only</span>
        </div>
        <div role="radiogroup" aria-label="Light or dark" className="grid grid-cols-3 gap-2 sm:max-w-md">
          {MODES.map((option) => {
            const Icon = option.icon;
            const selected = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => applyThemeMode(option.value)}
                className={`flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-[var(--radius-lg)] border px-2 py-3 text-center transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] active:translate-y-px ${
                  selected
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                <Icon className={`size-5 ${selected ? "text-[color:var(--color-accent-fg)]" : "text-[color:var(--color-muted-foreground)]"}`} aria-hidden />
                <span className="text-[13px] font-semibold">{option.label}</span>
                <span className="hidden text-[11px] text-[color:var(--color-muted-foreground)] sm:block">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
