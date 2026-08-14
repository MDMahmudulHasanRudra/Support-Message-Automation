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

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  showToast: (toast: Omit<ToastItem, "id">) => void;
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

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = TONE_ICON[toast.tone];
          return (
            <div
              key={toast.id}
              role="status"
              aria-live="polite"
              className={`pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-md)] border px-4 py-3.5 text-sm shadow-[var(--shadow-lg)] backdrop-blur-sm transition-all duration-200 ${TONE_STYLES[toast.tone]}`}
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
                onClick={() => dismiss(toast.id)}
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
