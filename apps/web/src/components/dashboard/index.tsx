import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronRight, Circle, Clock, ListChecks, type LucideIcon } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Card } from "@/components/ui";

/**
 * The cards both overviews are made of (Project Overview and Main Admin Overview), so the two read as one
 * product. Presentation only: each caller passes what it already computed and what this viewer may open.
 */

function CardTitle({ icon: Icon, title, count, action }: { icon?: LucideIcon; title: string; count?: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pb-2.5 pt-4">
      <h2 className="flex min-w-0 items-center gap-2 text-[14.5px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
        {Icon ? <Icon className="size-[18px] shrink-0 text-[color:var(--color-accent)]" aria-hidden /> : null}
        <span className="truncate">{title}</span>
      </h2>
      {count !== undefined ? <span className="tabular shrink-0 rounded-full bg-[var(--color-danger)] px-2 py-px text-[11.5px] font-semibold text-white">{count}</span> : null}
      {action ? (
        <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
          {action.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

// ── Action required ─────────────────────────────────────────────────────────────────────────────

export interface ActionItem {
  key: string;
  kind: "down" | "warning" | "waiting" | "setup";
  title: string;
  detail?: string;
  href?: string;
  action?: string;
}

const KIND: Record<ActionItem["kind"], { icon: LucideIcon; tint: string }> = {
  down: { icon: AlertTriangle, tint: "text-[color:var(--color-danger-fg)]" },
  warning: { icon: AlertTriangle, tint: "text-[color:var(--color-warning-fg)]" },
  waiting: { icon: Clock, tint: "text-[color:var(--color-secondary-fg)]" },
  setup: { icon: ListChecks, tint: "text-[color:var(--color-accent-fg)]" },
};

/** The short list a person acts on, most severe first. Warm while it holds something, calm and green when it does not. */
export function ActionList({ items, hiddenCount = 0, title = "Action required", emptyText = "Problems and anything waiting on you appear here as soon as they happen." }: { items: ActionItem[]; hiddenCount?: number; title?: string; emptyText?: string }) {
  const total = items.length + hiddenCount;
  return (
    <Card className={`flex flex-col !p-0 ${total > 0 ? "border-[var(--color-secondary-border)] bg-[var(--color-secondary-bg)]" : ""}`}>
      <CardTitle icon={total > 0 ? AlertTriangle : CheckCircle2} title={title} count={total > 0 ? total : undefined} />
      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 pb-7 pt-3 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]">
            <CheckCircle2 className="size-5" aria-hidden />
          </span>
          <p className="text-[13.5px] font-medium text-[color:var(--color-foreground)]">Nothing needs you right now</p>
          <p className="max-w-[18rem] text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{emptyText}</p>
        </div>
      ) : (
        <ul className="flex-1 px-2 pb-2">
          {items.map((item) => {
            const { icon: Icon, tint } = KIND[item.kind];
            const row = (
              <>
                <Icon className={`mt-0.5 size-4 shrink-0 ${tint}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-[color:var(--color-foreground)] [overflow-wrap:anywhere]" dir="auto">
                    {item.title}
                  </span>
                  {item.detail ? (
                    <span className="mt-0.5 block truncate text-[12px] text-[color:var(--color-muted-foreground)]" dir="auto">
                      {item.detail}
                    </span>
                  ) : null}
                </span>
                {item.href ? (
                  <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)]">
                    {item.action}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </span>
                ) : null}
              </>
            );
            const cls = "flex items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2";
            return (
              <li key={item.key}>
                {item.href ? (
                  <Link href={item.href} className={`${cls} transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] dark:hover:bg-white/[0.05]`}>
                    {row}
                  </Link>
                ) : (
                  <div className={cls}>{row}</div>
                )}
              </li>
            );
          })}
          {hiddenCount > 0 ? <li className="px-3 pb-1 pt-1 text-[12px] text-[color:var(--color-muted-foreground)]">and {hiddenCount} more</li> : null}
        </ul>
      )}
    </Card>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────────────────────────

export type HealthState = "OPERATIONAL" | "ATTENTION" | "DOWN" | "OFF";

export interface HealthRow {
  key: string;
  title: string;
  icon?: LucideIcon;
  status: HealthState;
  statusLabel?: string;
  summary?: string;
  href?: string;
}

const HEALTH: Record<HealthState, { label: string; mark: string; text: string; icon: LucideIcon }> = {
  OPERATIONAL: { label: "Healthy", mark: "text-[color:var(--color-success)]", text: "text-[color:var(--color-success-fg)]", icon: CheckCircle2 },
  ATTENTION: { label: "Check", mark: "text-[color:var(--color-warning)]", text: "text-[color:var(--color-warning-fg)]", icon: AlertTriangle },
  DOWN: { label: "Action needed", mark: "text-[color:var(--color-danger)]", text: "text-[color:var(--color-danger-fg)]", icon: AlertTriangle },
  OFF: { label: "Off", mark: "text-[color:var(--color-border-strong)]", text: "text-[color:var(--color-muted-foreground)]", icon: Circle },
};

/** A headline verdict and one row per thing being watched; each row opens its page. */
export function HealthList({ title, icon, verdict, rows }: { title: string; icon?: LucideIcon; verdict?: { label: string; state: HealthState }; rows: HealthRow[] }) {
  return (
    <Card className="flex flex-col !p-0">
      <div className="flex min-w-0 items-center justify-between gap-1 pr-4">
        <div className="min-w-0"><CardTitle icon={icon} title={title} /></div>
        {verdict ? (
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${verdict.state === "OPERATIONAL" ? "bg-[var(--color-success-bg)]" : verdict.state === "DOWN" ? "bg-[var(--color-danger-bg)]" : "bg-[var(--color-warning-bg)]"} ${HEALTH[verdict.state].text}`}>
            {verdict.label}
          </span>
        ) : null}
      </div>
      <ul className="flex-1 px-2 pb-2">
        {rows.map((r) => {
          const s = HEALTH[r.status];
          const body = (
            <>
              <s.icon className={`size-4 shrink-0 ${s.mark}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-[color:var(--color-foreground)]">{r.title}</span>
                {r.summary ? <span className="block truncate text-[11.5px] text-[color:var(--color-muted-foreground)]" title={r.summary}>{r.summary}</span> : null}
              </span>
              <span className={`shrink-0 text-[12px] font-medium ${s.text}`}>{r.statusLabel ?? s.label}</span>
            </>
          );
          const cls = "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-1.5";
          return (
            <li key={r.key}>
              {r.href ? (
                <Link href={r.href} className={`${cls} transition-colors hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]`}>
                  {body}
                </Link>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── Quick actions ───────────────────────────────────────────────────────────────────────────────

export interface QuickAction {
  label: string;
  href: string;
  icon: LucideIcon;
}

export function QuickActions({ actions, title = "Quick actions", icon }: { actions: QuickAction[]; title?: string; icon?: LucideIcon }) {
  if (actions.length === 0) return null;
  return (
    <Card className="!p-0">
      <CardTitle icon={icon} title={title} />
      <ul className="space-y-1.5 px-3 pb-3">
        {actions.map((a) => (
          <li key={a.href}>
            <Link
              href={a.href}
              className="group/qa flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-[13px] font-medium text-[color:var(--color-foreground)] transition-colors hover:border-[var(--color-accent-border)] hover:bg-[var(--color-accent-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
            >
              <a.icon className="size-4 shrink-0 text-[color:var(--color-accent)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              <ChevronRight className="size-4 shrink-0 text-[color:var(--color-subtle-foreground)] transition-transform group-hover/qa:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Recent activity ─────────────────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  key: string;
  icon: LucideIcon;
  tint?: "neutral" | "success" | "warning" | "danger" | "accent";
  title: string;
  detail?: string;
  time: string;
  href?: string;
}

const TINT = {
  neutral: "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]",
  success: "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
  warning: "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  danger: "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]",
  accent: "bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]",
};

export function ActivityFeed({ title = "Recent activity", icon, entries, action, emptyText }: { title?: string; icon?: LucideIcon; entries: ActivityEntry[]; action?: { href: string; label: string }; emptyText: string }) {
  return (
    <Card className="flex flex-col !p-0">
      <CardTitle icon={icon} title={title} action={action} />
      {entries.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-6 pb-8 pt-4 text-center text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{emptyText}</p>
      ) : (
        <ul className="flex-1 px-2 pb-2">
          {entries.map((e) => {
            const body = (
              <>
                <span aria-hidden className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${TINT[e.tint ?? "neutral"]}`}>
                  <e.icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[color:var(--color-foreground)]" dir="auto">
                    {e.title}
                  </span>
                  {e.detail ? (
                    <span className="block truncate text-[12px] text-[color:var(--color-muted-foreground)]" dir="auto">
                      {e.detail}
                    </span>
                  ) : null}
                </span>
                <span className="tabular mt-0.5 shrink-0 text-[11.5px] text-[color:var(--color-subtle-foreground)]">{e.time}</span>
              </>
            );
            const cls = "flex items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-1.5";
            return (
              <li key={e.key}>
                {e.href ? (
                  <Link href={e.href} className={`${cls} transition-colors hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]`}>
                    {body}
                  </Link>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ── A module's figures in one card ──────────────────────────────────────────────────────────────

export function ModuleSummary({ title, icon, action, figures }: { title: string; icon: LucideIcon; action?: { href: string; label: string }; figures: Array<{ key: string; label: string; value: ReactNode; tone?: "warning" | "danger"; href?: string; hint?: string }> }) {
  return (
    <Card className="!p-0">
      <CardTitle icon={icon} title={title} action={action} />
      <dl className={`grid grid-cols-2 gap-px overflow-hidden rounded-b-[var(--radius-xl)] border-t border-[var(--color-border)] bg-[var(--color-border)] ${figures.length % 3 === 0 ? "sm:grid-cols-3" : figures.length === 5 || figures.length === 10 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
        {figures.map((f) => {
          const body = (
            <>
              <dt className="truncate text-[12px] text-[color:var(--color-muted-foreground)]">{f.label}</dt>
              <dd className={`tabular mt-1 text-[22px] font-semibold leading-none tracking-[-0.02em] ${f.tone === "danger" ? "text-[color:var(--color-danger-fg)]" : f.tone === "warning" ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-foreground)]"}`}>{f.value}</dd>
              {f.hint ? <dd className="mt-1 truncate text-[11.5px] text-[color:var(--color-subtle-foreground)]">{f.hint}</dd> : null}
            </>
          );
          return f.href ? (
            <Link key={f.key} href={f.href} className="block bg-[var(--color-surface)] px-5 py-3.5 transition-colors hover:bg-[var(--color-neutral-bg)]">
              {body}
            </Link>
          ) : (
            <div key={f.key} className="bg-[var(--color-surface)] px-5 py-3.5">
              {body}
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

// ── Getting started ─────────────────────────────────────────────────────────────────────────────

export interface SetupStep {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  href?: string;
  action?: string;
}

/** First-run guidance from real state: a step ticks itself when the thing exists, and the card leaves when all are done. */
export function GettingStarted({ title = "Get set up", steps }: { title?: string; steps: SetupStep[] }) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const percent = Math.round((done / steps.length) * 100);
  return (
    <Card className="!p-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pb-3 pt-4">
        <div>
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{title}</h2>
          <p className="mt-0.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">
            {done} of {steps.length} done. Each step ticks itself when it is finished.
          </p>
        </div>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <ol className="grid gap-px overflow-hidden rounded-b-[var(--radius-xl)] border-t border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.key} className="flex gap-3 bg-[var(--color-surface)] px-5 py-3.5">
            <span aria-hidden className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${s.done ? "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]"}`}>
              {s.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-[13px] font-medium ${s.done ? "text-[color:var(--color-muted-foreground)] line-through" : "text-[color:var(--color-foreground)]"}`}>{s.title}</span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">{s.detail}</span>
              {!s.done && s.href ? (
                <Link href={s.href} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
                  {s.action ?? "Start"}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** A chart with nothing to draw says what would fill it, and where that starts. */
export function ChartEmpty({ text, href, action }: { text: string; href?: string; action?: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-6 py-6 text-center">
      <p className="max-w-sm text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{text}</p>
      {href && action ? (
        <Link href={href} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
          {action}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
