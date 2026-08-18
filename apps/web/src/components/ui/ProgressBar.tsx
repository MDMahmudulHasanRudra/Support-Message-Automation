export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const percent = max === 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const inProgress = percent < 100;
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-neutral-bg)]">
      <div
        className="relative h-full overflow-hidden rounded-full bg-[image:var(--gradient-primary)] transition-[width] duration-300 ease-out"
        style={{ width: `${percent}%` }}
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {inProgress ? (
          <span
            aria-hidden
            className="absolute inset-0 animate-[shimmer-sweep_1.6s_ease-in-out_infinite]"
            style={{
              backgroundImage: "linear-gradient(100deg, transparent 35%, rgba(255,255,255,0.35) 50%, transparent 65%)",
              backgroundSize: "250% 100%",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
