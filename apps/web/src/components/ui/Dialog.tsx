"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

const DIALOG_SIZE = {
  md: "max-w-md",
  lg: "max-w-2xl",
};

const EXIT_MS = 200; // matches --duration-base

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
  const [visible, setVisible] = useState(false);

  // Two-phase open/close so the fade+scale transition below has a real "before" value to
  // interpolate from — showModal()/close() are still the source of truth for native
  // focus-trap/top-layer behavior, `visible` only drives the CSS transition around them.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let raf1 = 0;
    let raf2 = 0;
    let timer: number | undefined;

    if (open) {
      if (!node.open) node.showModal();
      // `visible` is already false here — the only place it's ever set true is the rAF below,
      // and every path into this branch is preceded by either initial state or the `else`
      // branch, which always resets it first. Re-setting it would just be a same-value
      // setState call directly in the effect body, which the lint rule (rightly) flags.
      // Double rAF: Safari needs the extra frame for the "hidden" state to actually paint
      // before flipping, or the transition has nothing to interpolate from.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
    } else {
      // Deferred via a microtask (fires before the next paint, so no visible delay) rather than
      // called directly in the effect body — satisfies react-hooks/set-state-in-effect, which
      // flags synchronous setState-in-effect as a cascading-render smell.
      queueMicrotask(() => setVisible(false));
      if (node.open) {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        timer = window.setTimeout(() => node.close(), reduced ? 0 : EXIT_MS);
      }
    }

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
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
      className={`fixed left-1/2 top-1/2 m-0 flex max-h-[85vh] w-full ${DIALOG_SIZE[size]} -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[color:var(--color-foreground)] shadow-[var(--shadow-xl)] transition duration-[var(--duration-base)] ease-[var(--ease-out)] backdrop:backdrop-blur-[3px] backdrop:transition-colors backdrop:duration-[var(--duration-base)] backdrop:ease-[var(--ease-out)] ${
        visible ? "opacity-100 scale-100 backdrop:bg-black/50" : "opacity-0 scale-[0.97] backdrop:bg-black/0"
      }`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4.5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        >
          <X className="size-4.5" aria-hidden />
        </button>
      </div>
      {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div> : null}
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-6 py-4">
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
  /** For a "type X to confirm" gate on an especially dangerous action — the confirm button stays
   * disabled until the caller's own local state (e.g. a typed phrase matching) says otherwise. */
  confirmDisabled = false,
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
  confirmDisabled?: boolean;
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
            disabled={confirmDisabled}
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
