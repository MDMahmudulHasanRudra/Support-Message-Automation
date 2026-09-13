import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Card } from "./Card";
import { Badge, type BadgeColor } from "./Badge";

export type ModuleHealthStatus = "OPERATIONAL" | "ATTENTION" | "DOWN" | "OFF";

const STATUS_LABEL: Record<ModuleHealthStatus, string> = {
  OPERATIONAL: "Operational",
  ATTENTION: "Attention",
  DOWN: "Down",
  // Deliberately not "Disabled" or "Off" phrased as a problem — most modules here are optional
  // and opt-in by design (Conversation Learning, AI Learning, Support Activity, Teams), so their
  // resting state is exactly this and must not read like something broken.
  OFF: "Not enabled",
};

const STATUS_COLOR: Record<ModuleHealthStatus, BadgeColor> = {
  OPERATIONAL: "green",
  ATTENTION: "yellow",
  DOWN: "red",
  OFF: "gray",
};

export function DashboardModuleCard({
  title,
  icon: Icon,
  href,
  linkLabel = "View module",
  secondaryLink,
  /** Omit entirely for a module with no real health signal to report — see the page for how each is derived. */
  status,
  children,
}: {
  title: string;
  icon: LucideIcon;
  href: string;
  linkLabel?: string;
  secondaryLink?: { href: string; label: string };
  status?: ModuleHealthStatus;
  children: ReactNode;
}) {
  return (
    <Card className="group/card flex h-full flex-col p-5 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]">
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-base)] group-hover/card:border-[var(--color-border-strong)] group-hover/card:text-[color:var(--color-foreground)]">
            <Icon className="size-4" aria-hidden />
          </span>
          <p className="truncate text-sm font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
            {title}
          </p>
        </div>
        {status ? (
          <Badge color={STATUS_COLOR[status]} dot>
            {STATUS_LABEL[status]}
          </Badge>
        ) : null}
      </div>

      <div className="mt-4 flex-1 space-y-2.5">{children}</div>

      <div className="mt-5 flex items-center justify-between border-t border-[var(--color-border)] pt-3">
        <Link
          href={href}
          className="group/link inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--color-foreground)] transition-opacity hover:opacity-70"
        >
          {linkLabel}
          <ArrowRight
            className="size-3.5 transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)] group-hover/link:translate-x-1"
            aria-hidden
          />
        </Link>
        {secondaryLink ? (
          <Link
            href={secondaryLink.href}
            className="text-xs text-[color:var(--color-muted-foreground)] underline-offset-4 transition-colors hover:text-[color:var(--color-foreground)] hover:underline"
          >
            {secondaryLink.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

export function ModuleCardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-[color:var(--color-muted-foreground)]">{label}</span>
      <span className="tabular text-right font-medium text-[color:var(--color-foreground)]">
        {children}
      </span>
    </div>
  );
}
