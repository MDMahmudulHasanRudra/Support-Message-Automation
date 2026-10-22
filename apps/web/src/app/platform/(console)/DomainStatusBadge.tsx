import { Badge } from "@/components/ui";
import type { DomainStatus } from "@support-automation/shared";

const LOOK: Record<DomainStatus, { color: "green" | "yellow" | "blue" | "gray"; label: string }> = {
  ACTIVE: { color: "green", label: "Live" },
  VERIFIED: { color: "blue", label: "Verified — HTTPS next" },
  PENDING: { color: "yellow", label: "Waiting for DNS" },
  DISABLED: { color: "gray", label: "Disabled" },
};

export function DomainStatusBadge({ status }: { status: DomainStatus }) {
  const look = LOOK[status];
  return (
    <Badge color={look.color} dot>
      {look.label}
    </Badge>
  );
}
