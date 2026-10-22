import { Badge } from "@/components/ui";
import type { ChannelConnectionView } from "@/server/channels/connections";

/** One status per connection, in the order that matters: disconnected, off, then what the provider said. */
export function ConnectionStatusBadge({ connection }: { connection: Pick<ChannelConnectionView, "status" | "enabled"> }) {
  if (connection.status === "DISCONNECTED") return <Badge color="gray">Disconnected</Badge>;
  if (!connection.enabled) return <Badge color="gray">Switched off</Badge>;
  if (connection.status === "CONNECTED") return <Badge color="green" dot>Connected</Badge>;
  if (connection.status === "NEEDS_RECONNECT") return <Badge color="red">Needs new credentials</Badge>;
  if (connection.status === "ERROR") return <Badge color="yellow">Needs attention</Badge>;
  return <Badge color="gray">Setup required</Badge>;
}
