import { SOCIAL_PLATFORMS, isSocialPlatform, type SocialPlatform } from "@support-automation/shared";
import { facebookPageAdapter, instagramAdapter } from "./meta";
import type { SocialAdapter } from "./types";

/**
 * The platform adapters that exist. A platform without one here is never offered, whatever the
 * catalogue says, and the catalogue's `implemented` must agree — `socialAdapters.test.ts` checks both
 * directions so a new adapter cannot be forgotten in one place.
 */
const ADAPTERS: Partial<Record<SocialPlatform, SocialAdapter>> = {
  FACEBOOK_PAGE: facebookPageAdapter,
  INSTAGRAM: instagramAdapter,
};

export function adapterFor(platform: string): SocialAdapter | null {
  if (!isSocialPlatform(platform) || !SOCIAL_PLATFORMS[platform].implemented) return null;
  return ADAPTERS[platform] ?? null;
}

export function implementedAdapterPlatforms(): SocialPlatform[] {
  return Object.keys(ADAPTERS) as SocialPlatform[];
}
