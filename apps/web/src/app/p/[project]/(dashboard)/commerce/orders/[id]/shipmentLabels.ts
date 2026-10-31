import type { BadgeColor } from "@/components/ui";
import type { ShipmentStatus } from "@support-automation/shared";

export { COURIER_LABELS, SHIPMENT_STATUS_LABELS, SHOP_LABELS } from "@support-automation/shared";
export type { CourierProvider, ShipmentStatus, ShopProvider } from "@support-automation/shared";

export const SHIP_STATUS_COLOR_KEYS: Record<ShipmentStatus, BadgeColor> = {
  BOOKING: "blue",
  BOOKED: "blue",
  PICKED_UP: "cyan",
  IN_TRANSIT: "cyan",
  ON_HOLD: "yellow",
  DELIVERED: "green",
  PARTIAL_DELIVERED: "green",
  RETURNED: "red",
  CANCELLED: "gray",
  FAILED: "red",
  UNKNOWN: "yellow",
};
