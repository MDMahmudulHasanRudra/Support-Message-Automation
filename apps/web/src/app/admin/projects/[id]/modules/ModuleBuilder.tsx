"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Info, Lock, Plus, RotateCcw, X } from "lucide-react";
import {
  MODULE_CATEGORIES,
  moduleDefinition,
  moduleEntitled,
  moduleSelectionDiff,
  plannedModulesFor,
  PROJECT_MODULES,
  PROJECT_TYPE_DESCRIPTIONS,
  PROJECT_TYPE_LABELS,
  removalImpact,
  resolveModuleSelection,
  templateModules,
  typeForSelection,
  type ModuleDefinition,
  type ModuleEntitlement,
  type ModuleIssue,
  type ProjectBaseType,
  type ProjectType,
} from "@support-automation/shared";
import { Alert, Badge, Button, ConfirmDialog, Dialog, Switch, Textarea, useToast } from "@/components/ui";
import { applyProjectModules, restoreProjectModules } from "@/server/actions/projectModules";
import type { ModuleTemplateOption, ProjectModuleChangeView } from "@/server/projectModules";

interface Props {
  projectId: string;
  projectType: ProjectType;
  projectBaseType: ProjectBaseType | null;
  version: number;
  enabled: string[];
  entitlement: ModuleEntitlement;
  planName: string | null;
  canManage: boolean;
  history: ProjectModuleChangeView[];
  templates: ModuleTemplateOption[];
  /** What each data-holding module keeps for this project, e.g. "124 orders". */
  dataCounts: Record<string, string>;
}

const names = (keys: readonly string[]) => keys.map((k) => moduleDefinition(k)?.name ?? k);

/**
 * The Module Builder (PROJECT_MODULES.md §5). Every rule it shows is the shared resolver's — the same
 * function the server runs again before saving — so the preview here is exactly what Apply will do.
 */
