import { BUSINESS_APP_STATUS_LABELS, type BusinessAppStatus } from "@support-automation/shared";
import { Badge, type BadgeColor } from "@/components/ui/Badge";

const COLORS: Record<BusinessAppStatus, BadgeColor> = {
  ACTIVE: "green",
  PENDING: "yellow",
  CONNECTING: "blue",
  DISABLED: "gray",
  ERROR: "red",
};

export function BusinessAppStatusBadge({ status }: { status: BusinessAppStatus }) {
  return (
    <Badge color={COLORS[status]} dot>
      {BUSINESS_APP_STATUS_LABELS[status]}
    </Badge>
  );
}
