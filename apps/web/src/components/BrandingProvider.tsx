"use client";

import { createContext, useContext } from "react";
import { defaultPublicBranding, type PublicBranding } from "@/lib/branding";

/**
 * The installation's brand, for client components (BRANDING.md). Filled once by the root layout from
 * the database; server components call `getBranding()` directly instead. Without a provider (a test,
 * a stray render) it is the built-in brand, never undefined.
 */
const BrandingContext = createContext<PublicBranding>(defaultPublicBranding());

export function BrandingProvider({ value, children }: { value: PublicBranding; children: React.ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): PublicBranding {
  return useContext(BrandingContext);
}
