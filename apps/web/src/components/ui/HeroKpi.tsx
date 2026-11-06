import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Sparkline } from "./Sparkline";

export type HeroKpiTone = "tide" | "sea" | "navy" | "amber";

const TONES: Record<HeroKpiTone, string> = {
  tide: "bg-[linear-gradient(120deg,#08414b_0%,#0d6a74_100%)]",
  sea: "bg-[linear-gradient(120deg,#0a5c5c_0%,#10907f_100%)]",
  navy: "bg-[linear-gradient(120deg,#0c3350_0%,#14618a_100%)]",
  amber: "bg-[linear-gradient(120deg,#8f5304_0%,#c47f14_100%)]",
};

export interface HeroKpiProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tone?: HeroKpiTone;
  /** A real change from a real comparison, never a decoration. */
  delta?: { text: string; direction: "up" | "down" | "flat" };
  /** One line under the figure: what it means. */
  sub?: ReactNode;
  spark?: number[];
  sparkLabel?: string;
  /** The rows behind this number, already filtered. Omit when no page lists them. */
  href?: string;
}

/**
 * The large figures at the top of an overview, shared by the Project Overview and the Main Admin Overview.
 * Only ever real data: a figure with no history has no line, and one with no comparison has no change.
 */
export function HeroKpi({ label, value, icon: Icon, tone = "tide", delta, sub, spark, sparkLabel, href }: HeroKpiProps) {
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-white/15 ring-1 ring-inset ring-white/15">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-white/85">{label}</p>
          <p className="tabular mt-0.5 text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[30px]">{value}</p>
        </div>
      </div>
      {spark && spark.length > 1 && spark.some((v) => v > 0) ? (
        <div className="absolute right-4 top-[2.4rem] w-[30%] max-w-28 opacity-95">
          <Sparkline data={spark} height={30} strokeColor="#ffffff" fillColor="#ffffff" ariaLabel={sparkLabel ?? label} />
        </div>
      ) : null}
      {delta || sub ? (
        <p className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[12px] text-white/80">
          {delta ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-white/15 px-1.5 py-px font-medium text-white">
              <DeltaIcon className="size-3" aria-hidden />
              {delta.text}
            </span>
          ) : null}
          {sub ? (
            <span className="truncate" dir="auto">
              {sub}
            </span>
          ) : null}
        </p>
      ) : null}
    </>
  );
  const shell = `relative block overflow-hidden rounded-[var(--radius-lg)] p-4 text-white shadow-[var(--shadow-sm)] ${TONES[tone]}`;
  return href ? (
    <Link href={href} className={`${shell} transition-[box-shadow,transform] duration-[var(--duration-fast)] hover:shadow-[var(--shadow-md)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
