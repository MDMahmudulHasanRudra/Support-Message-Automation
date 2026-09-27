"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { Button, Checkbox, Input, Select, useToast } from "@/components/ui";
import type { ReportTableData } from "@/server/teamReportTables";

/**
 * One of the Team Report's selectable tables (Team members, By day, Groups): row checkboxes, search,
 * sortable columns, page size and pages, sticky header and footer, and an Export menu.
 *
 * All rows arrive with the page. That is deliberate rather than a shortcut: the report has to read
 * every message in the period to compute ANY of its figures, so by the time these tables exist
 * their rows are already computed aggregates — one per team member, one per day (at most 92), one
 * per group (a couple of thousand at most).
 * Paging them on the server would re-run the whole report per page for rows the browser could
 * hold anyway. The file is built on the server, so the heavy spreadsheet library never reaches
 * the browser and the UI stays responsive while it is written.
 *
 * Export sends the ROW KEYS in the order on screen and the server rebuilds those rows from the same
 * definitions the page used (server/teamReportTables.ts): same columns, names, order and values,
 * no checkbox column.
 */

const PAGE_SIZES = [50, 100, 250, 500, 1000];

type ExportScope = "selected" | "page" | "all";
type SortState = { column: number; direction: "asc" | "desc" } | null;

const compare = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

