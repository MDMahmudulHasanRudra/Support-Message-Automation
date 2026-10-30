import { prisma } from "@/server/db";
import { sanitizeViewQuery, type SavedViewPage } from "@/lib/listSavedViews";

export interface SavedViewItem {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
}

/** This person's views on a page, then the shared ones, each query re-reduced to the page's filters. */
export async function loadSavedViews(page: SavedViewPage, userId: string): Promise<SavedViewItem[]> {
  const rows = await prisma.listSavedView.findMany({
    where: { path: page, OR: [{ ownerId: userId }, { shared: true }] },
    orderBy: [{ shared: "asc" }, { name: "asc" }],
    take: 60,
    select: { id: true, name: true, query: true, shared: true, ownerId: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, query: sanitizeViewQuery(page, r.query), shared: r.shared, mine: r.ownerId === userId }));
}
