import type { ConversationPriorityValue, TicketClockTone, TicketStatusValue } from "@support-automation/shared";

type BadgeColor = "gray" | "blue" | "yellow" | "green" | "red";

export const TICKET_STATUS_COLOR: Record<TicketStatusValue, BadgeColor> = {
  OPEN: "blue",
  IN_PROGRESS: "blue",
  WAITING_CUSTOMER: "yellow",
  RESOLVED: "green",
  CLOSED: "gray",
};

export const TICKET_PRIORITY_COLOR: Record<ConversationPriorityValue, BadgeColor> = {
  NONE: "gray",
  LOW: "gray",
  NORMAL: "gray",
  HIGH: "yellow",
  URGENT: "red",
};

export const TICKET_CLOCK_CLASS: Record<TicketClockTone, string> = {
  danger: "font-medium text-[color:var(--color-danger-fg)]",
  warning: "font-medium text-[color:var(--color-warning-fg)]",
  neutral: "text-[color:var(--color-muted-foreground)]",
  paused: "text-[color:var(--color-muted-foreground)]",
  done: "text-[color:var(--color-muted-foreground)]",
};
