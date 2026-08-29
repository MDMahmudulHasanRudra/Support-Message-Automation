/**
 * The product mark: a message routed from one endpoint to another. Drawn here
 * rather than pulled from an icon set so the app is not wearing the same generic
 * glyph as everything else built on lucide.
 */
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] ${className}`}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-[62%]">
        <path
          d="M5.5 16.5V8.2A2.7 2.7 0 0 1 8.2 5.5h4.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <path
          d="M18.5 7.5v8.3a2.7 2.7 0 0 1-2.7 2.7h-4.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <circle cx="17" cy="5.6" r="2.3" fill="currentColor" />
        <circle cx="7" cy="18.4" r="2.3" fill="currentColor" />
      </svg>
    </span>
  );
}
