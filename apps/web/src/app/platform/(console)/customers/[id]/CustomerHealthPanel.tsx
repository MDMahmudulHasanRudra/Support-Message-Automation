import { Alert, StatTile } from "@/components/ui";
import type { CustomerHealth } from "@/server/platform/monitoring";

export const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

/** One customer's own health: their numbers, sends, collection and usage. Counts only. */
export function CustomerHealthPanel({ health }: { health: CustomerHealth | null }) {
  if (!health) return <p className="text-sm text-[color:var(--color-muted-foreground)]">No data yet.</p>;
  const w = health.whatsapp;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="WhatsApp connected"
          value={`${w.connected} / ${w.total}`}
          tone={w.needsPhone + w.down > 0 ? "warning" : w.total > 0 ? "success" : "neutral"}
          hint={w.needsPhone > 0 ? `${w.needsPhone} need the phone` : w.down > 0 ? `${w.down} not connected` : undefined}
        />
        <StatTile label="Messages (24h)" value={health.messages24h.toLocaleString()} hint={health.lastMessageAt ? `last ${new Date(health.lastMessageAt).toLocaleString()}` : "none in 7 days"} />
        <StatTile label="Failed sends / alerts (24h)" value={`${health.failedSends24h} / ${health.failedNotifications24h}`} tone={health.failedSends24h + health.failedNotifications24h > 0 ? "warning" : "neutral"} />
        <StatTile label="Media stored" value={formatBytes(health.mediaBytes)} hint={`${health.people} people · ${health.workspaces} workspace(s)`} />
      </div>
      {health.attention.length > 0 ? (
        <Alert tone="warning" title="Needs attention">
          <ul className="list-disc space-y-0.5 pl-4">
            {health.attention.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">Nothing needs attention.</p>
      )}
    </div>
  );
}
