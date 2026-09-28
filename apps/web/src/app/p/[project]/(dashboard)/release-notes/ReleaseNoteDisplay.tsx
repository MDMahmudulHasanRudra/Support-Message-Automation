import { Badge } from "@/components/ui";
import { formatDate } from "@/lib/date";
import {
  RELEASE_SECTIONS,
  RELEASE_STATUS_BADGE_COLOR,
  RELEASE_STATUS_LABEL,
  RELEASE_TYPE_BADGE_COLOR,
  RELEASE_TYPE_LABEL,
  type ReleaseSectionKey,
} from "@/lib/releaseNotes";

/** The subset of `ReleaseNote` every display component here actually reads. */
export interface DisplayableReleaseNote {
  version: string;
  title: string;
  summary: string | null;
  releaseDate: Date;
  releaseType: ReleaseNoteTypeLike;
  status: ReleaseNoteStatusLike;
  affectedModules: string[];
  whatsNew: string[];
  improvements: string[];
  bugFixes: string[];
  security: string[];
  breakingChanges: string[];
  knownIssues: string[];
  technicalNotes: string[];
}

// Kept as string-literal unions rather than importing the Prisma enum types directly: this file is
// imported from a Client Component nowhere today, but keeping it decoupled from `@prisma/client`
// costs nothing and means it can never become the thing that pulls Prisma into a client bundle —
// see the Overview redesign's `DutyStateBadge` incident for exactly how that happens by accident.
type ReleaseNoteTypeLike = keyof typeof RELEASE_TYPE_LABEL;
type ReleaseNoteStatusLike = keyof typeof RELEASE_STATUS_LABEL;

/** Version, title, date, type badge, status badge (only when not PUBLISHED), affected modules. */
export function ReleaseNoteMeta({
  release,
  showStatus = false,
}: {
  release: DisplayableReleaseNote;
  /** The public list never shows this — everything there is already public by definition. The
   * detail page shows it so an admin previewing a draft, or anyone looking at an archived release,
   * knows what they are looking at. */
  showStatus?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="blue">v{release.version}</Badge>
        <Badge color={RELEASE_TYPE_BADGE_COLOR[release.releaseType]}>{RELEASE_TYPE_LABEL[release.releaseType]}</Badge>
        {showStatus && release.status !== "PUBLISHED" ? (
          <Badge color={RELEASE_STATUS_BADGE_COLOR[release.status]} dot>
            {RELEASE_STATUS_LABEL[release.status]}
          </Badge>
        ) : null}
      </div>
      <h2 className="mt-2.5 text-xl font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
        {release.title}
      </h2>
      <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">{formatDate(release.releaseDate)}</p>
      {release.summary ? (
        <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-[color:var(--color-foreground)]">
          {release.summary}
        </p>
      ) : null}
      {release.affectedModules.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {release.affectedModules.map((module) => (
            <Badge key={module} color="gray">
              {module}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The seven bullet sections, in their fixed order, each rendered only when it actually has content. */
export function ReleaseNoteSections({ release }: { release: DisplayableReleaseNote }) {
  const sections = RELEASE_SECTIONS.filter(({ key }) => release[key as ReleaseSectionKey].length > 0);
  if (sections.length === 0) {
    return <p className="text-sm text-[color:var(--color-muted-foreground)]">No details were recorded for this release.</p>;
  }

  return (
    <div className="space-y-5">
      {sections.map(({ key, label, icon: Icon }) => (
        <div key={key}>
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-foreground)]">
            <Icon className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            {label}
          </div>
          <ul className="space-y-1.5">
            {release[key as ReleaseSectionKey].map((line, index) => (
              <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-[color:var(--color-foreground)]">
                <span
                  className="mt-[9px] size-1 shrink-0 rounded-full bg-[color:var(--color-muted-foreground)]"
                  aria-hidden
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
