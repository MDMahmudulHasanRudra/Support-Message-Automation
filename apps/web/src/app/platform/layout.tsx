import type { Metadata } from "next";
import { DEFAULT_PRODUCT_NAME } from "@support-automation/shared";

/**
 * The RELQIVO platform (SAAS_PLATFORM_PLAN.md §12, Layer 1): the software owner's SaaS control centre,
 * served on the admin address. Separate from every customer's software — its own sign-in, its own
 * session, its own pages. It always carries the product's own name, never a customer's branding.
 */
export const metadata: Metadata = {
  title: { default: `${DEFAULT_PRODUCT_NAME} Platform`, template: `%s · ${DEFAULT_PRODUCT_NAME} Platform` },
};

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return children;
}
