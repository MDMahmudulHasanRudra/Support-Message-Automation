"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";
import { createGroupBroadcastJob, previewExcelUpload } from "@/server/actions/groupBroadcast";
import type { GroupMatchResult } from "@support-automation/shared";

export interface WizardGroup {
  id: string;
  name: string;
  isMonitored: boolean;
  /** Computed server-side at page-load time — whether the last group sync is recent enough to trust as a membership signal. */
  isFresh: boolean;
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

const STEP_LABELS = ["Account & Groups", "Review Selection", "Compose Message", "Preview & Confirm"];

export function GroupMessageSenderWizard({
  accounts,
  maxPerJob,
  automationEnabled,
}: {
  accounts: WizardAccount[];
  maxPerJob: number;
  automationEnabled: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mode, setMode] = useState<"MANUAL" | "EXCEL">("MANUAL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, SelectedTarget>>(new Map());
  const [excelResults, setExcelResults] = useState<GroupMatchResult[]>([]);
  const [excelFileErrors, setExcelFileErrors] = useState<string[]>([]);
  const [ambiguousResolutions, setAmbiguousResolutions] = useState<Map<number, string>>(new Map());
  const [commonMessage, setCommonMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;

  const filteredGroups = useMemo(() => {
    const groups = account?.groups ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [account, search]);

  const targets = useMemo(() => [...selected.values()], [selected]);

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

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of filteredGroups) {
        if (!next.has(g.id)) next.set(g.id, { groupId: g.id, groupName: g.name, message: null, source: "MANUAL" });
      }
      return next;
    });
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
        return;
      }
      router.push(`/group-message-sender/jobs/${result.jobId}`);
    } catch {
      setError("Failed to create the job. Please try again.");
      setConfirming(false);
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
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No connected WhatsApp account is available. Connect an account on the Accounts page first.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!automationEnabled ? (
        <Card className="border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            Automation is currently PAUSED (kill switch). You can prepare a job, but nothing will be sent until it is
            resumed on the Automation Control page.
          </p>
        </Card>
      ) : null}

      <StepIndicator step={step} />

      {step === 1 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">WhatsApp Account</h2>
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setSelected(new Map());
              setExcelResults([]);
            }}
            className={inputClass}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.status}) — {a.groups.length} synchronized group(s)
              </option>
            ))}
          </select>

          <h2 className="mb-3 mt-6 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Choose Groups</h2>
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
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input
                  placeholder="Search groups by name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`${inputClass} max-w-sm`}
                />
                <Button variant="secondary" onClick={selectAllFiltered}>
                  Select all filtered ({filteredGroups.length})
                </Button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{selected.size} selected</span>
              </div>
              <div className="max-h-80 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                {filteredGroups.length === 0 ? (
                  <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">No groups match your search.</p>
                ) : (
                  filteredGroups.map((g) => (
                    <label
                      key={g.id}
                      className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
                    >
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggleManualGroup(g)} />
                        {g.name}
                      </span>
                      {g.isFresh ? <Badge color="green">Verified</Badge> : <Badge color="yellow">Stale sync</Badge>}
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div>
              <input
                type="file"
                accept=".xlsx"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleExcelFile(file);
                }}
                className="mb-3 block text-sm"
              />
              <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                Required column: <strong>Group Name</strong>. Optional column: <strong>Message</strong>.
              </p>
              {uploading ? <p className="text-sm text-zinc-500 dark:text-zinc-400">Matching against synchronized groups…</p> : null}
              {excelFileErrors.length > 0 ? (
                <ul className="mb-3 list-inside list-disc text-sm text-red-600">
                  {excelFileErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              ) : null}
              {excelResults.length > 0 ? <ExcelMatchTables results={excelResults} ambiguousResolutions={ambiguousResolutions} onResolveAmbiguous={resolveAmbiguous} /> : null}
            </div>
          )}
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Review Selection ({targets.length} group(s))</h2>
          {targets.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No groups selected yet — go back and select some.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {targets.map((t) => (
                <li key={t.groupId} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    {t.groupName} <Badge color={t.source === "EXCEL" ? "blue" : "gray"}>{t.source}</Badge>
                    {t.message ? <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">(has its own message)</span> : null}
                  </span>
                  <Button variant="secondary" onClick={() => removeTarget(t.groupId)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {unresolvedSkips.length > 0 ? (
            <div className="mt-4 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm dark:border-yellow-900 dark:bg-yellow-950">
              <p className="mb-1 font-medium text-yellow-800 dark:text-yellow-300">{unresolvedSkips.length} row(s) will NOT be sent:</p>
              <ul className="list-inside list-disc text-yellow-700 dark:text-yellow-400">
                {unresolvedSkips.map((s, i) => (
                  <li key={i}>
                    {s.groupName} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Compose Message</h2>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Common message (used for any group without its own Excel message)
          </label>
          <textarea
            value={commonMessage}
            onChange={(e) => setCommonMessage(e.target.value)}
            rows={5}
            maxLength={4096}
            className={inputClass}
            placeholder="e.g. Server maintenance will start at 11 PM."
          />
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{commonMessage.length} / 4096 characters</p>
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            {targets.filter((t) => t.message).length} of {targets.length} selected group(s) have their own message from
            the Excel file, which overrides the common message for that group only.
          </p>
        </Card>
      ) : null}

      {step === 4 ? (
        <ConfirmStep
          accountLabel={account?.label ?? ""}
          automationEnabled={automationEnabled}
          targets={targets}
          commonMessage={commonMessage}
          unresolvedSkips={unresolvedSkips}
          maxPerJob={maxPerJob}
        />
      ) : null}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
          Back
        </Button>
        {step < 4 ? (
          <Button
            disabled={
              (step === 1 && targets.length === 0) ||
              (step === 2 && targets.length === 0) ||
              (step === 3 && !commonMessage.trim())
            }
            onClick={() => setStep((s) => Math.min(4, s + 1))}
          >
            Next
          </Button>
        ) : (
          <Button disabled={confirming || targets.length === 0} onClick={handleConfirm}>
            {confirming ? "Queueing…" : "Confirm & Queue"}
          </Button>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex gap-2 text-xs">
      {STEP_LABELS.map((label, i) => (
        <div
          key={label}
          className={`rounded-full px-3 py-1 ${
            i + 1 === step
              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          {i + 1}. {label}
        </div>
      ))}
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
          <p className="mb-1 text-sm font-medium text-green-700 dark:text-green-400">Matched ({matched.length})</p>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
            {matched.map((r) => (
              <li key={r.rowNumber} className="border-b border-zinc-100 px-3 py-1.5 last:border-0 dark:border-zinc-900">
                {r.groupName} → {r.matchedGroupName}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ambiguous.length > 0 ? (
        <div>
          <p className="mb-1 text-sm font-medium text-yellow-700 dark:text-yellow-400">Ambiguous — pick one ({ambiguous.length})</p>
          <ul className="space-y-2">
            {ambiguous.map((r) => (
              <li key={r.rowNumber} className="rounded-md border border-yellow-300 p-2 text-sm dark:border-yellow-900">
                <p className="mb-1">{r.groupName}</p>
                <select
                  className={inputClass}
                  value={ambiguousResolutions.get(r.rowNumber) ?? ""}
                  onChange={(e) => e.target.value && onResolveAmbiguous(r, e.target.value)}
                >
                  <option value="">Select which synchronized group…</option>
                  {r.ambiguousCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.id})
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmatched.length > 0 ? (
        <div>
          <p className="mb-1 text-sm font-medium text-red-700 dark:text-red-400">Unmatched — will NOT be sent ({unmatched.length})</p>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
            {unmatched.map((r) => (
              <li key={r.rowNumber} className="border-b border-zinc-100 px-3 py-1.5 last:border-0 dark:border-zinc-900">
                {r.groupName} — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {duplicate.length > 0 ? (
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-500">Duplicate rows in file — will NOT be sent again ({duplicate.length})</p>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
            {duplicate.map((r) => (
              <li key={r.rowNumber} className="border-b border-zinc-100 px-3 py-1.5 last:border-0 dark:border-zinc-900">
                {r.groupName}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ConfirmStep({
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
      <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Preview &amp; Confirm</h2>
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Account</dt>
          <dd>{accountLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Target groups</dt>
          <dd>{targets.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Skipped before queueing</dt>
          <dd>{unresolvedSkips.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Estimated queue size</dt>
          <dd>{targets.length}</dd>
        </div>
      </dl>

      {overLimit ? (
        <p className="mb-3 text-sm text-red-600">
          {targets.length} groups exceeds the configured maximum of {maxPerJob} per job. Remove some groups or raise the
          limit in Settings before confirming.
        </p>
      ) : null}
      {!automationEnabled ? (
        <p className="mb-3 text-sm text-red-600">
          Automation is paused — this job will queue but nothing will send until the kill switch is turned back on.
        </p>
      ) : null}

      <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Common message</p>
      <p className="mb-4 whitespace-pre-wrap rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">{commonMessage}</p>

      <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Final recipient list</p>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
        {targets.map((t) => (
          <li key={t.groupId} className="border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-900">
            <span className="font-medium">{t.groupName}</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t.message ?? commonMessage}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const inputClass = "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
