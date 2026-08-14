import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const fieldBase =
  "w-full rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] transition-[border-color,box-shadow] duration-150 placeholder:text-[color:var(--color-muted-foreground)] hover:border-[var(--color-muted-foreground)]/60 focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--color-border-strong)]";

export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`h-9 ${fieldBase} ${className}`} {...props} />;
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`min-h-24 py-2 ${fieldBase} ${className}`} {...props} />;
}

export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`h-9 ${fieldBase} ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={`size-4 rounded border-[var(--color-border-strong)] text-[var(--color-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${className}`}
      {...props}
    />
  );
}

export function Label({
  children,
  htmlFor,
  required,
}: {
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-sm font-medium text-[color:var(--color-foreground)]"
    >
      {children}
      {required ? <span className="ml-0.5 text-[color:var(--color-danger)]">*</span> : null}
    </label>
  );
}

export function FieldHint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">{children}</p>;
}

export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs text-[color:var(--color-danger)]">{children}</p>;
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className = "",
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {label ? (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      ) : null}
      {children}
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
