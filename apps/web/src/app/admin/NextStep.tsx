import { ArrowRight, Lightbulb } from "lucide-react";
import { ButtonLink } from "@/components/ui";

/**
 * "What now?" at the foot of a Main Admin page: the one next thing in the setup order, worded as the reason
 * to do it. Shown only while that next thing is still missing, so it disappears by itself once done.
 */
export function NextStep({ title, detail, href, action }: { title: string; detail: string; href: string; action: string }) {
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-[var(--radius-xl)] border border-[color-mix(in_oklab,var(--color-accent)_30%,var(--color-border))] bg-[var(--color-accent-bg)]/40 px-5 py-4 sm:flex-row sm:items-center">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
        <Lightbulb className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[color:var(--color-accent-fg)]">Next step</p>
        <p className="text-[14px] font-semibold text-[color:var(--color-foreground)]">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{detail}</p>
      </div>
      <ButtonLink href={href} variant="primary" className="shrink-0">
        {action}
        <ArrowRight className="size-3.5" aria-hidden />
      </ButtonLink>
    </div>
  );
}
