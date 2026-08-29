import { Check } from "lucide-react";

export function StepIndicator({ steps, currentStep }: { steps: string[]; currentStep: number }) {
  return (
    <ol className="mb-7 flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const isComplete = stepNumber < currentStep;
        const isCurrent = stepNumber === currentStep;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`tabular flex size-6.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-[var(--duration-base)] ease-[var(--ease-spring)] ${
                isCurrent
                  ? "bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] ring-4 ring-[var(--color-primary)]/10"
                  : isComplete
                    ? "bg-[var(--color-success)] text-white"
                    : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)]"
              }`}
            >
              {isComplete ? <Check className="size-3.5" aria-hidden /> : stepNumber}
            </span>
            <span
              className={`text-[13px] ${
                isCurrent
                  ? "font-medium text-[color:var(--color-foreground)]"
                  : "text-[color:var(--color-muted-foreground)]"
              }`}
            >
              {step}
            </span>
            {stepNumber < steps.length ? (
              <span
                className={`mx-1 h-px w-7 transition-colors duration-[var(--duration-base)] ${
                  isComplete ? "bg-[var(--color-success)]/40" : "bg-[var(--color-border)]"
                }`}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
