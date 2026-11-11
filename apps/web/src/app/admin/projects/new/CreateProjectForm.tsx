"use client";

import { useActionState, useState } from "react";
import { Check, ChevronDown, Layers, Plus, SlidersHorizontal, Sparkles } from "lucide-react";
import { PROJECT_NAME_MAX, PROJECT_SLUG_MAX, suggestProjectSlug, validateProjectName, validateProjectSlug } from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, Textarea } from "@/components/ui";
import { createProject, type ProjectFormState } from "@/server/actions/projects";
import { ClientCodeFields, type ClientCodeContext } from "./ClientCodeFields";
import { useBranding } from "@/components/BrandingProvider";

/**
 * Create a project in three short steps (the owner's Main Admin redesign §3): a name, a business type picked from
 * cards with what it will include, and Advanced settings folded away. A new project starts Active; the client
 * code format and the address can still be changed under Advanced and Change. The same validators run in the
 * action, which is the one that counts.
 */
export interface ModuleSetupOption {
  key: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  moduleCount: number;
  /** The names of the modules it switches on, in catalogue order. */
  moduleNames: string[];
}

const PLAN = "PLAN";
const CUSTOM = "CUSTOM";

export function CreateProjectForm({
  defaultName = "",
  templates = [],
  planName = null,
  codeContext,
  everything = [],
}: {
  defaultName?: string;
  templates?: ModuleSetupOption[];
  planName?: string | null;
  codeContext: ClientCodeContext;
  /** Every module's name, for the "Everything" preview. */
  everything?: string[];
}) {
  const [state, formAction, pending] = useActionState<ProjectFormState, FormData>(createProject, {});
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);
  const own = templates.filter((t) => !t.builtIn);
  const [setup, setSetup] = useState(PLAN);
  const chosen = templates.find((t) => t.key === setup);
  const exampleName = `${useBranding().productName} Project 2`;

  const shownSlug = slugEdited ? slug : suggestProjectSlug(name);
  const nameError = state.fieldErrors?.name ?? (name ? validateProjectName(name.trim()) : null);
  const slugError = state.fieldErrors?.slug ?? (shownSlug ? validateProjectSlug(shownSlug) : null);
  const showSlug = editingSlug || Boolean(slugError && name);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="status" value="ACTIVE" />
      <input type="hidden" name="moduleSetup" value={setup} />

      <Card>
        <StepTitle number={1} title="Name your project" />
        <div className="space-y-4">
          <Field label="Project name" htmlFor="project-name" required error={nameError ?? undefined}>
            <Input id="project-name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${exampleName}`} maxLength={PROJECT_NAME_MAX} required autoComplete="off" autoFocus />
          </Field>
          {showSlug ? (
            <Field label="Address" htmlFor="project-slug" required error={slugError ?? undefined} hint={`/p/${shownSlug || "your-address"}/ · lower-case letters, digits and hyphens. It cannot be changed later, so bookmarks keep working.`}>
              <Input
                id="project-slug"
                name="slug"
                value={shownSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
                maxLength={PROJECT_SLUG_MAX}
                required
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          ) : (
            <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
              <input type="hidden" name="slug" value={shownSlug} />
              Address: <span className="font-mono text-[color:var(--color-foreground)]">/p/{shownSlug || "…"}/</span>{" "}
              <button type="button" onClick={() => setEditingSlug(true)} className="font-medium text-[color:var(--color-accent-fg)] hover:underline">
                Change
              </button>
            </p>
          )}
          <Field label="Description" htmlFor="project-description" hint="Optional. Only Main Admins see it.">
            <Textarea id="project-description" name="description" rows={2} maxLength={500} />
          </Field>
        </div>
      </Card>

      <Card>
        <StepTitle number={2} title="Modules" hint="Every module comes switched on. Use what you need; anything unused simply waits." />
        <div role="radiogroup" aria-label="Modules" className="grid gap-3 sm:grid-cols-2">
          <TypeCard
            selected={setup === PLAN}
            onSelect={() => setSetup(PLAN)}
            icon={Layers}
            title="Everything (recommended)"
            description={`Every module${planName ? ` your plan (${planName}) includes` : ""}, ready to use.`}
            meta={`${everything.length} modules`}
          />
          {own.map((t) => (
            <TypeCard key={t.key} selected={setup === t.key} onSelect={() => setSetup(t.key)} title={t.name} description={t.description} meta={`Your template · ${t.moduleCount} modules`} />
          ))}
          <TypeCard selected={setup === CUSTOM} onSelect={() => setSetup(CUSTOM)} icon={SlidersHorizontal} title="Choose modules myself" description="Pick each module on the next screen." />
        </div>

        <div className="mt-4 rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] px-4 py-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--color-foreground)]">
            <Sparkles className="size-3.5 text-[color:var(--color-accent)]" aria-hidden />
            Your workspace will include
          </p>
          {setup === PLAN ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {everything.slice(0, 14).map((m) => (
                <span key={m} className="rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-[12px] text-[color:var(--color-foreground)] ring-1 ring-[var(--color-border)]">
                  {m}
                </span>
              ))}
              {everything.length > 14 ? <span className="px-1 py-1 text-[12px] text-[color:var(--color-muted-foreground)]">+{everything.length - 14} more</span> : null}
            </div>
          ) : chosen ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chosen.moduleNames.slice(0, 14).map((m) => (
                <span key={m} className="rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-[12px] text-[color:var(--color-foreground)] ring-1 ring-[var(--color-border)]">
                  {m}
                </span>
              ))}
              {chosen.moduleNames.length > 14 ? <span className="px-1 py-1 text-[12px] text-[color:var(--color-muted-foreground)]">+{chosen.moduleNames.length - 14} more</span> : null}
            </div>
          ) : (
            <p className="mt-1 text-[12.5px] text-[color:var(--color-muted-foreground)]">
              {setup === CUSTOM ? "The modules you choose next. Nothing is switched on until you save there." : null}
            </p>
          )}
          <p className="mt-2 text-[11.5px] text-[color:var(--color-subtle-foreground)]">Anything your plan does not include is left out and noted. You can switch modules off later in the Module Builder.</p>
        </div>
      </Card>

      <details className="group rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-[14px] font-semibold text-[color:var(--color-foreground)] [&::-webkit-details-marker]:hidden">
          <span>
            Advanced settings
            <span className="ml-2 text-[12.5px] font-normal text-[color:var(--color-muted-foreground)]">Client code format. The defaults suit most businesses.</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-[var(--color-border)] px-5 py-4">
          <ClientCodeFields context={codeContext} name={name} slug={shownSlug} errors={state.fieldErrors} />
        </div>
      </details>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <div className="flex items-center justify-end gap-3">
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">It starts active, with automation and AI off until you switch them on.</p>
        <Button type="submit" loading={pending} disabled={Boolean(validateProjectName(name.trim()) || validateProjectSlug(shownSlug))}>
          <Plus className="size-4" aria-hidden />
          Create project
        </Button>
      </div>
    </form>
  );
}

function StepTitle({ number, title, hint }: { number: number; title: string; hint?: string }) {
  return (
    <div className="mb-4 flex gap-3">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-[12.5px] font-semibold text-[color:var(--color-accent-fg)]">
        {number}
      </span>
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{title}</h2>
        {hint ? <p className="mt-0.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">{hint}</p> : null}
      </div>
    </div>
  );
}

function TypeCard({
  selected,
  onSelect,
  title,
  description,
  meta,
  icon: Icon,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string | null;
  meta?: string;
  icon?: typeof Layers;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`relative flex flex-col items-start rounded-[var(--radius-lg)] border px-4 py-3.5 text-left transition-[border-color,box-shadow,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${
        selected
          ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)]/50 shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border ${selected ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white" : "border-[var(--color-border-strong)]"}`}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
      <span className="flex items-center gap-1.5 pr-7 text-[14px] font-semibold text-[color:var(--color-foreground)]">
        {Icon ? <Icon className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden /> : null}
        {title}
      </span>
      {description ? <span className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{description}</span> : null}
      {meta ? <span className="mt-2 text-[11.5px] font-medium text-[color:var(--color-subtle-foreground)]">{meta}</span> : null}
    </button>
  );
}
