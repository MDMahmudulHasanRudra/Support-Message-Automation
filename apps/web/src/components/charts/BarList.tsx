import { formatCount } from "./chartUtils";

export interface BarListItem {
  id: string;
  label: string;
  value: number;
}

/**
 * Ranked magnitude over nominal categories — every bar takes the same hue.
 * Colouring each bar darker-where-bigger would re-encode what the bar length
 * already says and spend the identity channel on nothing.
 */
export function BarList({
  items,
  unitLabel = "messages",
  emptyMessage = "No activity in this window.",
}: {
  items: BarListItem[];
  unitLabel?: string;
  emptyMessage?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
        {emptyMessage}
      </p>
    );
  }

  const max = Math.max(...items.map((item) => item.value));

  return (
    <ol className="space-y-2.5">
      {items.map((item) => (
        <li key={item.id} title={`${item.label} — ${formatCount(item.value)} ${unitLabel}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] text-[color:var(--color-foreground)]">
              {item.label}
            </span>
            <span className="tabular shrink-0 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">
              {formatCount(item.value)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--chart-track)]">
            <div
              className="h-full rounded-full bg-[var(--chart-1)]"
              style={{ width: `${max === 0 ? 0 : Math.max(2, (item.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
