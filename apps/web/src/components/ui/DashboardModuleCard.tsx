import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Card } from "./Card";

export function DashboardModuleCard({
  title,
  icon: Icon,
  href,
  linkLabel = "View module",
  secondaryLink,
  children,
}: {
  title: string;
  icon: LucideIcon;
  href: string;
  linkLabel?: string;
  secondaryLink?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary-soft)] text-[color:var(--color-primary)]">
          <Icon className="size-4.5" aria-hidden />
        </span>
        <p className="text-sm font-semibold text-[color:var(--color-foreground)]">{title}</p>
      </div>

      <div className="mt-4 flex-1 space-y-2">{children}</div>

      <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-3">
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-primary)] hover:underline"
        >
          {linkLabel}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        {secondaryLink ? (
          <Link
            href={secondaryLink.href}
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
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
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-[color:var(--color-muted-foreground)]">{label}</span>
      <span className="text-[color:var(--color-foreground)]">{children}</span>
    </div>
  );
}