export function ReportDataTable({
  table,
  title,
  description,
  query,
  noun,
}: {
  table: ReportTableData;
  title: string;
  description: string;
  /** The report's current filters, so the export computes the same report. */
  query: string;
  noun: { singular: string; plural: string };
}) {
  const { showToast } = useToast();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]!);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Search, then sort: "All filtered" and the page both come from this list.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    // The first column, plus the text under it (a group's WhatsApp id), so a pasted id finds its group.
    const rows = needle
      ? table.rows.filter((row) => `${row.cells[0]} ${row.sub?.[0] ?? ""}`.toLowerCase().includes(needle))
      : table.rows;
    if (!sort) return rows;
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(a.sort[sort.column]!, b.sort[sort.column]!));
  }, [table.rows, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, filtered.length);

  const pageSelected = pageRows.filter((row) => selected.has(row.key)).length;
  const allOnPage = pageRows.length > 0 && pageSelected === pageRows.length;

  // A new page of data from the server (filters changed) keeps no stale selection.
  const rowKeys = table.rows.map((row) => row.key).join("|");
  const [seenKeys, setSeenKeys] = useState(rowKeys);
  if (seenKeys !== rowKeys) {
    setSeenKeys(rowKeys);
    setSelected(new Set());
    setPage(1);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [currentPage, pageSize]);

  function toggleAllOnPage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of pageRows) {
        if (allOnPage) next.delete(row.key);
        else next.add(row.key);
      }
      return next;
    });
  }

  function toggleRow(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSort(column: number) {
    setSort((current) =>
      current?.column !== column
        ? { column, direction: table.columns[column]?.numeric ? "desc" : "asc" }
        : current.direction === (table.columns[column]?.numeric ? "desc" : "asc")
          ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
          : null,
    );
    setPage(1);
  }

  async function runExport(scope: ExportScope, format: "xlsx" | "csv") {
    const rows =
      scope === "selected" ? filtered.filter((row) => selected.has(row.key)) : scope === "page" ? pageRows : filtered;
    // Selected rows hidden by the search are still selected; export them too, after the visible ones.
    const hiddenSelected =
      scope === "selected" ? table.rows.filter((row) => selected.has(row.key) && !rows.includes(row)) : [];
    const keys = [...rows, ...hiddenSelected].map((row) => row.key);
    if (keys.length === 0) {
      showToast({ tone: "info", title: "Nothing to export", description: `No ${noun.plural} match.` });
      return;
    }
    setExporting(`${scope}-${format}`);
    try {
      const response = await fetch(`/api/team-report/table-export?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: table.id, format, keys }),
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
      const plain = /filename="([^"]+)"/.exec(disposition)?.[1];
      const filename = encoded ? decodeURIComponent(encoded) : (plain ?? `team-report.${format}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast({
        tone: "success",
        title: "Export ready",
        description: `${keys.length.toLocaleString("en-US")} ${keys.length === 1 ? noun.singular : noun.plural} in ${filename}`,
      });
    } catch {
      showToast({ tone: "danger", title: "Export failed", description: "The file could not be created. Try again, or reload the report." });
    } finally {
      setExporting(null);
    }
  }

  const colCount = table.columns.length + 1;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{description}</p>
        </div>
        <ExportMenu
          selectedCount={selected.size}
          pageCount={pageRows.length}
          filteredCount={filtered.length}
          busy={exporting}
          onExport={runExport}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={`Search ${table.columns[0]?.label.toLowerCase()}`}
            aria-label={`Search ${title}`}
            className="pl-8 text-[13px]"
          />
        </div>
        <p className="text-[13px] text-[color:var(--color-muted-foreground)]" aria-live="polite">
          {selected.size > 0 ? (
            <>
              <strong className="font-medium text-[color:var(--color-foreground)]">{selected.size.toLocaleString("en-US")}</strong>{" "}
              {selected.size === 1 ? noun.singular : noun.plural} selected ·{" "}
              <button type="button" className="link cursor-pointer" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </>
          ) : (
            <>Select rows to export only those.</>
          )}
        </p>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]">
        {/* The scroll container is the table's own, so the header sticks to IT and the footer below
            stays in reach however long the table is. Scrolls sideways on a narrow screen. */}
        <div ref={scrollRef} className="max-h-[min(70vh,44rem)] overflow-auto">
          <table className="w-full border-collapse text-left text-sm [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-[var(--duration-fast)] [&_tbody_tr:hover]:bg-[var(--color-neutral-bg)]/70 [&_tbody_tr:last-child_td]:border-b-0">
            <thead>
              <tr>
                <th className="sticky top-0 z-[var(--z-sticky)] w-10 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] py-2.5 pr-1 pl-4">
                  <Checkbox
                    checked={allOnPage}
                    indeterminate={pageSelected > 0 && !allOnPage}
                    onChange={toggleAllOnPage}
                    disabled={pageRows.length === 0}
                    aria-label={allOnPage ? `Deselect all ${noun.plural} on this page` : `Select all ${noun.plural} on this page`}
                  />
                </th>
                {table.columns.map((column, index) => {
                  const active = sort?.column === index;
                  return (
                    <th
                      key={column.label}
                      aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : "none"}
                      className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2.5 text-xs font-medium whitespace-nowrap text-[color:var(--color-muted-foreground)]"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(index)}
                        className={`inline-flex cursor-pointer items-center gap-1 rounded-[var(--radius-xs)] hover:text-[color:var(--color-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:outline-none ${
                          active ? "text-[color:var(--color-foreground)]" : ""
                        }`}
                      >
                        {column.label}
                        {active ? (
                          sort!.direction === "asc" ? (
                            <ArrowUp className="size-3" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3" aria-hidden />
                          )
                        ) : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
                    No {noun.plural} match “{search}”.
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => {
                  const isSelected = selected.has(row.key);
                  return (
                    <tr key={row.key} className={isSelected ? "bg-[var(--color-accent-bg)]" : undefined}>
                      <td className="w-10 border-b border-[var(--color-border)] py-3 pr-1 pl-4 align-middle">
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggleRow(row.key)}
                          aria-label={`Select ${row.cells[0]}`}
                        />
                      </td>
                      {row.cells.map((cell, index) => (
                        <td
                          key={index}
                          className={`border-b border-[var(--color-border)] px-4 py-3 align-middle whitespace-nowrap ${
                            index === 0
                              ? row.muted
                                ? "text-[color:var(--color-muted-foreground)]"
                                : "text-[color:var(--color-foreground)]"
                              : table.columns[index]?.numeric
                                ? "tabular text-[color:var(--color-foreground)]"
                                : table.columns[index]?.muted
                                  ? "tabular text-[color:var(--color-muted-foreground)]"
                                  : "tabular text-[color:var(--color-foreground)]"
                          }`}
                        >
                          {index === 0 && row.href ? (
                            <Link className="link" href={row.href}>
                              {cell}
                            </Link>
                          ) : typeof cell === "number" ? (
                            cell.toLocaleString("en-US")
                          ) : (
                            cell
                          )}
                          {row.sub?.[index] ? (
                            <span className="block text-[11px] text-[color:var(--color-subtle-foreground)]">{row.sub[index]}</span>
                          ) : null}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[13px] text-[color:var(--color-muted-foreground)]">
          <p className="tabular">
            {filtered.length === 0
              ? `No ${noun.plural}`
              : `${rangeStart.toLocaleString("en-US")}–${rangeEnd.toLocaleString("en-US")} of ${filtered.length.toLocaleString("en-US")} ${
                  filtered.length === 1 ? noun.singular : noun.plural
                }`}
            {search && filtered.length !== table.rows.length ? ` (filtered from ${table.rows.length.toLocaleString("en-US")})` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 whitespace-nowrap">
              Rows per page
              <Select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="w-24 text-[13px]"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size.toLocaleString("en-US")}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page">
                <ChevronLeft className="size-3.5" aria-hidden />
                Previous
              </Button>
              <span className="tabular px-1 text-xs font-medium text-[color:var(--color-foreground)]">
                Page {currentPage} of {totalPages}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages} aria-label="Next page">
                Next
                <ChevronRight className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Export ▾ — which rows (selected / this page / all filtered), then which format. */
function ExportMenu({
  selectedCount,
  pageCount,
  filteredCount,
  busy,
  onExport,
}: {
  selectedCount: number;
  pageCount: number;
  filteredCount: number;
  busy: string | null;
  onExport: (scope: ExportScope, format: "xlsx" | "csv") => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const scopes: Array<{ scope: ExportScope; label: string; count: number }> = [
    { scope: "selected", label: "Selected rows", count: selectedCount },
    { scope: "page", label: "Current page", count: pageCount },
    { scope: "all", label: "All filtered", count: filteredCount },
  ];

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} loading={busy !== null}>
        {busy ? null : <Download className="size-3.5" aria-hidden />}
        {busy ? "Exporting…" : selectedCount > 0 ? `Export (${selectedCount.toLocaleString("en-US")})` : "Export"}
        <ChevronDown className="size-3.5" aria-hidden />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-[var(--z-floating)] mt-1.5 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          {scopes.map(({ scope, label, count }) => (
            <div key={scope} className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] px-2 py-1.5">
              <span className="text-[13px] text-[color:var(--color-foreground)]">
                {label}
                <span className="tabular ml-1.5 text-[11px] text-[color:var(--color-subtle-foreground)]">{count.toLocaleString("en-US")}</span>
              </span>
              <span className="flex gap-1">
                {(["xlsx", "csv"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    disabled={count === 0 || busy !== null}
                    onClick={() => {
                      setOpen(false);
                      onExport(scope, format);
                    }}
                    className="cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Export ${label.toLowerCase()} as ${format === "xlsx" ? "Excel" : "CSV"}`}
                  >
                    {format === "xlsx" ? "Excel" : "CSV"}
                  </button>
                ))}
              </span>
            </div>
          ))}
          <p className="mt-1 border-t border-[var(--color-border)] px-2 pt-2 pb-1 text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">
            Same columns and order as the table. The checkbox column is not exported.
          </p>
        </div>
      ) : null}
    </div>
  );
}
