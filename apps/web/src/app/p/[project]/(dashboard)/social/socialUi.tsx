import {
  isSocialPlatform,
  isSocialPostStatus,
  isSocialTargetStatus,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_STATUS_LABELS,
  SOCIAL_POST_STATUS_TONES,
  SOCIAL_TARGET_STATUS_LABELS,
  SOCIAL_TARGET_STATUS_TONES,
  type SocialStatusTone,
} from "@support-automation/shared";
import { Badge, type BadgeColor } from "@/components/ui";

/** Small, server-safe presentation helpers shared by the Social Studio pages. */

const TONE_COLOR: Record<SocialStatusTone, BadgeColor> = { neutral: "gray", info: "blue", success: "green", warning: "yellow", danger: "red" };

export function PostStatusBadge({ status }: { status: string }) {
  if (!isSocialPostStatus(status)) return <Badge>{status}</Badge>;
  return (
    <Badge color={TONE_COLOR[SOCIAL_POST_STATUS_TONES[status]]} dot>
      {SOCIAL_POST_STATUS_LABELS[status]}
    </Badge>
  );
}

export function TargetStatusBadge({ status }: { status: string }) {
  if (!isSocialTargetStatus(status)) return <Badge>{status}</Badge>;
  return <Badge color={TONE_COLOR[SOCIAL_TARGET_STATUS_TONES[status]]}>{SOCIAL_TARGET_STATUS_LABELS[status]}</Badge>;
}

export function platformLabel(platform: string): string {
  return isSocialPlatform(platform) ? SOCIAL_PLATFORMS[platform].label : platform;
}

/** A short platform tag for dense lists. */
export function platformShort(platform: string): string {
  return platform === "FACEBOOK_PAGE" ? "Facebook" : platform === "INSTAGRAM" ? "Instagram" : platformLabel(platform);
}

export function formatInZone(iso: string | Date | null | undefined, timezone: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...opts }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", ...opts }).format(date);
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Time zones offered first; any valid IANA name can be typed. */
export const COMMON_TIME_ZONES = ["Asia/Dhaka", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"];

/** The display time zone for the Social Studio pages: ?tz=…, else the server default, else Dhaka. */
export function displayZone(raw: string | undefined): string {
  const candidate = raw?.trim() || process.env.SOCIAL_DEFAULT_TIMEZONE?.trim() || "Asia/Dhaka";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "Asia/Dhaka";
  }
}