export function ModuleBuilder(props: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [requested, setRequested] = useState<string[]>(props.enabled);
  const [declined, setDeclined] = useState<string[]>([]);
  const [base, setBase] = useState<ProjectBaseType | null>(props.projectBaseType ?? (props.projectType === "CUSTOM_MIX" ? null : props.projectType));
  const [category, setCategory] = useState<string>("All");
  const [info, setInfo] = useState<ModuleDefinition | null>(null);
  const [removing, setRemoving] = useState<{ key: string; dependents: string[] } | null>(null);
  const [reason, setReason] = useState("");
  const [serverIssues, setServerIssues] = useState<ModuleIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState<string>("");

  const resolved = useMemo(
    () => resolveModuleSelection({ requested, declined, entitlement: props.entitlement, currentlyEnabled: props.enabled }),
    [requested, declined, props.entitlement, props.enabled],
  );
  const selected = useMemo(() => new Set(resolved.selected), [resolved.selected]);
  const diff = moduleSelectionDiff(props.enabled, resolved.selected);
  const type = typeForSelection(resolved.selected, base);
  const dirty = diff.added.length > 0 || diff.removed.length > 0 || type.projectType !== props.projectType || type.baseType !== props.projectBaseType;
  const requiredBy = useMemo(() => new Map(resolved.autoAdded.map((a) => [a.key, a.requiredBy])), [resolved.autoAdded]);

  const template = props.templates.find((t) => t.key === templateKey) ?? null;
  // Recorded only when what is applied IS the template; edited afterwards, it is a plain selection.
  const appliesTemplate = template !== null && [...template.modules].sort().join(",") === resolved.selected.join(",");
  const visible = PROJECT_MODULES.filter((m) => category === "All" || m.category === category);
  const planned = base ? plannedModulesFor(base) : [];

  function chooseSavedTemplate(key: string) {
    setTemplateKey(key);
    const t = props.templates.find((x) => x.key === key);
    if (!t) return;
    setBase(t.baseType);
    setRequested(t.modules);
    setDeclined(t.declined);
  }

  function chooseTemplate(next: ProjectBaseType | "CUSTOM_MIX") {
    if (next === "CUSTOM_MIX") {
      setBase(base);
      return;
    }
    setBase(next);
    setRequested(templateModules(next));
    setDeclined([]);
  }

  function toggle(key: string, on: boolean) {
    setError(null);
    setServerIssues([]);
    if (on) {
      setRequested((r) => [...new Set([...r, key])]);
      setDeclined((d) => d.filter((k) => k !== key));
      return;
    }
    const dependents = removalImpact(resolved.selected, key);
    if (dependents.length > 0) setRemoving({ key, dependents });
    else setRequested((r) => r.filter((k) => k !== key));
  }

  function confirmRemoval() {
    if (!removing) return;
    const gone = new Set([removing.key, ...removing.dependents]);
    setRequested(resolved.selected.filter((k) => !gone.has(k)));
    setRemoving(null);
  }

  function apply() {
    setError(null);
    setServerIssues([]);
    startTransition(async () => {
      const result = await applyProjectModules(props.projectId, {
        modules: resolved.selected,
        declined: resolved.declined,
        baseType: type.baseType,
        expectedVersion: props.version,
        reason,
        templateKey: appliesTemplate ? template!.key : null,
      });
      if (result.error) {
        setError(result.error);
        setServerIssues(result.issues ?? []);
        return;
      }
      showToast({ title: result.success ?? "Applied.", tone: "success" });
      setReason("");
      setTemplateKey("");
      router.refresh();
    });
  }

  function restore(change: ProjectModuleChangeView) {
    startTransition(async () => {
      const result = await restoreProjectModules(props.projectId, change.id, props.version);
      if (result.error) {
        setError(result.error);
        setServerIssues(result.issues ?? []);
        return;
      }
      showToast({ title: result.success ?? "Restored.", tone: "success" });
      router.refresh();
    });
  }

  const typeLabel = type.projectType === "CUSTOM_MIX" && type.baseType ? `Custom Mix (${PROJECT_TYPE_LABELS[type.baseType]} base)` : PROJECT_TYPE_LABELS[type.projectType];

  return (
    <div className="space-y-6">
      <section aria-labelledby="types-title">
        <h2 id="types-title" className="mb-3 text-sm font-semibold text-[color:var(--color-foreground)]">
          Business type
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(["DEFAULT", "ECOMMERCE", "CUSTOM_MIX"] as const).map((t) => {
            const active = t === "CUSTOM_MIX" ? type.projectType === "CUSTOM_MIX" : type.projectType === t;
            return (
              <button
                key={t}
                type="button"
                disabled={!props.canManage}
                onClick={() => chooseTemplate(t)}
                aria-pressed={active}
                className={`rounded-[var(--radius-lg)] border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                  active ? "border-[var(--color-primary)] bg-[var(--color-neutral-bg)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                <span className="block text-sm font-semibold">{PROJECT_TYPE_LABELS[t]}</span>
                <span className="mt-1 block text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{PROJECT_TYPE_DESCRIPTIONS[t]}</span>
                {t !== "CUSTOM_MIX" ? (
                  <span className="mt-2 block text-[11px] text-[color:var(--color-subtle-foreground)]">Loads its recommended modules; change any of them after.</span>
                ) : (
                  <span className="mt-2 block text-[11px] text-[color:var(--color-subtle-foreground)]">Keeps the current selection; switch any module below.</span>
                )}
              </button>
            );
          })}
        </div>
        {props.templates.length > 0 && props.canManage ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="module-template" className="text-[color:var(--color-muted-foreground)]">
              Or start from a template:
            </label>
            <select
              id="module-template"
              value={templateKey}
              onChange={(e) => chooseSavedTemplate(e.target.value)}
              className="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            >
              <option value="">Choose a template…</option>
              <optgroup label="Built-in">
                {props.templates
                  .filter((t) => t.builtIn)
                  .map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
              {props.templates.some((t) => !t.builtIn) ? (
                <optgroup label="Your templates">
                  {props.templates
                    .filter((t) => !t.builtIn)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name} (v{t.version})
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
            {template ? (
              <span className="text-xs text-[color:var(--color-muted-foreground)]">
                {appliesTemplate ? "The changes below show what this template changes here." : "Edited after choosing the template: it will be saved as your own selection."}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)_300px]">
        <nav aria-label="Module categories" className="lg:sticky lg:top-4 lg:self-start">
          <label className="sr-only" htmlFor="module-category">
            Category
          </label>
          <select
            id="module-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm lg:hidden"
          >
            {["All", ...MODULE_CATEGORIES].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <ul className="hidden space-y-0.5 lg:block">
            {["All", ...MODULE_CATEGORIES].map((c) => {
              const count = c === "All" ? resolved.selected.length : PROJECT_MODULES.filter((m) => m.category === c && selected.has(m.key)).length;
              return (
                <li key={c}>
                  <button
                    type="button"
                    onClick={() => setCategory(c)}
                    aria-current={category === c}
                    className={`flex w-full items-center justify-between rounded-[var(--radius-md)] px-3 py-1.5 text-left text-sm ${
                      category === c ? "bg-[var(--color-neutral-bg)] font-medium" : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"
                    }`}
                  >
                    {c}
                    <span className="text-xs tabular-nums text-[color:var(--color-subtle-foreground)]">{count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {visible.map((m) => {
            const on = selected.has(m.key);
            const entitled = m.status === "AVAILABLE" && (props.enabled.includes(m.key) || moduleEntitled(props.entitlement, m.key));
            const locked = m.status !== "AVAILABLE" || !entitled || !props.canManage;
            const hard = m.dependencies.filter((d) => d.kind === "HARD").length;
            return (
              <div
                key={m.key}
                className={`flex flex-col gap-2 rounded-[var(--radius-lg)] border p-4 ${on ? "border-[var(--color-primary)]/50 bg-[var(--color-surface)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-snug">{m.name}</p>
                    <p className="text-[11px] uppercase tracking-wide text-[color:var(--color-subtle-foreground)]">{m.category}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setInfo(m)}
                      aria-label={`About ${m.name}`}
                      className="rounded-full p-1 text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    >
                      <Info className="size-4" aria-hidden />
                    </button>
                    {m.status === "AVAILABLE" ? (
                      <Switch checked={on} disabled={locked} onChange={(e) => toggle(m.key, e.target.checked)} aria-label={`${on ? "Switch off" : "Switch on"} ${m.name}`} />
                    ) : null}
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{m.description}</p>
                <div className="mt-auto flex flex-wrap gap-1.5">
                  {m.status === "PLANNED" ? <Badge color="gray">Coming soon</Badge> : null}
                  {m.status === "AVAILABLE" && !entitled ? (
                    <Badge color="yellow">
                      <Lock className="mr-1 inline size-3" aria-hidden />
                      Not in plan
                    </Badge>
                  ) : null}
                  {requiredBy.has(m.key) ? <Badge color="blue">Added: needed by {moduleDefinition(requiredBy.get(m.key)!)?.name}</Badge> : null}
                  {hard > 0 ? <Badge color="gray">{hard} required</Badge> : null}
                  {m.manualOnly ? <Badge color="gray">Manual switch</Badge> : null}
                  {props.enabled.includes(m.key) && !on ? <Badge color="red">Will switch off</Badge> : null}
                  {!on && props.dataCounts[m.key] ? <Badge color="gray">Data kept: {props.dataCounts[m.key]}</Badge> : null}
                  {!props.enabled.includes(m.key) && on ? <Badge color="green">Will switch on</Badge> : null}
                </div>
              </div>
            );
          })}
        </div>

        <aside aria-label="Selected configuration" className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <p className="text-xs text-[color:var(--color-muted-foreground)]">Will be recorded as</p>
            <p className="text-base font-semibold">{typeLabel}</p>
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {resolved.selected.length} module{resolved.selected.length === 1 ? "" : "s"} on · plan: {props.planName ?? "none (nothing held back)"}
            </p>

            {resolved.recommended.length > 0 ? (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium">Recommended</p>
                {resolved.recommended.map((r) => (
                  <div key={r.key} className="rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-2 text-xs">
                    <p>
                      <span className="font-medium">{moduleDefinition(r.key)?.name}</span> for {moduleDefinition(r.recommendedBy)?.name}: {r.why}
                    </p>
                    {props.canManage ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => toggle(r.key, true)}>
                          <Plus className="size-3" aria-hidden />
                          Add
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeclined((d) => [...new Set([...d, r.key])])}>
                          <X className="size-3" aria-hidden />
                          Not now
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {planned.length > 0 ? (
              <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">
                Coming to {PROJECT_TYPE_LABELS[base!]}: {names(planned).join(", ")}. They switch on here once they ship.
              </p>
            ) : null}

            {dirty ? (
              <div className="mt-4 space-y-1 border-t border-[var(--color-border)] pt-3 text-xs">
                <p className="font-medium">Changes</p>
                {diff.added.length > 0 ? <p className="text-[color:var(--color-success)]">On: {names(diff.added).join(", ")}</p> : null}
                {diff.removed.length > 0 ? (
                  <p className="text-[color:var(--color-danger)]">Off (pages hidden, background work stops, data kept): {names(diff.removed).join(", ")}</p>
                ) : null}
                {diff.added.length === 0 && diff.removed.length === 0 ? <p>Only the business type changes.</p> : null}
              </div>
            ) : (
              <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">No changes.</p>
            )}

            {resolved.grandfathered.length > 0 ? (
              <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
                Kept although the plan would not add them today: {names(resolved.grandfathered).join(", ")}.
              </p>
            ) : null}

            {[...resolved.issues, ...serverIssues].length > 0 || error ? (
              <div className="mt-3">
                <Alert tone="danger">
                  {error ? <p>{error}</p> : null}
                  <ul className="list-disc pl-4">
                    {[...new Map([...resolved.issues, ...serverIssues].map((i) => [i.message, i])).values()].map((i) => (
                      <li key={i.message}>{i.message}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            ) : null}

            {props.canManage ? (
              <div className="mt-4 space-y-2">
                <label htmlFor="module-reason" className="text-xs font-medium">
                  Reason (recorded in the history)
                </label>
                <Textarea id="module-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer bought the Team Report add-on" />
                <div className="flex gap-2">
                  <Button onClick={apply} loading={pending} disabled={!dirty || !resolved.ok}>
                    Apply configuration
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!dirty || pending}
                    onClick={() => {
                      setRequested(props.enabled);
                      setDeclined([]);
                      setBase(props.projectBaseType ?? (props.projectType === "CUSTOM_MIX" ? null : props.projectType));
                    }}
                  >
                    Revert
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {props.history.length > 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <p className="text-sm font-semibold">History</p>
              <ul className="mt-2 space-y-3 text-xs">
                {props.history.map((h) => {
                  const d = moduleSelectionDiff(h.previousModules, h.modules);
                  return (
                    <li key={h.id} className="border-t border-[var(--color-border)] pt-2 first:border-0 first:pt-0">
                      <p className="font-medium">
                        v{h.version} · {h.projectType === "CUSTOM_MIX" && h.projectBaseType ? `Custom Mix (${PROJECT_TYPE_LABELS[h.projectBaseType]} base)` : PROJECT_TYPE_LABELS[h.projectType]}
                      </p>
                      <p className="text-[color:var(--color-muted-foreground)]">
                        {new Date(h.createdAt).toLocaleString()} · {h.actorUsername}
                      </p>
                      {d.added.length ? <p>On: {names(d.added).join(", ")}</p> : null}
                      {d.removed.length ? <p>Off: {names(d.removed).join(", ")}</p> : null}
                      {h.templateKey ? (
                        <p>
                          Template: {props.templates.find((t) => t.key === h.templateKey)?.name ?? "a template no longer offered"}
                          {h.templateVersion ? ` v${h.templateVersion}` : ""}
                        </p>
                      ) : null}
                      {h.reason ? <p className="italic">{h.reason}</p> : null}
                      {props.canManage && h.version !== props.version ? (
                        <Button size="sm" variant="ghost" className="mt-1" disabled={pending} onClick={() => restore(h)}>
                          <RotateCcw className="size-3" aria-hidden />
                          Restore this configuration
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>

      {info ? <ModuleInfoDialog module={info} onClose={() => setInfo(null)} enabled={selected.has(info.key)} entitled={props.enabled.includes(info.key) || moduleEntitled(props.entitlement, info.key)} /> : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemoval}
        title={removing ? `Switch off ${moduleDefinition(removing.key)?.name}?` : ""}
        description="These modules cannot work without it, so they will be switched off too. Their data and settings are kept, and they come back unchanged when switched on again."
        confirmLabel="Switch them off"
        tone="danger"
      >
        {removing ? (
          <ul className="list-disc pl-5 text-sm">
            {names(removing.dependents).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function ModuleInfoDialog({ module: m, onClose, enabled, entitled }: { module: ModuleDefinition; onClose: () => void; enabled: boolean; entitled: boolean }) {
  const group = (kind: "HARD" | "RECOMMENDED" | "OPTIONAL") => m.dependencies.filter((d) => d.kind === kind);
  return (
    <Dialog open onClose={onClose} title={m.name} description={m.description} size="lg">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Badge color={m.status === "AVAILABLE" ? "green" : "gray"}>{m.status === "AVAILABLE" ? "Available" : "Coming soon"}</Badge>
          <Badge color={enabled ? "blue" : "gray"}>{enabled ? "On in this selection" : "Off in this selection"}</Badge>
          {m.status === "AVAILABLE" ? <Badge color={entitled ? "green" : "yellow"}>{entitled ? "Included in plan" : "Not in plan"}</Badge> : null}
          {m.hasBackgroundJobs ? <Badge color="gray">Runs background work</Badge> : null}
        </div>
        {m.benefits.length ? <InfoList title="Why use it" items={m.benefits} /> : null}
        {group("HARD").length ? <InfoList title="Requires" items={group("HARD").map((d) => `${d.anyOf.map((k) => moduleDefinition(k)?.name ?? k).join(" or ")} — ${d.why}`)} /> : null}
        {group("RECOMMENDED").length ? <InfoList title="Recommended with" items={group("RECOMMENDED").map((d) => `${d.anyOf.map((k) => moduleDefinition(k)?.name ?? k).join(" or ")} — ${d.why}`)} /> : null}
        {group("OPTIONAL").length ? <InfoList title="Can connect later" items={group("OPTIONAL").map((d) => `${d.anyOf.map((k) => moduleDefinition(k)?.name ?? k).join(" or ")} — ${d.why}`)} /> : null}
        {m.aiCapabilities.length ? <InfoList title="What it lets AI do" items={m.aiCapabilities} /> : null}
        {m.permissionKeys.length ? <InfoList title="Permissions it uses" items={m.permissionKeys.map((k) => k)} mono /> : null}
        {m.setupSteps.length ? <InfoList title="Setup" items={m.setupSteps} /> : null}
        <InfoList title="When switched off" items={[m.whenOff, m.dataWhenOff]} />
        {m.manualOnly ? <p className="text-xs text-[color:var(--color-muted-foreground)]">Switched only by a person — a plan never turns it on or off.</p> : null}
        {m.documentation ? <p className="text-xs text-[color:var(--color-muted-foreground)]">Reference: {m.documentation}</p> : null}
      </div>
    </Dialog>
  );
}

function InfoList({ title, items, mono = false }: { title: string; items: readonly string[]; mono?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-subtle-foreground)]">{title}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.map((item) => (
          <li key={item} className={mono ? "font-mono text-xs" : ""}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
