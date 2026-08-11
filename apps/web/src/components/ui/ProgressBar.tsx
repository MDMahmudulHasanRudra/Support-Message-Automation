export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const percent = max === 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-neutral-bg)]">
      <div
        className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300"
        style={{ width: `${percent}%` }}
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  );
}
