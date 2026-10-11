"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, RefreshCw, Save, Search, Undo2, Plus, Trash2, ArrowUpToLine, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, X } from "lucide-react";
import { Alert, Badge, Button, ConfirmDialog, Input, useToast } from "@/components/ui";
import {
  cellKey,
  columnLetter,
  EDITOR_WINDOW_COLUMNS,
  EDITOR_WINDOW_ROWS,
  parsePastedGrid,
  SIGNAL_INTERVAL_MS,
  type CellEdit,
  type DimensionChange,
} from "@support-automation/shared";
import { changeSheetDimensionAction, loadSheetWindowAction, saveSheetCellsAction, searchSheetAction } from "@/server/actions/googleSheetEditor";
import type { SearchMatch, SheetWindowData, WindowPurpose } from "@/server/google/editor";

/**
 * The sheet editor (GOOGLE_SHEETS.md §10, Phase 3) with the open-page signals that measure work and
 * viewing time (§7, Phase 7).
 *
 * Not a spreadsheet clone: a bounded window of one tab (200 rows × 26 columns, paged), where a member
 * who may edit types a value or a formula. Save sends only the changed cells, each with what it held
 * when loaded; the server writes only those still holding it and hands the rest back as conflicts, so
 * nobody's change in Google is silently overwritten. Formatting, charts and filters stay in Google.
 *
 * Signals: START when the page is visible, a VIEW signal at most every 30 s while somebody is
 * actually touching the page, a WORK signal while typing, a CLOSE beacon when leaving. A hidden tab,
 * or a visible one nobody touches, sends nothing — idle time is never counted.
 */

type Coords = { row: number; col: number };
type Menu = { kind: "row" | "col"; index: number; left: number; top: number } | null;
type PendingDelete = { change: DimensionChange; label: string } | null;

function randomKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b % 64]).join("");
}

interface RowProps {
  row: number;
  startCol: number;
  display: string[];
  raw: string[] | null;
  drafts: ReadonlyMap<string, string>;
  conflicts: ReadonlyMap<string, string>;
  matches: ReadonlySet<string>;
  selectedCol: number | null;
  editing: { col: number; value: string } | null;
  canEdit: boolean;
  onSelect: (row: number, col: number, edit: boolean) => void;
  onEditChange: (value: string) => void;
  onEditKey: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onEditBlur: () => void;
  onRowMenu: (row: number, el: HTMLElement) => void;
}

const SheetRow = memo(function SheetRow(props: RowProps) {
  const { row, startCol, display, drafts, conflicts, matches, selectedCol, editing, canEdit } = props;
  return (
    <tr>
      <th
        scope="row"
        className="sticky left-0 z-10 w-12 min-w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-1.5 text-right text-[11px] font-medium tabular-nums text-[color:var(--color-muted-foreground)]"
      >
        {canEdit ? (
          <button type="button" className="w-full cursor-pointer rounded px-0.5 hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]" onClick={(e) => props.onRowMenu(row, e.currentTarget)} aria-label={`Row ${row} options`}>
            {row}
          </button>
        ) : (
          row
        )}
      </th>
      {display.map((text, i) => {
        const col = startCol + i;
        const key = cellKey(row, col);
        const draft = drafts.get(key);
        const conflict = conflicts.get(key);
        const isSelected = selectedCol === col;
        const isEditing = editing !== null && editing.col === col;
        const isMatch = matches.has(key);
        return (
          <td
            key={col}
            data-cell={key}
            onMouseDown={(e) => {
              if (e.button !== 0 || isEditing) return;
              props.onSelect(row, col, false);
            }}
            onDoubleClick={() => props.onSelect(row, col, true)}
            title={conflict !== undefined ? `Changed in Google since you loaded it — now “${conflict}”. Save again to replace it with yours, or discard.` : draft !== undefined ? `Unsaved: ${draft}` : text || undefined}
            className={`relative h-7 max-w-[16rem] min-w-[6.5rem] cursor-cell truncate border-b border-r border-[var(--color-border)] px-2 text-[13px] ${
              conflict !== undefined
                ? "bg-[var(--color-danger-bg)]"
                : draft !== undefined
                  ? "bg-[var(--color-warning-bg)] italic"
                  : isMatch
                    ? "bg-[var(--color-info-bg)]"
                    : "bg-[var(--color-surface)]"
            } ${isSelected ? "outline outline-2 -outline-offset-2 outline-[var(--color-accent)]" : ""}`}
          >
            {isEditing ? (
              <input
                autoFocus
                aria-label={`Cell ${columnLetter(col)}${row}`}
                value={editing!.value}
                onChange={(e) => props.onEditChange(e.target.value)}
                onKeyDown={props.onEditKey}
                onBlur={props.onEditBlur}
                className="absolute inset-0 z-20 h-full w-full min-w-[14rem] border-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-1.5 text-[13px] text-[color:var(--color-foreground)] shadow-[var(--shadow-md)] outline-none"
              />
            ) : draft !== undefined ? (
              draft
            ) : (
              text
            )}
          </td>
        );
      })}
    </tr>
  );
});

