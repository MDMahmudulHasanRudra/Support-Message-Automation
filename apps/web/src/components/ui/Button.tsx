"use client";

import { Loader2 } from "lucide-react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-[image:var(--gradient-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] hover:brightness-[1.06] active:brightness-95",
  secondary:
    "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-neutral-bg)]",
  danger:
    "bg-[var(--color-danger)] text-white shadow-[var(--shadow-sm)] hover:bg-[var(--color-danger-hover)] hover:shadow-[var(--shadow-md)]",
  ghost:
    "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]",
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9.5 px-4 text-sm gap-2",
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center rounded-md font-medium transition duration-[var(--duration-fast)] ease-[var(--ease-out)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_STYLES[variant]} ${SIZE_STYLES[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Same visual language as `Button`, for links that must stay real `<a href>` navigation — e.g. a file download. */
export function ButtonLink({
  children,
  variant = "secondary",
  size = "sm",
  className = "",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a
      className={`inline-flex cursor-pointer items-center justify-center rounded-md font-medium transition duration-[var(--duration-fast)] ease-[var(--ease-out)] active:scale-[0.98] ${VARIANT_STYLES[variant]} ${SIZE_STYLES[size]} ${className}`}
      {...props}
    >
      {children}
    </a>
  );
}
