"use client";

import { useActionState, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { PERMISSIONS } from "@support-automation/shared";
import { Alert, Button, Card, Checkbox, Field, Input, SectionHeader, Textarea } from "@/components/ui";
import type { ProjectAdminState } from "@/server/actions/projectAdmin";
import { ACCESS_MODULES, ALL_SECTIONS, writeKeysOf, type AccessSection, type SectionLevel } from "../projectSections";

/**
 * A project role: a name, and which pages of THIS project it opens — module by module, sub-module by
 * sub-module, each Hidden, Read (open and look) or Full (also change things) — plus which parts of the
 * Dashboard it shows. The tree is the sidebar's own (projectSections.ts), so the Lead picks from exactly
 * what members will see. Only project pages are offered; the server re-checks whatever is submitted.
 */

type Choice = "NONE" | SectionLevel;
type Access = Record<string, SectionLevel>;

const KEY_LABEL = new Map(PERMISSIONS.map((p) => [p.key, p.label]));

function optionsOf(sections: readonly AccessSection[]): Choice[] {
  const levels = new Set(sections.flatMap((s) => s.levels));
  return ["NONE", ...(["READ", "FULL"] as const).filter((l) => levels.has(l))];
}

/** What one section becomes when a whole module or entry is set to a choice: the nearest level it offers. */
function target(section: AccessSection, choice: Choice): SectionLevel | null {
  if (choice === "NONE") return null;
  if (section.levels.includes(choice)) return choice;
  // Full on a read-only page is Read; Read on a page that only opens to change something is hidden.
  return choice === "FULL" && section.levels.includes("READ") ? "READ" : null;
}

function stateOf(sections: readonly AccessSection[], access: Access): Choice | "MIXED" {
  const options = optionsOf(sections);
  for (const choice of [...options].reverse()) {
    if (sections.every((s) => (access[s.id] ?? null) === target(s, choice))) return choice;
  }
  return "MIXED";
}

const CHOICE_LABEL: Record<Choice, string> = { NONE: "Hidden", READ: "Read", FULL: "Full" };

function LevelPicker({
  value,
  options,
  onChange,
  label,
  readLabel = "Read",
}: {
  value: Choice | "MIXED";
  options: Choice[];
  onChange: (choice: Choice) => void;
  label: string;
  readLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-0.5">
      {options.map((choice) => {
        const selected = value === choice;
        const tone =
          choice === "FULL"
            ? "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)] border-[var(--color-success-border)]"
            : choice === "READ"
              ? "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)] border-[var(--color-info-border)]"
              : "bg-[var(--color-surface)] text-[color:var(--color-foreground)] border-[var(--color-border-strong)]";
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice)}
            className={`min-w-[3.75rem] rounded-[calc(var(--radius-md)-2px)] border px-2.5 py-1 text-[12px] font-medium transition-colors duration-[var(--duration-base)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
              selected ? tone : "border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            {choice === "READ" ? readLabel : CHOICE_LABEL[choice]}
          </button>
        );
      })}
      {value === "MIXED" ? (
        <span className="self-center px-2 text-[11px] font-medium text-[color:var(--color-warning-fg)]" title="Its pages are set differently — open it to see">
          Custom
        </span>
      ) : null}
    </div>
  );
}

function fullAdds(section: AccessSection): string | null {
  if (section.writeKeys.length === 0 || !section.levels.includes("READ")) return null;
  return section.writeKeys.map((k) => KEY_LABEL.get(k) ?? k).join(" · ");
}

export function ProjectRoleForm({
  action,
  defaults = {},
  submitLabel,
  legacy = false,
}: {
  action: (prev: ProjectAdminState, form: FormData) => Promise<ProjectAdminState>;
  defaults?: { name?: string; description?: string | null; sectionAccess?: Access; excludedKeys?: string[] };
  submitLabel: string;
  /** The role was saved before pages could be chosen: the tree starts from what its permissions opened. */
  legacy?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [access, setAccess] = useState<Access>(() => ({ ...(defaults.sectionAccess ?? {}) }));
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(defaults.excludedKeys ?? []));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");

  const apply = (sections: readonly AccessSection[], choice: Choice) =>
    setAccess((prev) => {
      const next = { ...prev };
      for (const s of sections) {
        const level = target(s, choice);
        if (level) next[s.id] = level;
        else delete next[s.id];
      }
      return next;
    });

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pageSections = useMemo(() => ALL_SECTIONS.filter((s) => !s.id.startsWith("dashboard:")), []);
  const dashboardSections = useMemo(() => ALL_SECTIONS.filter((s) => s.id.startsWith("dashboard:")), []);
  const pagesOpen = pageSections.filter((s) => access[s.id]).length;
  const pagesFull = pageSections.filter((s) => access[s.id] === "FULL").length;
  const dashboardShown = dashboardSections.filter((s) => access[s.id]).length;
  const fineTune = useMemo(() => writeKeysOf(access), [access]);

  const needle = query.trim().toLowerCase();
  const matches = (s: AccessSection, entryLabel: string, moduleLabel: string) =>
    !needle || `${moduleLabel} ${entryLabel} ${s.label}`.toLowerCase().includes(needle);

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Role" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" required hint="Unique in this project, e.g. Support Agent, Billing Officer.">
            <Input name="name" defaultValue={defaults.name} maxLength={80} required />
          </Field>
          <Field label="Description">
            <Textarea name="description" defaultValue={defaults.description ?? ""} rows={1} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Pages"
          description="Choose, module by module, which pages members with this role see in the sidebar and can open. Read lets them open and look; Full also lets them change things there. Hidden pages do not appear at all."
        />
        {legacy ? (
          <div className="mb-4">
            <Alert tone="info" title="This role was saved before pages could be chosen">
              It currently opens every page its permissions allow, shown below. Saving keeps exactly this selection and from then on members see only these pages.
            </Alert>
          </div>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" aria-hidden />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a page…" aria-label="Find a page" className="pl-8" />
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => apply(ALL_SECTIONS, "READ")}>
            Read everything
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => apply(ALL_SECTIONS, "FULL")}>
            Full everything
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => apply(ALL_SECTIONS, "NONE")}>
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen((prev) => (prev.size === ACCESS_MODULES.length ? new Set() : new Set(ACCESS_MODULES.map((m) => m.id))))}
          >
            {open.size === ACCESS_MODULES.length ? "Collapse all" : "Expand all"}
          </Button>
        </div>

        <p className="mb-3 text-[12px] text-[color:var(--color-muted-foreground)]">
          {pagesOpen} page{pagesOpen === 1 ? "" : "s"} open{pagesFull ? `, ${pagesFull} with Full` : ""} · Dashboard: {dashboardShown} of {dashboardSections.length} parts shown
        </p>

        <div className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
          {ACCESS_MODULES.map((module) => {
            const sections = module.groups.flatMap((g) => g.entries.flatMap((e) => e.sections));
            const visible = module.groups.some((g) => g.entries.some((e) => e.sections.some((s) => matches(s, e.label, module.label))));
            if (!visible) return null;
            const expanded = open.has(module.id) || Boolean(needle);
            const isDashboard = module.id === "dashboard";
            const count = sections.filter((s) => access[s.id]).length;
            return (
              <div key={module.id}>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleOpen(module.id)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                  >
                    <ChevronRight className={`size-4 shrink-0 text-[color:var(--color-subtle-foreground)] transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
                    <span className="truncate text-[13px] font-semibold">{module.label}</span>
                    <span className="shrink-0 text-[12px] text-[color:var(--color-muted-foreground)]">
                      {count}/{sections.length}
                    </span>
                  </button>
                  <LevelPicker
                    label={`${module.label}: all pages`}
                    value={stateOf(sections, access)}
                    options={optionsOf(sections)}
                    onChange={(choice) => apply(sections, choice)}
                    readLabel={isDashboard ? "Show" : "Read"}
                  />
                </div>
                {expanded ? (
                  <div className="space-y-3 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-3">
                    {module.description ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">{module.description}</p> : null}
                    {module.groups.map((group) => {
                      const entries = group.entries.filter((e) => e.sections.some((s) => matches(s, e.label, module.label)));
                      if (!entries.length) return null;
                      return (
                        <div key={group.label ?? "pages"} className="space-y-1.5">
                          {group.label ? (
                            <p className="pt-1 text-[11px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase">{group.label}</p>
                          ) : null}
                          {entries.map((entry) => (
                            <div key={entry.label} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                              {entry.sections.length > 1 ? (
                                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                                  <span className="min-w-0 flex-1 text-[13px] font-medium">{entry.label}</span>
                                  <LevelPicker
                                    label={`${entry.label}: all tabs`}
                                    value={stateOf(entry.sections, access)}
                                    options={optionsOf(entry.sections)}
                                    onChange={(choice) => apply(entry.sections, choice)}
                                  />
                                </div>
                              ) : null}
                              {entry.sections.map((section) => {
                                const adds = fullAdds(section);
                                return (
                                  <div
                                    key={section.id}
                                    className={`flex flex-wrap items-center gap-2 px-3 py-2 ${entry.sections.length > 1 ? "pl-7" : ""}`}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[13px]">{section.label}</p>
                                      {section.description ? (
                                        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">{section.description}</p>
                                      ) : adds ? (
                                        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Full lets them change things on this page ({adds}).</p>
                                      ) : !section.levels.includes("READ") ? (
                                        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Only opens to change something, so it is Full or hidden.</p>
                                      ) : !isDashboard ? (
                                        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">A read-only page.</p>
                                      ) : null}
                                    </div>
                                    <LevelPicker
                                      label={section.label}
                                      value={access[section.id] ?? "NONE"}
                                      options={optionsOf([section])}
                                      onChange={(choice) => apply([section], choice)}
                                      readLabel={isDashboard ? "Show" : "Read"}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <input type="hidden" name="sectionAccess" value={JSON.stringify(access)} />
      </Card>

      {fineTune.length > 0 ? (
        <Card>
          <details>
            <summary className="cursor-pointer text-[13px] font-semibold">
              Fine-tune what Full allows ({fineTune.filter((k) => !excluded.has(k)).length} of {fineTune.length} on)
            </summary>
            <p className="mt-2 mb-3 text-[12px] text-[color:var(--color-muted-foreground)]">
              Optional. Full gives every action of its pages; untick one to hold it back — for example, let members edit clients but not delete them. Reading is
              never affected.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {fineTune.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={!excluded.has(key)}
                    onChange={() =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">{KEY_LABEL.get(key) ?? key}</span>
                </label>
              ))}
            </div>
          </details>
          {fineTune
            .filter((k) => excluded.has(k))
            .map((key) => (
              <input key={key} type="hidden" name="excludedKeys" value={key} />
            ))}
        </Card>
      ) : null}

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
