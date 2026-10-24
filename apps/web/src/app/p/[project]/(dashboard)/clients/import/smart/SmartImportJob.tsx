"use client";

import { useCallback, useState } from "react";
import { FileSpreadsheet, Layers, Trash2 } from "lucide-react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Dialog, Field, Input, Select, StepIndicator } from "@/components/ui";
import { chooseSmartSheet, discardSmartDraft, type SmartStatus } from "@/server/actions/smartImport";
import { MappingEditor } from "./MappingEditor";
import { ReviewGrid } from "./ReviewGrid";
import { ImportProgress } from "./ImportProgress";

/**
 * Smart Bulk Import's wizard for one file (SMART_IMPORT.md): match columns → check rows → import.
 * Which step shows is the job's own state on the server; the step a person is on while still editing
 * is kept in the URL (?step=), so a reload or a shared link opens the same place.
 */

type Step = "map" | "review" | "import";

export interface SmartJobInfo {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  sheetName: string | null;
  sheetNames: string[];
  headerRow: number;
  totalRows: number;
  canChooseSheet: boolean;
  rowsKept: boolean;
}

export function SmartImportJob({ job, initialStep, initialStatus }: { job: SmartJobInfo; initialStep: "map" | "review"; initialStatus: SmartStatus | null }) {
  const router = useProjectRouter();
  const editing = job.status === "PREVIEW";
  const [step, setStepState] = useState<Step>(editing ? initialStep : "import");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Confirmed on this screen: the page's own reading predates it, so the progress view starts by asking.
  const [queuedHere, setQueuedHere] = useState(false);

  const refreshPage = useCallback(() => router.refresh(), [router]);

  const setStep = (next: Step) => {
    setStepState(next);
    if (next !== "import") window.history.replaceState(null, "", `?step=${next}`);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const stepNumber = step === "map" ? 2 : step === "review" ? 3 : 4;
  const size = job.fileSize < 1024 * 1024 ? `${Math.max(1, Math.round(job.fileSize / 1024))} KB` : `${(job.fileSize / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="space-y-5">
      <StepIndicator steps={["Upload", "Match columns", "Check rows", "Import"]} currentStep={stepNumber} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileSpreadsheet className="size-8 shrink-0 text-[color:var(--color-success)]" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold" title={job.fileName}>
              {job.fileName}
            </p>
            <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
              {size} · {job.totalRows.toLocaleString()} rows{job.sheetName ? ` · sheet "${job.sheetName}"` : ""} · headers on row {job.headerRow}
            </p>
          </div>
        </div>
        {editing ? (
          <div className="flex flex-wrap gap-2">
            {job.canChooseSheet ? (
              <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
                <Layers className="size-3.5" aria-hidden />
                {job.sheetNames.length > 1 ? "Change sheet or header row" : "Change header row"}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setDiscardOpen(true)}>
              <Trash2 className="size-3.5" aria-hidden />
              Discard
            </Button>
          </div>
        ) : null}
      </div>
      {note ? <Alert tone="info">{note}</Alert> : null}

      {step === "map" ? <MappingEditor jobId={job.id} onSaved={() => setStep("review")} /> : null}
      {step === "review" ? <ReviewGrid jobId={job.id} onBackToMapping={() => setStep("map")} onQueued={() => (setQueuedHere(true), setStep("import"), router.refresh())} /> : null}
      {step === "import" ? (
        <ImportProgress
          jobId={job.id}
          key={queuedHere ? "queued" : "page"}
          initial={queuedHere ? null : initialStatus}
          rowsKept={job.rowsKept}
          onFinished={refreshPage}
          onBackToReview={() => {
            setStep("review");
            router.refresh();
          }}
        />
      ) : null}

      {sheetOpen ? (
        <SheetDialog
          job={job}
          onClose={() => setSheetOpen(false)}
          onDone={(message) => {
            setSheetOpen(false);
            setNote(message);
            setStep("map");
            router.refresh();
          }}
        />
      ) : null}
      {discardOpen ? (
        <Dialog
          open
          onClose={() => setDiscardOpen(false)}
          title="Discard this import?"
          description="The uploaded rows and every correction you made here are deleted. No client is created, changed or deleted."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDiscardOpen(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const r = await discardSmartDraft(job.id);
                  if (r.ok) router.push("/clients/import");
                  else setNote(r.message);
                  setDiscardOpen(false);
                }}
              >
                Discard
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function SheetDialog({ job, onClose, onDone }: { job: SmartJobInfo; onClose: () => void; onDone: (message: string) => void }) {
  const [sheet, setSheet] = useState(job.sheetName ?? job.sheetNames[0] ?? "");
  const [headerRow, setHeaderRow] = useState(String(job.headerRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Read another sheet or header row"
      description="The file is read again. Fields still pointing at existing columns keep their mapping; corrections made on the check screen are cleared."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              // A different sheet finds its own header row unless the person changed the number.
              const row = sheet !== job.sheetName && headerRow === String(job.headerRow) ? 0 : Number(headerRow);
              const r = await chooseSmartSheet(job.id, sheet, row);
              setBusy(false);
              if (r.ok) onDone(r.message);
              else setError(r.message);
            }}
          >
            Read again
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {job.sheetNames.length > 1 ? (
          <Field label="Sheet" htmlFor="smart-sheet">
            <Select id="smart-sheet" value={sheet} onChange={(e) => setSheet(e.target.value)} className="w-full">
              {job.sheetNames.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Headers are on row" htmlFor="smart-header" hint="The row holding the column names. Rows above it (a title, a logo) are not read.">
          <Input id="smart-header" type="number" min={1} max={20} value={headerRow} onChange={(e) => setHeaderRow(e.target.value)} className="w-28" />
        </Field>
      </div>
    </Dialog>
  );
}
