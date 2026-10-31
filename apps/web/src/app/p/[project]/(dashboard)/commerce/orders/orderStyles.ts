import type { OrderPaymentStatus, OrderStatus } from "@support-automation/shared";
import type { BadgeColor } from "@/components/ui";

export const ORDER_STATUS_COLOR: Record<OrderStatus, BadgeColor> = {
  DRAFT: "gray",
  CONFIRMED: "blue",
  PROCESSING: "cyan",
  SHIPPED: "yellow",
  DELIVERED: "green",
  CANCELLED: "red",
  RETURNED: "red",
};

export const PAYMENT_COLOR: Record<OrderPaymentStatus, BadgeColor> = { UNPAID: "gray", PARTIAL: "yellow", PAID: "green", REFUNDED: "red" };

export const orderWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
