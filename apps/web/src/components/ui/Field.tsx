import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const fieldBase =
  "w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] ease-[var(--ease-out)] placeholder:text-[color:var(--color-muted-foreground)] hover:border-[var(--color-muted-foreground)]/60 focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-primary)]/12 disabled:cursor-not-allowed disabled:bg-[var(--color-neutral-bg)] disabled:opacity-60 disabled:hover:border-[var(--color-border-strong)]";

/**
 * `ref` is declared explicitly on both of these.
 *
 * React 19 passes it to a function component as an ordinary prop, so it already reached the
 * element through the spread — but `InputHTMLAttributes` does not include it, so every caller
 * that needed one failed to compile against a component that would have worked. Declaring it is
 * the fix; wrapping these in `forwardRef` would be the React 18 answer to a problem React 19
 * no longer has.
 */
export function Input({
  className = "",
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={`h-9.5 ${fieldBase} ${className}`} {...props} />;
}

export function Textarea({
  className = "",
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea ref={ref} className={`min-h-24 py-2.5 leading-relaxed ${fieldBase} ${className}`} {...props} />
  );
}

export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`h-9.5 cursor-pointer ${fieldBase} ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({
  className = "",
  indeterminate,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  /**
   * The third state a "select all" box needs: some but not all of what it governs is selected.
   *
   * Without it a partly-filled page renders its header box as plain UNCHECKED, which reads as
   * "nothing here is selected" while a bulk action is armed and pointed at whatever is — and the
   * one click available to resolve the confusion selects everything. There is no HTML attribute
   * for it, so it is set on the node itself.
   *
   * The ref that does that is attached ONLY when this prop is passed. This file is not a client
   * module, and a Server Component cannot render a ref at all — an unconditional callback ref
   * made every server page using a Checkbox (the team member alert preferences) crash with
   * "Refs cannot be used in Server Components". Callers that manage the state are client
   * components and always pass a boolean, so the ref stays attached for them across renders.
   */
  indeterminate?: boolean;
}) {
  return (
    <input
      type="checkbox"
      ref={
        indeterminate === undefined
          ? undefined
          : (node) => {
              if (node) node.indeterminate = indeterminate;
            }
      }
      aria-checked={indeterminate ? "mixed" : undefined}
      className={`size-4 cursor-pointer rounded-[var(--radius-xs)] border-[var(--color-border-strong)] accent-[var(--color-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${className}`}
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
      className="mb-1.5 block text-[13px] font-medium text-[color:var(--color-foreground)]"
    >
      {children}
      {required ? <span className="ml-0.5 text-[color:var(--color-danger)]">*</span> : null}
    </label>
  );
}

export function FieldHint({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{children}</p>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs font-medium text-[color:var(--color-danger)]">{children}</p>;
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
