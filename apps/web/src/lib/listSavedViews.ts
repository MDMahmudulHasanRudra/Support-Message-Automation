import type { PermissionKey } from "@support-automation/shared";

/**
 * The list pages that offer saved views (PROJECT_MODULES.md §Saved views), each with the keys that
 * open it and share a view on it, and the filters it understands. A query is reduced to those
 * filters before it is stored, so a saved view can never carry anything the page would not read.
 */
export const SAVED_VIEW_PAGES = {
  "/commerce/orders": { view: "orders.view", manage: "orders.manage", params: ["status", "search"] },
  "/commerce/products": { view: "commerce.view", manage: "commerce.manage", params: ["status", "search", "category"] },
  "/commerce/shipments": { view: "shipments.view", manage: "shipments.manage", params: ["status", "search"] },
  "/sales": { view: "sales.view", manage: "sales.manage", params: ["search", "closed"] },
} as const satisfies Record<string, { view: PermissionKey; manage: PermissionKey; params: readonly string[] }>;

export type SavedViewPage = keyof typeof SAVED_VIEW_PAGES;

export function isSavedViewPage(value: unknown): value is SavedViewPage {
  return typeof value === "string" && value in SAVED_VIEW_PAGES;
}

/** The page's own filters only, each at most 200 characters, in a stable order. */
export function sanitizeViewQuery(page: SavedViewPage, raw: string | Record<string, string | undefined>): string {
  const source = typeof raw === "string" ? new URLSearchParams(raw.replace(/^\?/, "")) : new URLSearchParams(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const out = new URLSearchParams();
  for (const key of [...SAVED_VIEW_PAGES[page].params].sort()) {
    const v = source.get(key)?.trim();
    if (v) out.set(key, v.slice(0, 200));
  }
  return out.toString();
}
