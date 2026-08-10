import type { ReactNode } from "react";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{title}</h1>
      {description ? (
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      ) : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      {children}
    </div>
  );
}

const BADGE_STYLES: Record<string, string> = {
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  gray: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
};

export function Badge({ color = "gray", children }: { color?: keyof typeof BADGE_STYLES; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[color]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const variants = {
    primary:
      "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200",
    secondary:
      "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <td className={`border-b border-zinc-100 px-4 py-2 text-zinc-800 dark:border-zinc-900 dark:text-zinc-200 ${className}`}>
      {children}
    </td>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}
