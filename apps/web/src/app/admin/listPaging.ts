import { ALL_ROWS, pickPageSize } from "@/lib/listPageSizes";

/**
 * Paging for the portal's two people lists (Users, Employees). The sizes go up to 5,000 plus "All",
 * like every other large list here (lib/listPageSizes.ts). `size` and `page` are URL parameters, so a
 * paged, searched list can be bookmarked and survives a refresh.
 */
export const ADMIN_LIST_PAGE_SIZES = [50, 100, 250, 500, 1000, 5000, ALL_ROWS];
export const ADMIN_LIST_DEFAULT_SIZE = 100;

export function readListPaging(params: { page?: string; size?: string }, total: number): { page: number; size: number; skip: number } {
  const size = pickPageSize(params.size, ADMIN_LIST_DEFAULT_SIZE, ADMIN_LIST_PAGE_SIZES);
  const lastPage = Math.max(1, Math.ceil(total / size));
  const requested = Math.floor(Number(params.page));
  const page = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, lastPage) : 1;
  return { page, size, skip: (page - 1) * size };
}

/** A list URL with the given parameters; empty and default values are left out. */
export function listHref(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (key === "page" && Number(value) === 1) continue;
    if (key === "size" && Number(value) === ADMIN_LIST_DEFAULT_SIZE) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** The scrolling table frame and its table: the header cells (`Th`, sticky) stay pinned inside it. */
export const SCROLL_TABLE_CLASS = "w-full border-separate border-spacing-0 text-left text-sm [&_tbody_tr:hover]:bg-[var(--color-neutral-bg)]/70 [&_tbody_tr:last-child_td]:border-b-0";
