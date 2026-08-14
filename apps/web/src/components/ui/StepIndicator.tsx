import { Check } from "lucide-react";

export function StepIndicator({ steps, currentStep }: { steps: string[]; currentStep: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2">
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const isComplete = stepNumber < currentStep;
        const isCurrent = stepNumber === currentStep;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-200 ${
                isCurrent
                  ? "bg-[image:var(--gradient-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] ring-4 ring-[var(--color-primary-soft)]"
                  : isComplete
                    ? "bg-[var(--color-success)] text-white"
                    : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"
              }`}
            >
              {isComplete ? <Check className="size-3.5" aria-hidden /> : stepNumber}
            </span>
            <span
              className={`text-sm ${
                isCurrent
                  ? "font-medium text-[color:var(--color-foreground)]"
                  : "text-[color:var(--color-muted-foreground)]"
              }`}
            >
              {step}
            </span>
            {stepNumber < steps.length ? (
              <span className="mx-1 h-px w-6 bg-[var(--color-border)]" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