export function SheetEditor({
  spreadsheetId,
  canEdit,
  editRefusal,
  signalUrl,
  googleUrl,
}: {
  spreadsheetId: string;
  canEdit: boolean;
  editRefusal: string | null;
  signalUrl: string;
  googleUrl: string | null;
}) {
  const { showToast } = useToast();
  const clientKey = useRef<string>("");
  const [data, setData] = useState<SheetWindowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [conflicts, setConflicts] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Coords | null>(null);
  const [editing, setEditing] = useState<(Coords & { value: string }) | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ matches: SearchMatch[]; note: string | null } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const editable = canEdit && Boolean(data?.googleCanEdit) && Boolean(data?.raw);
  const dirty = drafts.size > 0;

  // ── Signals (Phase 7) ──────────────────────────────────────────────────────────────────────────────
  const interacted = useRef(false);
  const typed = useRef(false);
  const lastWorkSent = useRef(0);
  const send = useCallback(
    (kind: "START" | "VIEW_SIGNAL" | "WORK_SIGNAL" | "CLOSE") => {
      if (!clientKey.current) return;
      const body = JSON.stringify({ clientKey: clientKey.current, spreadsheetId, kind });
      if (kind === "CLOSE" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(signalUrl, body);
        return;
      }
      void fetch(signalUrl, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain;charset=UTF-8" } }).catch(() => undefined);
    },
    [signalUrl, spreadsheetId],
  );

  useEffect(() => {
    clientKey.current = randomKey();
    if (document.visibilityState === "visible") send("START");
    const touch = () => {
      interacted.current = true;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") send("START");
    };
    const onLeave = () => send("CLOSE");
    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (typed.current) {
        typed.current = false;
        interacted.current = false;
        lastWorkSent.current = Date.now();
        send("WORK_SIGNAL");
      } else if (interacted.current) {
        interacted.current = false;
        send("VIEW_SIGNAL");
      }
    }, SIGNAL_INTERVAL_MS);
    for (const type of ["pointerdown", "keydown", "wheel"] as const) document.addEventListener(type, touch, { passive: true });
    document.addEventListener("scroll", touch, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.clearInterval(tick);
      for (const type of ["pointerdown", "keydown", "wheel"] as const) document.removeEventListener(type, touch);
      document.removeEventListener("scroll", touch, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onLeave);
      send("CLOSE");
    };
  }, [send]);

  const noteTyping = useCallback(() => {
    typed.current = true;
    // The first keystroke of a stretch is signalled at once; later ones ride on the 30-second tick.
    if (Date.now() - lastWorkSent.current >= SIGNAL_INTERVAL_MS) {
      typed.current = false;
      lastWorkSent.current = Date.now();
      send("WORK_SIGNAL");
    }
  }, [send]);

  // ── Loading ────────────────────────────────────────────────────────────────────────────────────────
  const load = useCallback(
    async (request: { tabId?: number | null; startRow?: number; startCol?: number }, purpose: WindowPurpose) => {
      setLoading(true);
      setError(null);
      const result = await loadSheetWindowAction(spreadsheetId, { ...request, purpose, clientKey: clientKey.current || undefined });
      setLoading(false);
      if ("error" in result) {
        setError(result.error);
        return null;
      }
      setData(result.data);
      return result.data;
    },
    [spreadsheetId],
  );

  useEffect(() => {
    // The first read is also what opening the spreadsheet means in the activity log. (The signals
    // effect above runs first, so the page's key already exists.)
    let cancelled = false;
    void loadSheetWindowAction(spreadsheetId, { purpose: "OPEN", clientKey: clientKey.current || undefined }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if ("error" in result) setError(result.error);
      else setData(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [spreadsheetId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const win = data?.window;
  const rawAt = useCallback((row: number, col: number) => (data?.raw && win ? (data.raw[row - win.startRow]?.[col - win.startCol] ?? "") : ""), [data, win]);
  const displayAt = useCallback((row: number, col: number) => (data && win ? (data.display[row - win.startRow]?.[col - win.startCol] ?? "") : ""), [data, win]);

  const setDraft = useCallback(
    (row: number, col: number, value: string) => {
      const key = cellKey(row, col);
      setDrafts((prev) => {
        const next = new Map(prev);
        if (value === rawAt(row, col)) next.delete(key);
        else next.set(key, value);
        return next;
      });
      setConflicts((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    },
    [rawAt],
  );

  // ── Editing ────────────────────────────────────────────────────────────────────────────────────────
  const move = useCallback(
    (dRow: number, dCol: number) => {
      if (!win) return;
      setSelected((cur) => {
        const base = cur ?? { row: win.startRow, col: win.startCol };
        return {
          row: Math.min(win.startRow + win.rows - 1, Math.max(win.startRow, base.row + dRow)),
          col: Math.min(win.startCol + win.cols - 1, Math.max(win.startCol, base.col + dCol)),
        };
      });
    },
    [win],
  );

  const startEdit = useCallback(
    (at: Coords, initial?: string) => {
      if (!editable) return;
      setSelected(at);
      setEditing({ ...at, value: initial ?? drafts.get(cellKey(at.row, at.col)) ?? rawAt(at.row, at.col) });
    },
    [editable, drafts, rawAt],
  );

  const commitEdit = useCallback(
    (then?: { dRow: number; dCol: number }) => {
      setEditing((cur) => {
        if (cur) setDraft(cur.row, cur.col, cur.value);
        return null;
      });
      if (then) move(then.dRow, then.dCol);
      requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
    },
    [setDraft, move],
  );

  const onSelect = useCallback(
    (row: number, col: number, edit: boolean) => {
      setMenu(null);
      if (edit) startEdit({ row, col });
      else setSelected({ row, col });
    },
    [startEdit],
  );

  const onEditKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit({ dRow: e.shiftKey ? -1 : 1, dCol: 0 });
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitEdit({ dRow: 0, dCol: e.shiftKey ? -1 : 1 });
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
        requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
      }
    },
    [commitEdit],
  );

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing || !selected) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      void navigator.clipboard?.writeText(drafts.get(cellKey(selected.row, selected.col)) ?? displayAt(selected.row, selected.col)).catch(() => undefined);
      return;
    }
    if (mod) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      move(...arrows[e.key]!);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(selected);
    } else if (e.key === "Tab") {
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1);
    } else if ((e.key === "Delete" || e.key === "Backspace") && editable) {
      e.preventDefault();
      setDraft(selected.row, selected.col, "");
      noteTyping();
    } else if (e.key.length === 1 && editable) {
      e.preventDefault();
      startEdit(selected, e.key);
      noteTyping();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selected || !editable || !win) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const grid = parsePastedGrid(text);
    let count = 0;
    let clipped = false;
    grid.forEach((line, r) =>
      line.forEach((value, c) => {
        const row = selected.row + r;
        const col = selected.col + c;
        if (row >= win.startRow + win.rows || col >= win.startCol + win.cols) {
          clipped = true;
          return;
        }
        setDraft(row, col, value);
        count++;
      }),
    );
    noteTyping();
    showToast({ tone: clipped ? "info" : "success", title: clipped ? `Pasted ${count} cells — the rest fell outside this page.` : `Pasted ${count} cell${count === 1 ? "" : "s"}. Save to send them to Google.` });
  };

  // ── Save, discard, structure ───────────────────────────────────────────────────────────────────────
  async function save() {
    if (!data || !dirty || busy) return;
    const edits: CellEdit[] = [...drafts.entries()].map(([key, value]) => {
      const [row, col] = key.split(":").map(Number) as [number, number];
      return { row, col, value, base: rawAt(row, col) };
    });
    setBusy(true);
    const result = await saveSheetCellsAction(spreadsheetId, { tabId: data.tab.sheetId, edits, clientKey: clientKey.current });
    if ("error" in result) {
      setBusy(false);
      showToast({ tone: "danger", title: result.error });
      return;
    }
    const { written, conflicts: clash } = result.result;
    // Reload so the grid shows what Google now holds; only the conflicting cells keep the person's
    // value, now measured against what Google holds instead (a second Save overwrites on purpose).
    const fresh = await load({ tabId: data.tab.sheetId, startRow: data.window.startRow, startCol: data.window.startCol }, "PAGE");
    setBusy(false);
    const keep = new Map<string, string>();
    const marks = new Map<string, string>();
    for (const c of clash) {
      keep.set(cellKey(c.row, c.col), c.value);
      marks.set(cellKey(c.row, c.col), c.now);
    }
    if (fresh) {
      setDrafts(keep);
      setConflicts(marks);
    }
    if (clash.length > 0) {
      showToast({
        tone: "info",
        title: `${written} saved. ${clash.length} cell${clash.length === 1 ? " was" : "s were"} changed in Google meanwhile and not overwritten — shown in red. Save again to replace ${clash.length === 1 ? "it" : "them"} with yours.`,
      });
    } else {
      showToast({ tone: "success", title: written === 0 ? "Nothing needed saving — Google already held those values." : `Saved ${written} cell${written === 1 ? "" : "s"} to Google.` });
    }
  }

  function discard() {
    setDrafts(new Map());
    setConflicts(new Map());
    setEditing(null);
  }

  async function changeDimension(change: DimensionChange) {
    if (!data) return;
    setMenu(null);
    setBusy(true);
    const seen =
      change.kind === "DELETE_ROWS"
        ? { start: data.window.startCol, lines: Array.from({ length: change.count }, (_, i) => data.raw?.[change.from + i - data.window.startRow] ?? []) }
        : change.kind === "DELETE_COLUMNS"
          ? { start: data.window.startRow, lines: Array.from({ length: change.count }, (_, i) => (data.raw ?? []).map((line) => line[change.from + i - data.window.startCol] ?? "")) }
          : null;
    const result = await changeSheetDimensionAction(spreadsheetId, { tabId: data.tab.sheetId, change, seen, clientKey: clientKey.current });
    if ("error" in result) {
      setBusy(false);
      showToast({ tone: "danger", title: result.error });
      return;
    }
    await load({ tabId: data.tab.sheetId, startRow: data.window.startRow, startCol: data.window.startCol }, "PAGE");
    setBusy(false);
    showToast({ tone: "success", title: `${result.description}.` });
  }

  async function runSearch() {
    if (!data || !query.trim()) return;
    setBusy(true);
    const result = await searchSheetAction(spreadsheetId, { tabId: data.tab.sheetId, query, clientKey: clientKey.current });
    setBusy(false);
    if ("error" in result) {
      showToast({ tone: "danger", title: result.error });
      return;
    }
    const note = result.tooMany
      ? `Showing the first ${result.matches.length} matches.`
      : result.partial
        ? `Searched the first ${result.scannedRows.toLocaleString("en-US")} rows (the whole tab is larger).`
        : null;
    setSearch({ matches: result.matches, note });
  }

  async function jumpTo(match: SearchMatch) {
    if (!data) return;
    const startRow = Math.floor((match.row - 1) / EDITOR_WINDOW_ROWS) * EDITOR_WINDOW_ROWS + 1;
    const startCol = Math.floor(match.col / EDITOR_WINDOW_COLUMNS) * EDITOR_WINDOW_COLUMNS;
    if (startRow !== data.window.startRow || startCol !== data.window.startCol) {
      if (dirty) {
        showToast({ tone: "info", title: "Save or discard your changes before moving to another part of the sheet." });
        return;
      }
      await load({ tabId: data.tab.sheetId, startRow, startCol }, "PAGE");
    }
    setSelected({ row: match.row, col: match.col });
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${match.row}:${match.col}"]`)?.scrollIntoView({ block: "center", inline: "center" });
      gridRef.current?.focus({ preventScroll: true });
    });
  }

  const matchKeys = useMemo(() => new Set((search?.matches ?? []).map((m) => cellKey(m.row, m.col))), [search]);

  // Paging and tabs never silently drop unsaved changes.
  const navigate = (request: { tabId?: number | null; startRow?: number; startCol?: number }, purpose: WindowPurpose) => {
    if (dirty) {
      showToast({ tone: "info", title: "Save or discard your changes first." });
      return;
    }
    setSelected(null);
    setSearch(purpose === "TAB" ? null : search);
    void load(request, purpose);
  };

  const onEditChange = useCallback(
    (value: string) => {
      setEditing((cur) => (cur ? { ...cur, value } : cur));
      noteTyping();
    },
    [noteTyping],
  );
  const onEditBlur = useCallback(() => commitEdit(), [commitEdit]);

  const onRowMenu = useCallback((row: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setMenu({ kind: "row", index: row, left: rect.right + 4, top: rect.top });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────────────────────────────
  if (!data) {
    return error ? (
      <Alert tone="danger" title="This spreadsheet could not be opened">
        {error}
      </Alert>
    ) : (
      <div className="flex h-40 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] text-[13px] text-[color:var(--color-muted-foreground)]">
        Opening the spreadsheet…
      </div>
    );
  }

  const w = data.window;
  const lastRow = w.startRow + w.rows - 1;
  const lastCol = w.startCol + w.cols - 1;
  const selectedKey = selected ? cellKey(selected.row, selected.col) : null;
  const selectedRaw = selected ? (drafts.get(selectedKey!) ?? (data.raw ? rawAt(selected.row, selected.col) : displayAt(selected.row, selected.col))) : "";

  return (
    <div className="space-y-3">
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Tabs">
        {data.tabs
          .filter((t) => t.isGrid)
          .map((t) => (
            <button
              key={t.sheetId}
              type="button"
              role="tab"
              aria-selected={t.sheetId === data.tab.sheetId}
              disabled={loading || busy}
              onClick={() => t.sheetId !== data.tab.sheetId && navigate({ tabId: t.sheetId }, "TAB")}
              className={`shrink-0 cursor-pointer rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                t.sheetId === data.tab.sheetId
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {t.title}
              {t.hidden ? <span className="ml-1 text-[11px] opacity-70">(hidden)</span> : null}
            </button>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <>
            <Button size="sm" onClick={() => void save()} disabled={!dirty || busy} loading={busy && dirty}>
              <Save className="size-3.5" aria-hidden />
              {dirty ? `Save ${drafts.size} change${drafts.size === 1 ? "" : "s"}` : "Saved"}
            </Button>
            <Button size="sm" variant="secondary" onClick={discard} disabled={!dirty || busy}>
              <Undo2 className="size-3.5" aria-hidden />
              Discard
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="secondary" onClick={() => navigate({ tabId: data.tab.sheetId, startRow: w.startRow, startCol: w.startCol }, "REFRESH")} disabled={loading || busy}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </Button>
        {editable ? (
          <Button size="sm" variant="secondary" onClick={() => void changeDimension({ kind: "APPEND_ROWS", count: 10 })} disabled={busy || dirty}>
            <Plus className="size-3.5" aria-hidden />
            Add 10 rows at the end
          </Button>
        ) : null}
        <form
          className="ml-auto flex w-full items-center gap-1.5 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in this tab…" aria-label="Find in this tab" className="h-8 sm:w-56" />
          <Button size="sm" variant="secondary" type="submit" disabled={busy || !query.trim()}>
            <Search className="size-3.5" aria-hidden />
            Find
          </Button>
        </form>
      </div>

      {!canEdit && editRefusal ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">{editRefusal}</p> : null}
      {canEdit && !data.googleCanEdit ? (
        <Alert tone="warning" title="Read-only in Google">
          The connected account this spreadsheet is reached through ({data.via}) can only view it in Google. Share it with that account as an Editor, then refresh the spreadsheet list.
        </Alert>
      ) : null}
      {conflicts.size > 0 ? (
        <Alert tone="danger" title={`${conflicts.size} cell${conflicts.size === 1 ? "" : "s"} changed in Google since you loaded ${conflicts.size === 1 ? "it" : "them"}`}>
          Shown in red with your value. Hover to see what Google holds now. Save again to replace it with yours, or Discard to keep Google&apos;s.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Google could not be read">
          {error}
        </Alert>
      ) : null}

      {search ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-[color:var(--color-muted-foreground)]">
            <span>
              {search.matches.length === 0 ? "No matches in this tab." : `${search.matches.length} match${search.matches.length === 1 ? "" : "es"}.`} {search.note}
            </span>
            <button type="button" className="cursor-pointer rounded p-0.5 hover:bg-[var(--color-neutral-bg)]" onClick={() => setSearch(null)} aria-label="Close search results">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          {search.matches.length > 0 ? (
            <ul className="max-h-36 space-y-0.5 overflow-y-auto text-[12.5px]">
              {search.matches.map((m) => (
                <li key={`${m.row}:${m.col}`}>
                  <button type="button" className="w-full cursor-pointer truncate rounded px-1.5 py-0.5 text-left hover:bg-[var(--color-neutral-bg)]" onClick={() => void jumpTo(m)}>
                    <span className="mr-2 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                      {columnLetter(m.col)}
                      {m.row}
                    </span>
                    {m.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px]">
        <span className="w-14 shrink-0 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">{selected ? `${columnLetter(selected.col)}${selected.row}` : "—"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={selectedRaw}>
          {selectedRaw}
        </span>
        {dirty ? <Badge color="yellow">{drafts.size} unsaved</Badge> : null}
      </div>

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKey}
        onPaste={onPaste}
        aria-label={`${data.tab.title}, rows ${w.startRow} to ${lastRow}, columns ${columnLetter(w.startCol)} to ${columnLetter(lastCol)}`}
        className={`relative max-h-[65vh] overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]/40 ${loading ? "opacity-60" : ""}`}
      >
        <table className="border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 h-7 w-12 min-w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)]" />
              {Array.from({ length: w.cols }, (_, i) => w.startCol + i).map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="sticky top-0 z-20 h-7 min-w-[6.5rem] border-b border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2 text-center text-[11px] font-medium text-[color:var(--color-muted-foreground)]"
                >
                  {editable ? (
                    <button
                      type="button"
                      className="w-full cursor-pointer rounded hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenu({ kind: "col", index: col, left: rect.left, top: rect.bottom + 4 });
                      }}
                      aria-label={`Column ${columnLetter(col)} options`}
                    >
                      {columnLetter(col)}
                    </button>
                  ) : (
                    columnLetter(col)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.display.map((line, i) => {
              const row = w.startRow + i;
              return (
                <SheetRow
                  key={row}
                  row={row}
                  startCol={w.startCol}
                  display={line}
                  raw={data.raw?.[i] ?? null}
                  drafts={drafts}
                  conflicts={conflicts}
                  matches={matchKeys}
                  selectedCol={selected?.row === row ? selected.col : null}
                  editing={editing?.row === row ? { col: editing.col, value: editing.value } : null}
                  canEdit={editable}
                  onSelect={onSelect}
                  onEditChange={onEditChange}
                  onEditKey={onEditKey}
                  onEditBlur={onEditBlur}
                  onRowMenu={onRowMenu}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-[color:var(--color-muted-foreground)]">
        <span>
          Rows {w.startRow.toLocaleString("en-US")}–{lastRow.toLocaleString("en-US")} of {data.tab.rowCount.toLocaleString("en-US")} · Columns {columnLetter(w.startCol)}–{columnLetter(lastCol)} of{" "}
          {data.tab.columnCount} · through {data.via}
          {googleUrl ? (
            <>
              {" · "}
              <a href={googleUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-[color:var(--color-accent)] hover:underline">
                Formatting and charts in Google Sheets
              </a>
            </>
          ) : null}
        </span>
        <span className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous rows" disabled={loading || w.startRow <= 1} onClick={() => navigate({ tabId: data.tab.sheetId, startRow: Math.max(1, w.startRow - EDITOR_WINDOW_ROWS), startCol: w.startCol }, "PAGE")}>
            <ChevronUp className="size-4" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next rows" disabled={loading || lastRow >= data.tab.rowCount} onClick={() => navigate({ tabId: data.tab.sheetId, startRow: w.startRow + EDITOR_WINDOW_ROWS, startCol: w.startCol }, "PAGE")}>
            <ChevronDown className="size-4" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Previous columns" disabled={loading || w.startCol <= 0} onClick={() => navigate({ tabId: data.tab.sheetId, startRow: w.startRow, startCol: Math.max(0, w.startCol - EDITOR_WINDOW_COLUMNS) }, "PAGE")}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next columns" disabled={loading || lastCol >= data.tab.columnCount - 1} onClick={() => navigate({ tabId: data.tab.sheetId, startRow: w.startRow, startCol: w.startCol + EDITOR_WINDOW_COLUMNS }, "PAGE")}>
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </span>
      </div>
      {editable ? (
        <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
          Double-click a cell or start typing to change it; Enter or Tab to move on, Esc to cancel. Paste from any spreadsheet. Nothing reaches Google until you press Save. Row numbers and column letters open insert and delete.
        </p>
      ) : null}

      {menu ? (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setMenu(null)} />
          <div
            role="menu"
            className="fixed z-50 w-52 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-[13px] shadow-[var(--shadow-lg)]"
            style={{ left: Math.min(menu.left, window.innerWidth - 216), top: Math.min(menu.top, window.innerHeight - 140) }}
          >
            {(menu.kind === "row"
              ? [
                  { label: `Insert a row above ${menu.index}`, icon: ArrowUpToLine, run: () => changeDimension({ kind: "INSERT_ROWS", at: menu.index, count: 1 }) },
                  { label: `Insert a row below ${menu.index}`, icon: ArrowDownToLine, run: () => changeDimension({ kind: "INSERT_ROWS", at: menu.index + 1, count: 1 }) },
                  { label: `Delete row ${menu.index}`, icon: Trash2, danger: true, run: () => setPendingDelete({ change: { kind: "DELETE_ROWS", from: menu.index, count: 1 }, label: `row ${menu.index}` }) },
                ]
              : [
                  { label: `Insert a column left of ${columnLetter(menu.index)}`, icon: ArrowLeftToLine, run: () => changeDimension({ kind: "INSERT_COLUMNS", at: menu.index, count: 1 }) },
                  { label: `Insert a column right of ${columnLetter(menu.index)}`, icon: ArrowRightToLine, run: () => changeDimension({ kind: "INSERT_COLUMNS", at: menu.index + 1, count: 1 }) },
                  {
                    label: `Delete column ${columnLetter(menu.index)}`,
                    icon: Trash2,
                    danger: true,
                    run: () => setPendingDelete({ change: { kind: "DELETE_COLUMNS", from: menu.index, count: 1 }, label: `column ${columnLetter(menu.index)}` }),
                  },
                ]
            ).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={busy || dirty}
                onClick={() => {
                  setMenu(null);
                  void item.run();
                }}
                className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-neutral-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  "danger" in item && item.danger ? "text-[color:var(--color-danger-fg)]" : ""
                }`}
              >
                <item.icon className="size-3.5 shrink-0" aria-hidden />
                {item.label}
              </button>
            ))}
            {dirty ? <p className="px-2 pb-1 pt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">Save or discard your changes first.</p> : null}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void changeDimension(target.change);
        }}
        title={pendingDelete ? `Delete ${pendingDelete.label} in Google Sheets?` : ""}
        description="It is deleted in the spreadsheet itself, for everyone. If it changed in Google since you loaded it, nothing is deleted and you are told."
        confirmLabel="Delete"
        tone="danger"
        loading={busy}
      />
    </div>
  );
}
