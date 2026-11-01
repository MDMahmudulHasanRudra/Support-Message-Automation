"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  MODULE_CATEGORIES,
  moduleDefinition,
  PROJECT_MODULES,
  PROJECT_TYPE_LABELS,
  removalImpact,
  resolveModuleSelection,
  TEMPLATE_ENTITLEMENT,
  templateModules,
  type ModuleIssue,
} from "@support-automation/shared";
import { Alert, Badge, Button, Checkbox, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { saveModuleTemplate } from "@/server/actions/moduleTemplates";

interface Initial {
  name: string;
  description: string;
  baseType: "DEFAULT" | "ECOMMERCE";
  modules: string[];
  declined: string[];
  version: number;
}

// A template only lists modules; applying it is checked against the project (MODULE_APPROVALS.md).
const OPEN = TEMPLATE_ENTITLEMENT;

/**
 * Template editor: the same shared resolver as the Module Builder, without a plan (a template is
 * checked against a plan only when it is applied to a project). Unticking a module that others need
 * also unticks them, and says so.
 */
export function TemplateEditor({ id, initial }: { id: string | null; initial: Initial }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [baseType, setBaseType] = useState<"DEFAULT" | "ECOMMERCE">(initial.baseType);
  const [requested, setRequested] = useState<string[]>(initial.modules.length ? initial.modules : templateModules(initial.baseType));
  const [declined, setDeclined] = useState<string[]>(initial.declined);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ModuleIssue[]>([]);

  const resolved = useMemo(() => resolveModuleSelection({ requested, declined, entitlement: OPEN }), [requested, declined]);
  const selected = new Set(resolved.selected);
  const autoAdded = new Map(resolved.autoAdded.map((a) => [a.key, a.requiredBy]));

  function toggle(key: string, on: boolean) {
    setNote(null);
    if (on) {
      setRequested((r) => [...new Set([...r, key])]);
      setDeclined((d) => d.filter((k) => k !== key));
      return;
    }
    const dependents = removalImpact(resolved.selected, key);
    const gone = new Set([key, ...dependents]);
    setRequested(resolved.selected.filter((k) => !gone.has(k)));
    if (dependents.length) setNote(`Also unticked, because they need ${moduleDefinition(key)?.name}: ${dependents.map((k) => moduleDefinition(k)?.name ?? k).join(", ")}.`);
  }

  function save() {
    setError(null);
    setNameError(null);
    setIssues([]);
    startTransition(async () => {
      const r = await saveModuleTemplate(id, { name, description, baseType, modules: resolved.selected, declined: resolved.declined, expectedVersion: id ? initial.version : undefined });
      if (r.error || r.fieldErrors) {
        setError(r.error ?? null);
        setNameError(r.fieldErrors?.name ?? null);
        setIssues(r.issues ?? []);
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Saved." });
      router.push("/admin/module-templates");
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="tpl-name" required error={nameError ?? undefined}>
          <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Based on" htmlFor="tpl-base" hint="Recorded on projects that use it: “Custom Mix (… base)” when it differs from the type's own modules.">
          <Select id="tpl-base" value={baseType} onChange={(e) => setBaseType(e.target.value === "ECOMMERCE" ? "ECOMMERCE" : "DEFAULT")}>
            <option value="DEFAULT">{PROJECT_TYPE_LABELS.DEFAULT}</option>
            <option value="ECOMMERCE">{PROJECT_TYPE_LABELS.ECOMMERCE}</option>
          </Select>
        </Field>
      </div>
      <Field label="Description" htmlFor="tpl-description" hint="Optional. Shown when choosing a template.">
        <Textarea id="tpl-description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[color:var(--color-muted-foreground)]">Start from:</span>
        {(["DEFAULT", "ECOMMERCE"] as const).map((t) => (
          <Button key={t} size="sm" variant="ghost" onClick={() => setRequested(templateModules(t))}>
            {PROJECT_TYPE_LABELS[t]} modules
          </Button>
        ))}
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{resolved.selected.length} selected</span>
      </div>

      {MODULE_CATEGORIES.map((category) => {
        const modules = PROJECT_MODULES.filter((m) => m.category === category);
        if (modules.length === 0) return null;
        return (
          <fieldset key={category}>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-subtle-foreground)]">{category}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {modules.map((m) => (
                <label key={m.key} className={`flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm ${m.status !== "AVAILABLE" ? "opacity-60" : ""}`}>
                  <Checkbox checked={selected.has(m.key)} disabled={m.status !== "AVAILABLE"} onChange={(e) => toggle(m.key, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="font-medium">{m.name}</span>{" "}
                    {m.status !== "AVAILABLE" ? <Badge color="gray">Coming soon</Badge> : null}
                    {autoAdded.has(m.key) ? <Badge color="blue">Needed by {moduleDefinition(autoAdded.get(m.key)!)?.name}</Badge> : null}
                    <span className="mt-0.5 block text-xs text-[color:var(--color-muted-foreground)]">{m.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}

      {resolved.recommended.length > 0 ? (
        <Alert tone="info" title="Recommended">
          <ul className="space-y-1">
            {resolved.recommended.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2">
                <span>
                  {moduleDefinition(r.key)?.name} — {r.why}
                </span>
                <Button size="sm" variant="secondary" onClick={() => toggle(r.key, true)}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeclined((d) => [...new Set([...d, r.key])])}>
                  Not in this template
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {note ? <Alert tone="info">{note}</Alert> : null}
      {error || issues.length ? (
        <Alert tone="danger">
          {error ? <p>{error}</p> : null}
          {issues.length ? (
            <ul className="list-disc pl-4">
              {issues.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button onClick={save} loading={pending} disabled={!resolved.ok || resolved.selected.length === 0 || name.trim().length < 2}>
          {id ? "Save as a new version" : "Create template"}
        </Button>
      </div>
    </div>
  );
}
