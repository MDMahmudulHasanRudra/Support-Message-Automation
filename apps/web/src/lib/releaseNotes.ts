import { Bug, Code2, Megaphone, ShieldAlert, Sparkles, TriangleAlert, Wrench, type LucideIcon } from "lucide-react";
import type { ReleaseNoteStatus, ReleaseNoteType } from "@prisma/client";
import type { BadgeColor } from "@/components/ui";

/**
 * Release Notes' small local catalogs and pure helpers.
 *
 * Lives in `apps/web/src/lib/`, not `packages/shared`, unlike most enum-adjacent catalogs in this
 * app (`aiResponseModes.ts`, `replyLanguage.ts`). Those live in the shared package because
 * `apps/worker` needs the exact same values (a prompt renders a reply-language name, a job checks a
 * response mode). Nothing in the worker ever reads or writes a `ReleaseNote` — this is a pure
 * apps/web admin-authoring + user-facing-listing feature — so following that same split here would
 * be coupling two packages for no reason. Matches `apps/web/src/lib/aiResponseModes.ts`'s own
 * reasoning exactly, applied to a feature with the same one-app shape.
 */

// ---------------------------------------------------------------------------------- release type

export const RELEASE_TYPE_LABEL: Record<ReleaseNoteType, string> = {
  MAJOR: "Major",
  FEATURE: "Feature",
  IMPROVEMENT: "Improvement",
  BUG_FIX: "Bug Fix",
  SECURITY: "Security",
  MAINTENANCE: "Maintenance",
};

// Six types, five Badge colors (green/red/yellow/gray/blue) — this is identity, not state, so
// reusing a color for two types is fine; nothing here is meant to encode severity by hue alone
// (the label text next to it always disambiguates).
export const RELEASE_TYPE_BADGE_COLOR: Record<ReleaseNoteType, BadgeColor> = {
  MAJOR: "blue",
  FEATURE: "green",
  IMPROVEMENT: "green",
  BUG_FIX: "yellow",
  SECURITY: "red",
  MAINTENANCE: "gray",
};

export const RELEASE_TYPES: readonly ReleaseNoteType[] = [
  "MAJOR",
  "FEATURE",
  "IMPROVEMENT",
  "BUG_FIX",
  "SECURITY",
  "MAINTENANCE",
];

// ------------------------------------------------------------------------------------- status

export const RELEASE_STATUS_LABEL: Record<ReleaseNoteStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const RELEASE_STATUS_BADGE_COLOR: Record<ReleaseNoteStatus, BadgeColor> = {
  DRAFT: "gray",
  PUBLISHED: "green",
  ARCHIVED: "gray",
};

export const RELEASE_STATUSES: readonly ReleaseNoteStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

// -------------------------------------------------------------------------------- content sections

/** One of the seven `String[]` bullet-list columns on `ReleaseNote`. */
export type ReleaseSectionKey =
  | "whatsNew"
  | "improvements"
  | "bugFixes"
  | "security"
  | "breakingChanges"
  | "knownIssues"
  | "technicalNotes";

/**
 * Display metadata for each section, in the fixed order they are always shown — new, then
 * improved, then fixed, then the three "read this carefully" sections, then the internal one last.
 *
 * Icons rather than the emoji the original mock used (✨ 🛠 🐛 🔒): every other heading, badge and
 * nav entry in this app is a `lucide-react` icon, never a raw emoji glyph, and a changelog page is
 * not the place to start a second visual language.
 */
export const RELEASE_SECTIONS: ReadonlyArray<{ key: ReleaseSectionKey; label: string; icon: LucideIcon }> = [
  { key: "whatsNew", label: "What's New", icon: Sparkles },
  { key: "improvements", label: "Improvements", icon: Wrench },
  { key: "bugFixes", label: "Bug Fixes", icon: Bug },
  { key: "security", label: "Security", icon: ShieldAlert },
  { key: "breakingChanges", label: "Breaking Changes", icon: TriangleAlert },
  { key: "knownIssues", label: "Known Issues", icon: Megaphone },
  { key: "technicalNotes", label: "Technical Notes", icon: Code2 },
];

// --------------------------------------------------------------------------- affected modules

/**
 * Suggested tags for "Affected Modules" — offered as checkboxes in the editor, but the column
 * itself is a plain `String[]`, not an enum, so a module that ships after this list was last
 * updated is never a migration blocker; see the schema's own comment on `affectedModules`. Named
 * after this app's actual nav groups (`(dashboard)/navigation.ts`) rather than invented category
 * names, so a tag here means the same thing a reader already associates with the sidebar.
 */
export const RELEASE_NOTE_MODULE_TAGS: readonly string[] = [
  "WhatsApp Chat",
  "Messages",
  "Escalations",
  "Support Activity",
  "Team Management",
  "Teams Integration",
  "WhatsApp Accounts & Groups",
  "Automation Rules",
  "Bulk Messaging",
  "AI Learning",
  "Conversation Learning",
  "Notifications",
  "System & Settings",
  "Users & Permissions",
  "Release Notes",
];

// -------------------------------------------------------------------------- bullet-line parsing

/**
 * One line per bullet, in the textarea a person actually types into — the natural authoring shape
 * for "NEW\n- Team Management module\n- Shift Management" content, and simpler than this app's
 * usual comma-split convention (`rules.ts`'s keyword field), which is wrong here: a bullet point
 * routinely contains its own commas ("shift, roster and leave management").
 */
export function parseBulletLines(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-•\s]+/, "").trim())
    .filter((line) => line.length > 0);
}

/** The reverse — one bullet per line, for a textarea's `defaultValue` when editing. */
export function formatBulletLines(lines: readonly string[]): string {
  return lines.join("\n");
}
