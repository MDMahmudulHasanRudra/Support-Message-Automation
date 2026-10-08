import type { ReleaseNoteStatus, ReleaseNoteType } from "@prisma/client";
import { Plus } from "lucide-react";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { listReleaseNotesForAdmin } from "@/server/releaseNotesReports";
import { Button, ButtonLink, FilterBar, Input, PageHeader, Pagination, Select } from "@/components/ui";
import {
  RELEASE_STATUS_LABEL,
  RELEASE_STATUSES,
  RELEASE_TYPE_LABEL,
  RELEASE_TYPES,
} from "@/lib/releaseNotes";
import { ReleaseNotesManageTable } from "./ReleaseNotesManageTable";

const PAGE_SIZE = 25;

interface ManageSearchParams {
  search?: string;
  status?: string;
  releaseType?: string;
  page?: string;
}

/**
 * Every release, every status — the admin's own list, entirely separate from the public one at
 * `/release-notes`. A plain GET-form filter bar (search / status / type), no client JS, matching
 * `/rules`' own filter convention: this app's lists read their filters from the URL, not from local
 * state, so a filtered view can be bookmarked and survives a refresh.
 */
export default async function ManageReleaseNotesPage({
  searchParams,
}: {
  searchParams: Promise<ManageSearchParams>;
}) {
  const session = await requireSession();
  await requirePermission(session, "release_notes.manage");

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const status = (RELEASE_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as ReleaseNoteStatus)
    : undefined;
  const releaseType = (RELEASE_TYPES as readonly string[]).includes(params.releaseType ?? "")
    ? (params.releaseType as ReleaseNoteType)
    : undefined;

  const { rows, total } = await listReleaseNotesForAdmin({
    search: params.search,
    status,
    releaseType,
    page,
    pageSize: PAGE_SIZE,
  });

  function buildHref(nextPage: number): string {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.status) qs.set("status", params.status);
    if (params.releaseType) qs.set("releaseType", params.releaseType);
    if (nextPage > 1) qs.set("page", String(nextPage));
    const query = qs.toString();
    return query ? `/release-notes/manage?${query}` : "/release-notes/manage";
  }

  return (
    <div>
      <PageHeader
        title="Manage Release Notes"
        description="Draft, publish, unpublish and archive changelog entries. Published and archived releases stay visible to every user at /release-notes."
        actions={
          <ButtonLink href="/release-notes/manage/new">
            <Plus className="size-3.5" aria-hidden />
            New Release
          </ButtonLink>
        }
      />

      <FilterBar>
        <form method="GET" className="flex flex-wrap items-end gap-2.5">
          <Input
            name="search"
            type="search"
            placeholder="Search version or title…"
            defaultValue={params.search ?? ""}
            aria-label="Search"
            className="w-56"
          />
          <Select name="status" defaultValue={params.status ?? ""} aria-label="Status" className="w-40">
            <option value="">All statuses</option>
            {RELEASE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {RELEASE_STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
          <Select name="releaseType" defaultValue={params.releaseType ?? ""} aria-label="Release type" className="w-44">
            <option value="">All types</option>
            {RELEASE_TYPES.map((value) => (
              <option key={value} value={value}>
                {RELEASE_TYPE_LABEL[value]}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" size="sm">
            Filter
          </Button>
        </form>
      </FilterBar>

      <ReleaseNotesManageTable
        rows={rows.map((row) => ({
          id: row.id,
          version: row.version,
          title: row.title,
          releaseDate: row.releaseDate.toISOString(),
          releaseType: row.releaseType,
          status: row.status,
          createdByLabel: row.createdBy ? row.createdBy.name || row.createdBy.username : "—",
          updatedAt: row.updatedAt.toISOString(),
        }))}
      />

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={buildHref} />
    </div>
  );
}
