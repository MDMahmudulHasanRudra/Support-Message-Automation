"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Pin, Unplug } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Input,
  Label,
  SectionHeader,
  Select,
  StatTile,
  StepIndicator,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { createGroupBroadcastJob, previewExcelUpload } from "@/server/actions/groupBroadcast";
import { SavedGroupSetBar, type SavedGroupSetOption } from "./SavedGroupSetBar";
import type { GroupMatchResult } from "@support-automation/shared";

export interface WizardGroup {
  id: string;
  name: string;
  isMonitored: boolean;
  /** Computed server-side at page-load time — whether the last group sync is recent enough to trust as a membership signal. */
  isFresh: boolean;
  /** Shared with the chat inbox — one taxonomy over these groups, not two. */
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  isPinned: boolean;
}

export interface WizardAccount {
  id: string;
  label: string;
  status: string;
  groups: WizardGroup[];
}

interface SelectedTarget {
  groupId: string;
  groupName: string;
  /** Per-row Excel message; null means "use the common message". */
  message: string | null;
  source: "MANUAL" | "EXCEL";
}

const STEP_LABELS = ["Select Account", "Select Groups", "Review Selection", "Compose Message", "Preview"];

export function GroupMessageSenderWizard({
  accounts,
  maxPerJob,
  automationEnabled,
  savedSets,
}: {
  accounts: WizardAccount[];
  maxPerJob: number;
  automationEnabled: boolean;
  savedSets: SavedGroupSetOption[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mode, setMode] = useState<"MANUAL" | "EXCEL">("MANUAL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, SelectedTarget>>(new Map());
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [selectionFilter, setSelectionFilter] = useState<"all" | "selected" | "unselected">("all");
  const [excelResults, setExcelResults] = useState<GroupMatchResult[]>([]);
  const [excelFileErrors, setExcelFileErrors] = useState<string[]>([]);
  const [ambiguousResolutions, setAmbiguousResolutions] = useState<Map<number, string>>(new Map());
  const [commonMessage, setCommonMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;

  /**
   * Filters compose rather than replace each other: category AND search AND selection-state all
   * narrow the same list at once. "Premium groups containing Dhaka that I have not picked yet" is
   * a real question at this scale, and a single-filter control cannot ask it.
   */
  const filteredGroups = useMemo(() => {
    let groups = account?.groups ?? [];

    if (categoryFilter === "__pinned__") groups = groups.filter((g) => g.isPinned);
    else if (categoryFilter === "__none__") groups = groups.filter((g) => !g.categoryId);
    else if (categoryFilter) groups = groups.filter((g) => g.categoryId === categoryFilter);

    if (selectionFilter === "selected") groups = groups.filter((g) => selected.has(g.id));
    else if (selectionFilter === "unselected") groups = groups.filter((g) => !selected.has(g.id));

    const q = search.trim().toLowerCase();
    if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q));

    // Pinned first inside whatever survived, so the groups somebody marked as important stay
    // reachable without scrolling a filtered list of four hundred.
    return [...groups].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return 0;
    });
  }, [account, search, categoryFilter, selectionFilter, selected]);

  /** Categories present on this account's groups, with live counts. */
  const categories = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; color: string; count: number }>();
    for (const g of account?.groups ?? []) {
      if (!g.categoryId || !g.categoryName) continue;
      const existing = byId.get(g.categoryId);
      if (existing) existing.count += 1;
      else byId.set(g.categoryId, { id: g.categoryId, name: g.categoryName, color: g.categoryColor ?? "gray", count: 1 });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [account]);

  const pinnedCount = useMemo(
    () => (account?.groups ?? []).filter((g) => g.isPinned).length,
    [account],
  );

  const targets = useMemo(() => [...selected.values()], [selected]);
  const overLimit = targets.length > maxPerJob;

  const unresolvedSkips = useMemo(() => {
    const skips: Array<{ groupName: string; reason: string }> = [];
    for (const result of excelResults) {
      if (result.status === "UNMATCHED" || result.status === "DUPLICATE") {
        skips.push({ groupName: result.groupName, reason: result.reason });
      } else if (result.status === "AMBIGUOUS" && !ambiguousResolutions.has(result.rowNumber)) {
        skips.push({ groupName: result.groupName, reason: result.reason });
      }
    }
    return skips;
  }, [excelResults, ambiguousResolutions]);

  function setTarget(target: SelectedTarget) {
    setSelected((prev) => new Map(prev).set(target.groupId, target));
  }

  function removeTarget(groupId: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
  }

  function toggleManualGroup(g: WizardGroup) {
    if (selected.has(g.id)) removeTarget(g.id);
    else setTarget({ groupId: g.id, groupName: g.name, message: null, source: "MANUAL" });
  }

  /**
   * Every bulk selection tool funnels through here.
   *
   * `add` and `remove` rather than a single toggle, because at this scale they are different
   * intentions: "add the Premium ones to what I have" and "take the Premium ones out again" are
   * both things people mean, and a toggle over three hundred rows does neither predictably — it
   * inverts each one separately and leaves a selection nobody can describe.
   */
  function applyToGroups(groups: WizardGroup[], mode: "add" | "remove") {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of groups) {
        if (mode === "remove") next.delete(g.id);
        else if (!next.has(g.id)) {
          next.set(g.id, { groupId: g.id, groupName: g.name, message: null, source: "MANUAL" });
        }
      }
      return next;
    });
  }

  function selectAllFiltered() {
    applyToGroups(filteredGroups, "add");
  }

  /**
   * Invert within what is currently filtered, never across the whole account.
   *
   * Inverting 1,944 groups because somebody searched for "Dhaka" and pressed the wrong button is
   * not an operation anybody wants, and it is the single most expensive mistake available on this
   * screen — the confirmation step would then be asked to approve a selection the operator never
   * conceived of.
   */
  function invertFiltered() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of filteredGroups) {
        if (next.has(g.id)) next.delete(g.id);
        else next.set(g.id, { groupId: g.id, groupName: g.name, message: null, source: "MANUAL" });
      }
      return next;
    });
  }

  /** Clears everything, Excel-sourced rows included — it is "start again", not "clear the list". */
  function clearSelection() {
    setSelected(new Map());
  }

  async function handleExcelFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set("accountId", accountId);
      formData.set("file", file);
      const result = await previewExcelUpload(formData);
      setExcelFileErrors(result.fileErrors);
      setExcelResults(result.results);
      setAmbiguousResolutions(new Map());
      setSelected((prev) => {
        const next = new Map(prev);
        for (const row of result.results) {
          if (row.status === "MATCHED" && row.matchedGroupId) {
            next.set(row.matchedGroupId, {
              groupId: row.matchedGroupId,
              groupName: row.matchedGroupName ?? row.groupName,
              message: row.message,
              source: "EXCEL",
            });
          }
        }
        return next;
      });
    } catch {
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  function resolveAmbiguous(result: GroupMatchResult, groupId: string) {
    const candidate = result.ambiguousCandidates.find((c) => c.id === groupId);
    if (!candidate) return;
    setAmbiguousResolutions((prev) => new Map(prev).set(result.rowNumber, groupId));
    setTarget({ groupId, groupName: candidate.name, message: result.message, source: "EXCEL" });
  }

  async function handleConfirm() {
    if (!account) return;
    setConfirming(true);
    setError(null);
    try {
      const source = deriveSource();
      const result = await createGroupBroadcastJob({
        accountId: account.id,
        source,
        commonMessage,
        targets: targets.map((t) => ({ groupId: t.groupId, groupName: t.groupName, message: t.message })),
        preQueueSkipReasons: unresolvedSkips,
      });
      if (result.error) {
        setError(result.error);
        setConfirming(false);
        setConfirmOpen(false);
        return;
      }
      router.push(`/group-message-sender/jobs/${result.jobId}`);
    } catch {
      setError("Failed to create the job. Please try again.");
      setConfirming(false);
      setConfirmOpen(false);
    }
  }

  function deriveSource(): "MANUAL" | "EXCEL" | "MIXED" {
    const hasManual = targets.some((t) => t.source === "MANUAL");
    const hasExcel = targets.some((t) => t.source === "EXCEL");
    if (hasManual && hasExcel) return "MIXED";
    return hasExcel ? "EXCEL" : "MANUAL";
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Unplug className="size-5" aria-hidden />}>
          No connected WhatsApp account is available. Connect an account on the Accounts page first.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!automationEnabled ? (
        <Alert tone="warning" title="Automation is currently PAUSED (kill switch)">
          You can prepare a job, but nothing will be sent until it is resumed on the Automation Control page.
        </Alert>
      ) : null}

      <StepIndicator steps={STEP_LABELS} currentStep={step} />

      <div key={step} className="animate-fade-in-rise space-y-6">
      {step === 1 ? (
        <Card>
          <SectionHeader title="WhatsApp Account" />
          <Select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setSelected(new Map());
              setExcelResults([]);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.status}) — {a.groups.length} synchronized group(s)
              </option>
            ))}
          </Select>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <SectionHeader title="Choose Groups" />
          <div className="mb-4 flex gap-2">
            <Button variant={mode === "MANUAL" ? "primary" : "secondary"} onClick={() => setMode("MANUAL")}>
              Manual Selection
            </Button>
            <Button variant={mode === "EXCEL" ? "primary" : "secondary"} onClick={() => setMode("EXCEL")}>
              Excel Import
            </Button>
          </div>

          {mode === "MANUAL" ? (
            <div>
              {/* Filters first, then the actions that operate on what they left. Reading the
                  row top to bottom is the order the work happens in: narrow, then act. */}
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Search groups by name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />

                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by category"
                  className="h-8 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[color:var(--color-foreground)] outline-none focus-visible:border-[var(--color-primary)]"
                >
                  <option value="">All categories</option>
                  {pinnedCount > 0 ? <option value="__pinned__">Pinned ({pinnedCount})</option> : null}
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name} ({category.count})
                    </option>
                  ))}
                  <option value="__none__">Uncategorised</option>
                </select>

                <select
                  value={selectionFilter}
                  onChange={(e) => setSelectionFilter(e.target.value as "all" | "selected" | "unselected")}
                  aria-label="Filter by selection state"
                  className="h-8 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[color:var(--color-foreground)] outline-none focus-visible:border-[var(--color-primary)]"
                >
                  <option value="all">Selected or not</option>
                  <option value="selected">Selected only</option>
                  <option value="unselected">Not selected</option>
                </select>

                {search || categoryFilter || selectionFilter !== "all" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSearch("");
                      setCategoryFilter("");
                      setSelectionFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>

              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={selectAllFiltered}>
                  Select all {filteredGroups.length}
                </Button>
                {/* Removes only what the filters currently show, so "take the Premium ones back
                    out" does not also discard an unrelated selection made five minutes ago. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => applyToGroups(filteredGroups, "remove")}
                  disabled={filteredGroups.length === 0}
                >
                  Deselect these
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={invertFiltered}
                  disabled={filteredGroups.length === 0}
                >
                  Invert
                </Button>
                {selected.size > 0 ? (
                  <Button variant="ghost" size="sm" onClick={clearSelection}>
                    Clear all ({selected.size})
                  </Button>
                ) : null}

                <span className="ml-auto text-xs tabular text-[color:var(--color-muted-foreground)]">
                  {selected.size} selected
                </span>
              </div>

              <SavedGroupSetBar
                accountId={accountId}
                selectedIds={targets.map((t) => t.groupId)}
                savedSets={savedSets}
                onLoad={(ids) => {
                  const byId = new Map((account?.groups ?? []).map((g) => [g.id, g]));
                  applyToGroups(
                    ids.map((id) => byId.get(id)).filter((g): g is WizardGroup => Boolean(g)),
                    "add",
                  );
                }}
              />
              <div className="max-h-80 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {filteredGroups.length === 0 ? (
                  <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">No groups match your search.</p>
                ) : (
                  filteredGroups.map((g) => (
                    <label
                      key={g.id}
                      className="flex cursor-pointer items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--color-neutral-bg)]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Checkbox checked={selected.has(g.id)} onChange={() => toggleManualGroup(g)} />
                        {g.isPinned ? (
                          <Pin className="size-3 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Pinned" />
                        ) : null}
                        <span className="truncate">{g.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {g.categoryName ? (
                          <span className="rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
                            {g.categoryName}
                          </span>
                        ) : null}
                        {g.isFresh ? <Badge color="green">Verified</Badge> : <Badge color="yellow">Stale sync</Badge>}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-3 flex items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-neutral-bg)]/50 px-4 py-3.5">
                <FileSpreadsheet className="size-5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                <div className="flex-1">
                  <input
                    type="file"
                    accept=".xlsx"
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleExcelFile(file);
                    }}
                    className="block w-full text-sm text-[color:var(--color-foreground)] file:mr-3 file:cursor-pointer file:rounded-[var(--radius-sm)] file:border-0 file:bg-[var(--color-surface)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[color:var(--color-foreground)] file:shadow-[var(--shadow-xs)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
                    Required column: <strong>Group Name</strong>. Optional column: <strong>Message</strong>.
                  </p>
                </div>
              </div>
              {uploading ? (
                <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">Matching against synchronized groups…</p>
              ) : null}
              {excelFileErrors.length > 0 ? (
                <div className="mb-3">
                  <Alert tone="danger">
                    <ul className="list-inside list-disc">
                      {excelFileErrors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </Alert>
                </div>
              ) : null}
              {excelResults.length > 0 ? (
                <ExcelMatchTables
                  results={excelResults}
                  ambiguousResolutions={ambiguousResolutions}
                  onResolveAmbiguous={resolveAmbiguous}
                />
              ) : null}
            </div>
          )}
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <SectionHeader title={`Review Selection (${targets.length} group(s))`} />
          {targets.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              No groups selected yet — go back and select some.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Source</Th>
                  <Th>Message</Th>
                  <Th>{null}</Th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.groupId}>
                    <Td>{t.groupName}</Td>
                    <Td>
                      <Badge color={t.source === "EXCEL" ? "blue" : "gray"}>{t.source}</Badge>
                    </Td>
                    <Td className="text-xs text-[color:var(--color-muted-foreground)]">
                      {t.message ? "Has its own message" : "Uses common message"}
                    </Td>
                    <Td>
                      <Button variant="ghost" size="sm" onClick={() => removeTarget(t.groupId)}>
                        Remove
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {unresolvedSkips.length > 0 ? (
            <div className="mt-4">
              <Alert tone="warning" title={`${unresolvedSkips.length} row(s) will NOT be sent`}>
                <ul className="list-inside list-disc">
                  {unresolvedSkips.map((s, i) => (
                    <li key={i}>
                      {s.groupName} — {s.reason}
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <SectionHeader title="Compose Message" />
          <Label>Common message (used for any group without its own Excel message)</Label>
          <Textarea
            value={commonMessage}
            onChange={(e) => setCommonMessage(e.target.value)}
            rows={5}
            maxLength={4096}
            placeholder="e.g. Server maintenance will start at 11 PM."
          />
          <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
            {commonMessage.length} / 4096 characters
          </p>
          <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
            {targets.filter((t) => t.message).length} of {targets.length} selected group(s) have their own message
            from the Excel file, which overrides the common message for that group only.
          </p>
        </Card>
      ) : null}

      {step === 5 ? (
        <PreviewStep
          accountLabel={account?.label ?? ""}
          automationEnabled={automationEnabled}
          targets={targets}
          commonMessage={commonMessage}
          unresolvedSkips={unresolvedSkips}
          maxPerJob={maxPerJob}
        />
      ) : null}
      </div>

      {error ? (
        <Alert tone="danger" title="Could not queue this job">
          {error}
        </Alert>
      ) : null}

      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
          Back
        </Button>
        {step < 5 ? (
          <Button
            disabled={
              (step === 2 && targets.length === 0) ||
              (step === 3 && targets.length === 0) ||
              (step === 4 && !commonMessage.trim())
            }
            onClick={() => setStep((s) => Math.min(5, s + 1))}
          >
            Next
          </Button>
        ) : (
          <Button disabled={targets.length === 0 || overLimit} onClick={() => setConfirmOpen(true)}>
            Confirm &amp; Queue
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        loading={confirming}
        title={`Send to ${targets.length} group(s)?`}
        description={
          automationEnabled
            ? "This queues the messages for immediate sending by the worker."
            : "Automation is paused — this will queue the job, but nothing sends until the kill switch is turned back on."
        }
        confirmLabel="Confirm & Queue"
      >
        {unresolvedSkips.length > 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            {unresolvedSkips.length} additional group(s) will be skipped (see Review step for reasons).
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function ExcelMatchTables({
  results,
  ambiguousResolutions,
  onResolveAmbiguous,
}: {
  results: GroupMatchResult[];
  ambiguousResolutions: Map<number, string>;
  onResolveAmbiguous: (result: GroupMatchResult, groupId: string) => void;
}) {
  const matched = results.filter((r) => r.status === "MATCHED");
  const ambiguous = results.filter((r) => r.status === "AMBIGUOUS");
  const unmatched = results.filter((r) => r.status === "UNMATCHED");
  const duplicate = results.filter((r) => r.status === "DUPLICATE");

  return (
    <div className="space-y-4">
      {matched.length > 0 ? (
        <div>
          <p className="mb-1.5 text-sm font-medium text-[color:var(--color-success-fg)]">
            Matched ({matched.length})
          </p>
          <Table>
            <tbody>
              {matched.map((r) => (
                <tr key={r.rowNumber}>
                  <Td>{r.groupName}</Td>
                  <Td className="text-[color:var(--color-muted-foreground)]">→ {r.matchedGroupName}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}

      {ambiguous.length > 0 ? (
        <div>
          <p className="mb-1.5 text-sm font-medium text-[color:var(--color-warning-fg)]">
            Ambiguous — pick one ({ambiguous.length})
          </p>
          <ul className="space-y-2">
            {ambiguous.map((r) => (
              <li key={r.rowNumber} className="rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3">
                <p className="mb-1.5 text-sm text-[color:var(--color-warning-fg)]">{r.groupName}</p>
                <Select
                  value={ambiguousResolutions.get(r.rowNumber) ?? ""}
                  onChange={(e) => e.target.value && onResolveAmbiguous(r, e.target.value)}
                >
                  <option value="">Select which synchronized group…</option>
                  {r.ambiguousCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.id})
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmatched.length > 0 ? (
        <div>
          <p className="mb-1.5 text-sm font-medium text-[color:var(--color-danger-fg)]">
            Unmatched — will NOT be sent ({unmatched.length})
          </p>
          <Table>
            <tbody>
              {unmatched.map((r) => (
                <tr key={r.rowNumber}>
                  <Td>{r.groupName}</Td>
                  <Td className="text-[color:var(--color-muted-foreground)]">{r.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}

      {duplicate.length > 0 ? (
        <div>
          <p className="mb-1.5 text-sm font-medium text-[color:var(--color-muted-foreground)]">
            Duplicate rows in file — will NOT be sent again ({duplicate.length})
          </p>
          <Table>
            <tbody>
              {duplicate.map((r) => (
                <tr key={r.rowNumber}>
                  <Td>{r.groupName}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function PreviewStep({
  accountLabel,
  automationEnabled,
  targets,
  commonMessage,
  unresolvedSkips,
  maxPerJob,
}: {
  accountLabel: string;
  automationEnabled: boolean;
  targets: SelectedTarget[];
  commonMessage: string;
  unresolvedSkips: Array<{ groupName: string; reason: string }>;
  maxPerJob: number;
}) {
  const overLimit = targets.length > maxPerJob;
  return (
    <Card>
      <SectionHeader title="Preview" />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Account" value={accountLabel} />
        <StatTile label="Target groups" value={targets.length} tone={overLimit ? "danger" : "neutral"} />
        <StatTile label="Skipped before queueing" value={unresolvedSkips.length} tone={unresolvedSkips.length > 0 ? "warning" : "neutral"} />
        <StatTile label="Estimated queue size" value={targets.length} />
      </div>

      {overLimit ? (
        <div className="mb-3">
          <Alert tone="danger">
            {targets.length} groups exceeds the configured maximum of {maxPerJob} per job. Remove some groups or raise
            the limit in Settings before confirming.
          </Alert>
        </div>
      ) : null}
      {!automationEnabled ? (
        <div className="mb-3">
          <Alert tone="warning">
            Automation is paused — this job will queue but nothing will send until the kill switch is turned back on.
          </Alert>
        </div>
      ) : null}

      <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Common message</p>
      <p className="mb-4 whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/40 p-3 text-sm text-[color:var(--color-foreground)]">
        {commonMessage}
      </p>

      <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Final recipient list</p>
      <div className="max-h-64 overflow-y-auto">
        <Table>
          <tbody>
            {targets.map((t) => (
              <tr key={t.groupId}>
                <Td className="font-medium">{t.groupName}</Td>
                <Td className="text-xs text-[color:var(--color-muted-foreground)]">{t.message ?? commonMessage}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
