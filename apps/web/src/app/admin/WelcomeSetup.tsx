import { ArrowRight, Check, Lock } from "lucide-react";
import { ButtonLink, Card } from "@/components/ui";
import type { SetupStep } from "@/components/dashboard";

export interface WelcomeStep extends SetupStep {
  required: boolean;
  /** Shown instead of the action when the step cannot start yet. */
  lockedReason?: string;
}

/**
 * The Main Admin's first screen while the customer has no project (the owner's Main Admin redesign §2). One
 * ordered list, ticked from what exists, so leaving and coming back resumes where they were. Nothing is
 * blocked: only the project is required, and every other step can be skipped and done later.
 */
export function WelcomeSetup({ productName, username, steps }: { productName: string; username: string; steps: WelcomeStep[] }) {
  const done = steps.filter((s) => s.done).length;
  const percent = Math.round((done / steps.length) * 100);
  const next = steps.find((s) => !s.done && !s.lockedReason && s.href);
  return (
    <div className="mx-auto max-w-3xl py-2 sm:py-6">
      <p className="text-[13px] font-medium text-[color:var(--color-accent-fg)]">Hello, {username}</p>
      <h1 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-[color:var(--color-foreground)] sm:text-[32px]">Welcome to {productName}</h1>
      <p className="mt-2 max-w-xl text-[14.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        Set up your business in a few simple steps. Only the first one is needed to start; do the rest whenever you like. Each step ticks itself when it is done.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-[color:var(--color-muted-foreground)]">
          {done} of {steps.length} done
        </span>
      </div>

      <Card className="mt-5 !p-0">
        <ol className="divide-y divide-[var(--color-border)]">
          {steps.map((step, index) => {
            const isNext = step === next;
            return (
              <li key={step.key} className={`flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 sm:flex-nowrap ${isNext ? "bg-[var(--color-accent-bg)]/40" : ""}`}>
                <span
                  aria-hidden
                  className={`flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                    step.done
                      ? "bg-[var(--color-success)] text-white"
                      : isNext
                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast,white)]"
                        : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"
                  }`}
                >
                  {step.done ? <Check className="size-4" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold text-[color:var(--color-foreground)]">
                    {step.title}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${step.required ? "bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
                      {step.required ? "Required" : "Optional"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{step.detail}</p>
                </div>
                <div className="shrink-0 max-sm:w-full max-sm:pl-13">
                  {step.done ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--color-success)]">
                      <Check className="size-4" aria-hidden />
                      Completed
                    </span>
                  ) : step.lockedReason ? (
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--color-subtle-foreground)]">
                      <Lock className="size-3.5" aria-hidden />
                      {step.lockedReason}
                    </span>
                  ) : step.href ? (
                    <ButtonLink href={step.href} variant={isNext ? "primary" : "secondary"} size="sm">
                      {step.action ?? "Start"}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </ButtonLink>
                  ) : (
                    <span className="text-[12.5px] text-[color:var(--color-subtle-foreground)]">Ask a Main Admin</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <p className="mt-4 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        A project is one business or team, with its own numbers, people and conversations. You can create more later, and nothing is shared between them.
      </p>
    </div>
  );
}
