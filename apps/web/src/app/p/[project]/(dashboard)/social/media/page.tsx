import Link from "@/components/ProjectLink";
import { PageHeader, SearchField } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { listAssetFolders, listSocialAssets, mediaUsage } from "@/server/social/media";
import { formatBytes } from "../socialUi";
import { MediaLibrary } from "./MediaLibrary";

export const metadata = { title: "Media library" };

/** The project's Social Studio media library (SOCIAL_STUDIO.md §Media). */
export default async function SocialMediaPage({ searchParams }: { searchParams: Promise<{ search?: string; folder?: string; kind?: string }> }) {
  const { canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const [assets, folders, usage] = await Promise.all([listSocialAssets({ q: sp.search, folder: sp.folder, kind: sp.kind }), listAssetFolders(), mediaUsage()]);
  const pct = Math.min(100, Math.round((usage.usedBytes / usage.allowanceBytes) * 100));
  const link = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ search: sp.search, folder: sp.folder, kind: sp.kind, ...over })) if (v) p.set(k, v);
    return `/social/media${p.size ? `?${p}` : ""}`;
  };
  return (
    <div>
      <PageHeader title="Media library" description="Photos and videos for posts. Platforms fetch a file through a short-lived signed address only while publishing it." />
      <div className="mb-4 space-y-1">
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
          <div className={`h-full ${pct > 90 ? "bg-[var(--color-danger)]" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs tabular text-[color:var(--color-muted-foreground)]">
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.allowanceBytes)} used · {usage.files} files
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href={link({ folder: undefined })} className={`rounded-[var(--radius-md)] border px-2 py-1 ${!sp.folder ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>
          All folders
        </Link>
        {folders.map((f) => (
          <Link key={f} href={link({ folder: f })} className={`rounded-[var(--radius-md)] border px-2 py-1 ${sp.folder === f ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>
            {f}
          </Link>
        ))}
        <span className="mx-2 h-5 w-px bg-[var(--color-border)]" />
        {[
          ["", "Everything"],
          ["IMAGE", "Photos"],
          ["VIDEO", "Videos"],
        ].map(([k, label]) => (
          <Link key={k} href={link({ kind: k || undefined })} className={`rounded-[var(--radius-md)] border px-2 py-1 ${(sp.kind ?? "") === k ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>
            {label}
          </Link>
        ))}
        <div className="ml-auto">
          <SearchField placeholder="Name, tag or description" defaultValue={sp.search ?? ""} preserve={{ folder: sp.folder, kind: sp.kind }} />
        </div>
      </div>
      <MediaLibrary assets={assets} canEdit={canEdit} folder={sp.folder ?? ""} />
    </div>
  );
}
