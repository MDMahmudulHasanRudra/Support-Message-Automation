"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";

const DIALOG_SIZE = {
  md: "max-w-md",
  lg: "max-w-2xl",
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** "lg" for long-form content (e.g. help text) that needs more room than a confirmation dialog. */
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target === node) onClose();
    };

    node.addEventListener("cancel", handleCancel);
    node.addEventListener("click", handleBackdropClick);
    return () => {
      node.removeEventListener("cancel", handleCancel);
      node.removeEventListener("click", handleBackdropClick);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Explicit fixed + transform centering, not relying on the native <dialog>:modal
      // UA stylesheet's `margin: auto` — Tailwind's preflight resets margin to 0 on every
      // element, which silently defeats that default and left dialogs pinned to the
      // viewport's top-left corner instead of centered.
      className={`fixed left-1/2 top-1/2 m-0 flex max-h-[85vh] w-full ${DIALOG_SIZE[size]} -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[color:var(--color-foreground)] shadow-[var(--shadow-xl)] backdrop:bg-black/55 backdrop:backdrop-blur-[2px]`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4.5">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div> : null}
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-6 py-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  loading = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
