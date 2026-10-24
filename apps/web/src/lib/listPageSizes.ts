/**
 * Page sizes for the large record lists (Clients, Subscriptions, Billing, Payments, the import
 * review). A project importing 5,000 clients has to be able to see them without clicking through
 * twenty pages, so the list goes up to 5,000 plus "All".
 *
 * "All" is a number, not a separate code path: `ALL_ROWS` rows on one page. It is a ceiling on
 * purpose. Every row is rendered on the server, and an unbounded page on a 50,000-client project
 * would be one request nobody can wait for. Past the ceiling the ordinary Next/Previous still works.
 */
export const ALL_ROWS = 10_000;

export const LARGE_LIST_PAGE_SIZES = [25, 50, 100, 250, 500, 1000, 2000, 5000, ALL_ROWS] as const;

/** The label a page-size control shows: "All" for the ceiling, otherwise the number. */
export function pageSizeLabel(size: number): string {
  return size === ALL_ROWS ? "All" : size.toLocaleString("en-US");
}

/** A requested size, if it is one of the offered sizes; otherwise the fallback. */
export function pickPageSize(requested: unknown, fallback: number, sizes: readonly number[] = LARGE_LIST_PAGE_SIZES): number {
  const n = Number(requested);
  return sizes.includes(n) ? n : fallback;
}

/**
 * The scroll box around a large table. The table scrolls inside it, both ways, with its header
 * pinned (`sticky top-0` on the header cells), so a long list never scrolls the whole page away
 * from its filters and its pager. The height leaves room for the page's own header and the pager;
 * the minimum keeps a usable box on a short window.
 */
export const LIST_SCROLL_BOX = "max-h-[max(22rem,calc(100dvh-14rem))] overflow-auto";
