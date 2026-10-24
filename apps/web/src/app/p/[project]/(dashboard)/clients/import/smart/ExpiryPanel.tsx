"use client";

import { CalendarClock } from "lucide-react";
import { EXPIRY_PART_KEYS, labelOf, type ExpiryMode, type ExpiryPartKey, type SmartExpiryOptions, type SmartFieldRule, type SmartMapping, type SmartRuleKey } from "@support-automation/shared";
import { Card, Select } from "@/components/ui";

/**
 * Where the subscription's expiry comes from (SMART_IMPORT.md §11). The four ways a file can say it, and
 * — only where they apply — what to do with a month that has no day and with an expiry that disagrees
 * with Start date + Duration. Nothing here is decided for the person: "last day of the month" and "use
 * the file's / the calculated expiry" are choices, never defaults.
 */

const MODES: Array<{ key: ExpiryMode; title: string; text: string }> = [
  { key: "DATE", title: "Complete expiry date", text: "One column with the full date (2027-07-24, 24/07/2027, 24 Jul 2027 or an Excel date)." },
  { key: "PARTS", title: "Separate year / month / day", text: "Three columns, e.g. Expire Year, Expire Month, Expire Day." },
  { key: "DURATION", title: "Start date + duration", text: "Calculated from Start date, Duration and Duration unit, calendar-aware." },
  { key: "MONTH_YEAR", title: "Month + year only", text: "e.g. July 2027 — you choose how the day is decided." },
];

/** The mode the mapping already implies, when the person has not chosen one. */
export function detectExpiryMode(mapping: SmartMapping): ExpiryMode {
  if (mapping.options?.expiryMode) return mapping.options.expiryMode;
  if (mapping.fields.expiryYear || mapping.fields.expiryMonth || mapping.fields.expiryDay) return mapping.fields.expiryDay ? "PARTS" : "MONTH_YEAR";
  if (mapping.fields.duration && !mapping.fields.expiryDate) return "DURATION";
  return "DATE";
}

export function ExpiryPanel({
  mapping,
  headers,
  preview,
  setRule,
  setOptions,
}: {
  mapping: SmartMapping;
  headers: string[];
  preview: Record<string, string[]>;
  setRule: (field: SmartRuleKey, rule: SmartFieldRule | undefined) => void;
  setOptions: (options: SmartExpiryOptions) => void;
}) {
  const mode = detectExpiryMode(mapping);
  const options = mapping.options ?? {};
  const partColumn = (key: ExpiryPartKey) => {
    const r = mapping.fields[key];
    return r?.mode === "source" ? r.column : "";
  };
  const chooseMode = (next: ExpiryMode) => {
    // Switching away from parts removes them, so a hidden choice can never keep deciding the expiry.
    if (next === "DATE" || next === "DURATION") for (const k of EXPIRY_PART_KEYS) setRule(k, undefined);
    if (next === "PARTS" || (next === "MONTH_YEAR" && (mapping.fields.expiryYear || mapping.fields.expiryMonth))) setRule("expiryDate", undefined);
    setOptions({ ...options, expiryMode: next });
  };
  const partsShown = mode === "PARTS" || (mode === "MONTH_YEAR" && !mapping.fields.expiryDate);
  const dayless = mode === "MONTH_YEAR" || (mode === "PARTS" && !mapping.fields.expiryDay);
  const conflictPossible = Boolean(mapping.fields.duration) && Boolean(mapping.fields.expiryDate || mapping.fields.expiryYear);

  return (
    <Card className="space-y-4 p-4!" >
      <div>
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold">
          <CalendarClock className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
          Expiry date — how your file gives it
        </h3>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">
          Every row ends up with one exact expiry date. Nothing is guessed: a missing year, day or start date is shown as a problem to fix.
        </p>
      </div>
      <div role="radiogroup" aria-label="Expiry input mode" className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={mode === m.key}
            onClick={() => chooseMode(m.key)}
            className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${mode === m.key ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.06]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
          >
            <span className="block text-[13px] font-medium">{m.title}</span>
            <span className="block text-[11.5px] leading-snug text-[color:var(--color-muted-foreground)]">{m.text}</span>
          </button>
        ))}
      </div>

      {mode === "DATE" ? <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">Choose the column under <strong>Expiry date</strong> in the Subscription fields above. With no start date, the expiry is recorded on the client — not turned into a subscription.</p> : null}
      {mode === "DURATION" ? <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">Uses <strong>Start date</strong>, <strong>Duration</strong> and <strong>Duration unit</strong> above. A month from 31 January is the last day of February; months and years are calendar months and years, never 30 or 365 days.</p> : null}

      {partsShown ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {EXPIRY_PART_KEYS.map((key) => (
            <label key={key} className="block space-y-1">
              <span className="text-[12px] font-medium">
                {labelOf(key)}
                {key === "expiryDay" && mode === "MONTH_YEAR" ? <span className="font-normal text-[color:var(--color-muted-foreground)]"> (optional)</span> : null}
              </span>
              <Select value={partColumn(key)} onChange={(e) => setRule(key, e.target.value ? { mode: "source", column: e.target.value } : undefined)} className="w-full" data-part={key}>
                <option value="">No column</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
              {partColumn(key) ? <span className="block truncate text-[11px] text-[color:var(--color-muted-foreground)]">{(preview[partColumn(key)] ?? []).join(" · ") || "empty"}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      {mode === "MONTH_YEAR" && mapping.fields.expiryDate ? <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">The <strong>Expiry date</strong> column above may hold &ldquo;July 2027&rdquo;, &ldquo;Jul-2027&rdquo;, &ldquo;2027-07&rdquo; or &ldquo;07/2027&rdquo;.</p> : null}

      {dayless ? (
        <fieldset className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <legend className="px-1 text-[12.5px] font-medium">When a row has a month and year but no day</legend>
          {(
            [
              ["REQUIRE_DAY", "Keep the row in review until the day is filled in (recommended)"],
              ["LAST_DAY", "Use the last calendar day of that month (e.g. July 2027 → 2027-07-31)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-start gap-2 text-[12.5px]">
              <input type="radio" name="month-year-policy" checked={(options.monthYearPolicy ?? "REQUIRE_DAY") === key} onChange={() => setOptions({ ...options, monthYearPolicy: key })} className="mt-0.5 accent-[var(--color-accent)]" />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}

      {conflictPossible ? (
        <fieldset className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <legend className="px-1 text-[12.5px] font-medium">When the file&apos;s expiry and Start date + Duration disagree</legend>
          {(
            [
              ["ASK", "Keep the row in review so I can correct it (recommended)"],
              ["SOURCE", "Use the file's expiry date"],
              ["CALCULATED", "Use the calculated expiry (Start date + Duration)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-start gap-2 text-[12.5px]">
              <input type="radio" name="expiry-conflict" checked={(options.expiryConflict ?? "ASK") === key} onChange={() => setOptions({ ...options, expiryConflict: key })} className="mt-0.5 accent-[var(--color-accent)]" />
              {label}
            </label>
          ))}
          <p className="text-[11.5px] text-[color:var(--color-muted-foreground)]">Rows where both agree are always accepted.</p>
        </fieldset>
      ) : null}
    </Card>
  );
}
