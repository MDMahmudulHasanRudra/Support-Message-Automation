import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";

type AlertTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_STYLES: Record<AlertTone, string> = {
  success:
    "bg-[var(--color-success-bg)] border-[var(--color-success-border)] text-[color:var(--color-success-fg)]",
  warning:
    "bg-[var(--color-warning-bg)] border-[var(--color-warning-border)] text-[color:var(--color-warning-fg)]",
  danger:
    "bg-[var(--color-danger-bg)] border-[var(--color-danger-border)] text-[color:var(--color-danger-fg)]",
  info: "bg-[var(--color-info-bg)] border-[var(--color-info-border)] text-[color:var(--color-info-fg)]",
  neutral:
    "bg-[var(--color-neutral-bg)] border-[var(--color-neutral-border)] text-[color:var(--color-neutral-fg)]",
};

const TONE_ICONS: Record<AlertTone, typeof Info> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Info,
};

export function Alert({
  tone = "info",
  title,
  children,
  actions,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = TONE_ICONS[tone];
  return (
    <div
      className={`flex gap-3 rounded-[var(--radius-md)] border px-4 py-3.5 text-sm shadow-[var(--shadow-xs)] ${TONE_STYLES[tone]}`}
      role={tone === "danger" ? "alert" : undefined}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={title ? "mt-1 text-[13px] opacity-90" : ""}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
