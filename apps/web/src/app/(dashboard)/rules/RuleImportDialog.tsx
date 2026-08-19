"use client";

import { useRef, useState } from "react";
import { Badge, Button, Dialog, Table, Td, Th } from "@/components/ui";
import {
  confirmRuleImport,
  previewRuleImport,
  type RuleImportPreviewRow,
  type RuleImportResult,
} from "@/server/actions/rulesBulk";

type Step = "upload" | "preview" | "result";

const OUTCOME_BADGE: Record<RuleImportPreviewRow["outcome"], { color: "green" | "yellow" | "red"; label: string }> = {
  VALID: { color: "green", label: "Valid" },
  DUPLICATE_EXISTING: { color: "yellow", label: "Duplicate (existing)" },
  DUPLICATE_IN_FILE: { color: "yellow", label: "Duplicate (in file)" },
  INVALID: { color: "red", label: "Error" },
};

export function RuleImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<RuleImportPreviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RuleImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validRows = previewRows.filter((r) => r.outcome === "VALID" && r.row);
  const validCount = validRows.length;
  const skippedCount = previewRows.length - validCount;

  async function handlePreview() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setFileErrors(["Choose a .xlsx file first."]);
      return;
    }
    setBusy(true);
    setFileErrors([]);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const preview = await previewRuleImport(formData);
      if (preview.fileErrors.length > 0) {
        setFileErrors(preview.fileErrors);
        return;
      }
      setPreviewRows(preview.rows);
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (validCount === 0) return;
    setBusy(true);
    try {
      const rows = validRows.map((r) => ({ rowNumber: r.rowNumber, row: r.row! }));
      const importResult = await confirmRuleImport(rows);
      setResult(importResult);
      setStep("result");
      onImported();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Import Automation Rules from Excel"
      description={
        step === "upload"
          ? "Upload a .xlsx file matching the Download Template format."
          : step === "preview"
            ? "Review every row before anything is created — nothing is saved yet."
            : "Import complete."
      }
      footer={
        step === "upload" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handlePreview} loading={busy}>
              Preview
            </Button>
          </>
        ) : step === "preview" ? (
          <>
            <Button variant="secondary" onClick={() => setStep("upload")} disabled={busy}>
              Back
            </Button>
            <Button onClick={handleConfirm} loading={busy} disabled={validCount === 0}>
              Import {validCount} Valid Rule{validCount === 1 ? "" : "s"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )
      }
    >
      {step === "upload" ? (
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="block w-full text-sm text-[color:var(--color-foreground)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--color-neutral-bg)] file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-[var(--color-border)]"
          />
          {fileErrors.length > 0 ? (
            <ul className="space-y-1 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[color:var(--color-danger-fg)]">
              {fileErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Every imported rule is created as <strong>DRAFT</strong> regardless of anything in the
            file — review and Activate them (individually or via Bulk Activate) once you're happy
            with them.
          </p>
        </div>
      ) : step === "preview" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge color="green">{validCount} valid</Badge>
            <Badge color="yellow">{skippedCount} will be skipped</Badge>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Pattern</Th>
                <Th>Actions</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row) => (
                <tr key={row.rowNumber}>
                  <Td>{row.rowNumber}</Td>
                  <Td>{row.name || "—"}</Td>
                  <Td>{row.type || "—"}</Td>
                  <Td>{row.matchValue ?? "—"}</Td>
                  <Td>{row.actionsSummary}</Td>
                  <Td>
                    <Badge color={OUTCOME_BADGE[row.outcome].color} dot>
                      {OUTCOME_BADGE[row.outcome].label}
                    </Badge>
                    {row.outcome !== "VALID" ? (
                      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{row.reason}</p>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : result ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge color="green">{result.created} created</Badge>
            <Badge color="yellow">{result.skipped} skipped</Badge>
            {result.failed > 0 ? <Badge color="red">{result.failed} failed</Badge> : null}
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Name</Th>
                <Th>Result</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {result.details.map((d) => (
                <tr key={d.rowNumber}>
                  <Td>{d.rowNumber}</Td>
                  <Td>{d.name}</Td>
                  <Td>
                    <Badge color={d.outcome === "CREATED" ? "green" : d.outcome === "SKIPPED" ? "yellow" : "red"} dot>
                      {d.outcome}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-[color:var(--color-muted-foreground)]">{d.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </Dialog>
  );
}
