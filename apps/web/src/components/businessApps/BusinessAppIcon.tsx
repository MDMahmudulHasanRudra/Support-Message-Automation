import { GraduationCap, Plane, ShoppingBag, type LucideIcon } from "lucide-react";
import type { BusinessAppDefinition } from "@support-automation/shared";

/** The registry names an icon by string (packages/shared holds no components); this is the one mapping. */
export const BUSINESS_APP_ICONS: Record<BusinessAppDefinition["icon"], LucideIcon> = {
  ShoppingBag,
  GraduationCap,
  Plane,
};

export function BusinessAppIcon({ icon, className = "size-4" }: { icon: BusinessAppDefinition["icon"]; className?: string }) {
  const Icon = BUSINESS_APP_ICONS[icon] ?? ShoppingBag;
  return <Icon className={className} aria-hidden />;
}
