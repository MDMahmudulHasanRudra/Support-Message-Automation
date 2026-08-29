"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastTone = "success" | "danger" | "info";
type ToastPhase = "entering" | "visible" | "leaving";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  phase: ToastPhase;
}

interface ToastContextValue {
  showToast: (toast: Omit<ToastItem, "id" | "phase">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  danger: XCircle,
  info: Info,
};

const TONE_STYLES: Record<ToastTone, string> = {
  success:
    "border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
  danger:
    "border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]",
  info: "border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
};

// Mutually exclusive per phase — never combine a static pointer-events/opacity class with a
// conditional one on the same element, Tailwind resolves same-property conflicts by internal
// stylesheet order, not by className order.
const PHASE_STYLES: Record<ToastPhase, string> = {
  entering: "pointer-events-none translate-y-2 opacity-0",
  visible: "pointer-events-auto translate-y-0 opacity-100",
  leaving: "pointer-events-none translate-y-2 opacity-0",
};

const AUTO_DISMISS_MS = 5000;
const EXIT_MS = 200; // matches --duration-base

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const leaving = useRef(new Set<number>());

  const beginLeaving = useCallback((id: number) => {
    if (leaving.current.has(id)) return; // auto-timer and a manual click raced — no-op
    leaving.current.add(id);

    const pending = timers.current.get(id);
    if (pending !== undefined) window.clearTimeout(pending);

    setToasts((current) => current.map((t) => (t.id === id ? { ...t, phase: "leaving" } : t)));

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const removeTimer = window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
      leaving.current.delete(id);
      timers.current.delete(id);
    }, reduced ? 0 : EXIT_MS);
    timers.current.set(id, removeTimer);
  }, []);

  const showToast = useCallback(
    (toast: Omit<ToastItem, "id" | "phase">) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id, phase: "entering" }]);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setToasts((current) =>
            current.map((t) => (t.id === id && t.phase === "entering" ? { ...t, phase: "visible" } : t)),
          );
        });
      });

      const dismissTimer = window.setTimeout(() => beginLeaving(id), AUTO_DISMISS_MS);
      timers.current.set(id, dismissTimer);
    },
    [beginLeaving],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[var(--z-toast)] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = TONE_ICON[toast.tone];
          return (
            <div
              key={toast.id}
              role="status"
              aria-live="polite"
              className={`flex items-start gap-2.5 rounded-[var(--radius-lg)] border px-4 py-3.5 text-[13px] shadow-[var(--shadow-lg)] backdrop-blur-sm transition duration-[var(--duration-base)] ease-[var(--ease-out)] ${TONE_STYLES[toast.tone]} ${PHASE_STYLES[toast.phase]}`}
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="flex-1">
                <p className="font-medium">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-[13px] opacity-90">{toast.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => beginLeaving(toast.id)}
                aria-label="Dismiss notification"
                className="cursor-pointer text-current opacity-70 hover:opacity-100"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
