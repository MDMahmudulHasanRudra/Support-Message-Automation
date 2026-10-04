"use client";

import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, useToast } from "@/components/ui";
import { useProjectHref } from "@/components/ProjectLink";
import { selectAllMatchingEpisodeIds } from "@/server/actions/supportResponse";

/**
 * Selection and export shared by Unanswered Groups and Response Time (SUPPORT_RESPONSE.md) — the
 * same shape as the Groups list: tick rows, tick the page, or widen to everything matching the
 * filters (the server resolves those ids with the page's own `where`), then act on exactly that.
 */

export type SupportResponseTab = "unanswered" | "response-time";

export function useEpisodeSelection(pageIds: string[], tab: SupportResponseTab, query: Record<string, string>) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [widening, setWidening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const allPageSelected = useMemo(() => pageIds.length > 0 && pageIds.every((id) => selected.has(id)), [pageIds, selected]);
  const somePageSelected = pageIds.some((id) => selected.has(id));

  return {
    selected,
    allMatching,
    widening,
    notice,
    allPageSelected,
    somePageSelected,
    pageSelectedCount: pageIds.filter((id) => selected.has(id)).length,
    toggle(id: string) {
      setAllMatching(false);
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    togglePage() {
      setAllMatching(false);
      setSelected((prev) => {
        const next = new Set(prev);
        if (allPageSelected) pageIds.forEach((id) => next.delete(id));
        else pageIds.forEach((id) => next.add(id));
        return next;
      });
    },
    selectAllMatching() {
      setWidening(true);
      setNotice(null);
      void (async () => {
        try {
          const result = await selectAllMatchingEpisodeIds({ tab, query });
          if (result.error) {
            setNotice(result.error);
            return;
          }
          setSelected(new Set(result.ids));
          setAllMatching(true);
          if (result.truncated) setNotice(`Only the first ${result.ids.length.toLocaleString("en-US")} could be selected at once. Narrow the filters and repeat for the rest.`);
        } finally {
          setWidening(false);
        }
      })();
    },
    clear() {
      setAllMatching(false);
      setNotice(null);
      setSelected(new Set());
    },
  };
}

/**
 * Export selected rows, or everything matching the filters. The file is built on the server from
 * the ids or the filters; the browser never holds more than the rows on screen.
 */
export function ExportButtons({ tab, query, selectedIds, total }: { tab: SupportResponseTab; query: Record<string, string>; selectedIds: string[]; total: number }) {
  const toProject = useProjectHref();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(which: "selected" | "all", format: "xlsx" | "csv") {
    setBusy(`${which}-${format}`);
    try {
      const response = await fetch(toProject("/api/messages/support-response/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab, format, query, ids: which === "selected" ? selectedIds : null }),
      });
      if (!response.ok) {
        showToast({ tone: "danger", title: "Export failed", description: (await response.text()) || `The server answered ${response.status}.` });
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? `export.${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="secondary" size="sm" disabled={selectedIds.length === 0 || busy !== null} loading={busy === "selected-xlsx"} onClick={() => run("selected", "xlsx")}>
        <Download className="size-3.5" aria-hidden />
        Export selected ({selectedIds.length.toLocaleString("en-US")})
      </Button>
      <Button variant="secondary" size="sm" disabled={total === 0 || busy !== null} loading={busy === "all-xlsx"} onClick={() => run("all", "xlsx")}>
        <Download className="size-3.5" aria-hidden />
        Export all {total.toLocaleString("en-US")} (Excel)
      </Button>
      <Button variant="ghost" size="sm" disabled={total === 0 || busy !== null} loading={busy === "all-csv"} onClick={() => run("all", "csv")}>
        CSV
      </Button>
    </div>
  );
}
