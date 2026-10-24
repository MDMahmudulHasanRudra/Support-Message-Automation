"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Sparkles, SlidersHorizontal, UploadCloud, X } from "lucide-react";
import { useProjectHref, useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button } from "@/components/ui";

/**
 * Smart Bulk Import, step 1 (SMART_IMPORT.md): choose a file and how much to see. The upload's bytes
 * are real progress; reading the file afterwards has no measurable percentage, so it says so instead
 * of inventing one. Nothing is imported here.
 */

type Mode = "quick" | "advanced";
type Phase = { kind: "idle" } | { kind: "uploading"; sent: number; total: number } | { kind: "reading" } | { kind: "error"; message: string };

const MODES: Array<{ key: Mode; title: string; text: string; icon: typeof Sparkles }> = [
  { key: "quick", title: "Quick import", text: "Columns we recognise are matched for you. Go straight to the check.", icon: Sparkles },
  { key: "advanced", title: "Advanced", text: "Choose every field yourself: columns, fixed values, samples, fallbacks.", icon: SlidersHorizontal },
];

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SmartUpload({ maxMb, maxRows }: { maxMb: number; maxRows: number }) {
  const toProject = useProjectHref();
  const router = useProjectRouter();
  const input = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const [mode, setMode] = useState<Mode>("quick");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "uploading" || phase.kind === "reading";

  function choose(f: File | null | undefined) {
    if (!f || busy) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) {
      setPhase({ kind: "error", message: "Choose an Excel (.xlsx) or CSV (.csv) file." });
      return;
    }
    if (f.size > maxMb * 1024 * 1024) {
      setPhase({ kind: "error", message: `That file is ${formatSize(f.size)}. The limit is ${maxMb} MB; split it into smaller files.` });
      return;
    }
    setFile(f);
    setPhase({ kind: "idle" });
  }

  function start() {
    if (!file) return;
    const form = new FormData();
    form.set("file", file, file.name);
    const request = new XMLHttpRequest();
    xhr.current = request;
    request.open("POST", toProject("/api/clients/import/smart-upload"));
    request.responseType = "json";
    request.upload.onprogress = (e) => {
      if (e.lengthComputable) setPhase(e.loaded >= e.total ? { kind: "reading" } : { kind: "uploading", sent: e.loaded, total: e.total });
    };
    request.upload.onload = () => setPhase({ kind: "reading" });
    request.onload = () => {
      xhr.current = null;
      const body = request.response as { ok?: boolean; jobId?: string; error?: string } | null;
      if (request.status >= 200 && request.status < 300 && body?.ok && body.jobId) {
        router.push(`/clients/import/${body.jobId}?step=${mode === "quick" ? "review" : "map"}`);
        return;
      }
      setPhase({ kind: "error", message: body?.error ?? `The file could not be uploaded (${request.status}). Nothing was imported.` });
    };
    request.onerror = () => {
      xhr.current = null;
      setPhase({ kind: "error", message: "The connection dropped during the upload. Nothing was imported — try again." });
    };
    request.onabort = () => {
      xhr.current = null;
      setPhase({ kind: "idle" });
    };
    setPhase({ kind: "uploading", sent: 0, total: file.size });
    request.send(form);
  }

  const percent = phase.kind === "uploading" && phase.total ? Math.round((phase.sent / phase.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="How much to see" className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => {
          const active = mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => setMode(m.key)}
              className={`flex items-start gap-3 rounded-[var(--radius-lg)] border p-3.5 text-left transition-[border-color,background-color,box-shadow] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.06] shadow-[var(--shadow-xs)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${active ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
                <m.icon className="size-4" aria-hidden />
              </span>
              <span>
                <span className="block text-[13.5px] font-semibold">{m.title}</span>
                <span className="block text-[12px] leading-snug text-[color:var(--color-muted-foreground)]">{m.text}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0]);
        }}
        className={`relative flex min-h-48 flex-col items-center justify-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed px-6 py-8 text-center transition-colors duration-[var(--duration-fast)] ${
          dragging ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.05]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)]"
        }`}
      >
        {file ? (
          <FileSpreadsheet className="size-10 text-[color:var(--color-success)]" aria-hidden />
        ) : (
          <span className="flex size-14 items-center justify-center rounded-full bg-[var(--color-accent)]/10">
            <UploadCloud className="size-7 text-[color:var(--color-accent)]" aria-hidden />
          </span>
        )}
        {file ? (
          <>
            <p className="max-w-full truncate text-[15px] font-semibold" title={file.name}>
              {file.name}
            </p>
            <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">{formatSize(file.size)}</p>
          </>
        ) : (
          <>
            <p className="text-[15px] font-semibold">Drop your Excel or CSV file here</p>
            <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
              Any layout — your own column names are fine. Up to {maxMb} MB and {maxRows.toLocaleString()} clients.
            </p>
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant={file ? "secondary" : "primary"} onClick={() => input.current?.click()} disabled={busy}>
            {file ? "Choose another file" : "Choose a file"}
          </Button>
          {file && !busy ? (
            <Button type="button" onClick={start}>
              Upload and continue
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            choose(e.currentTarget.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {phase.kind === "uploading" ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3.5" aria-live="polite">
          <div className="mb-2 flex items-center justify-between text-[12.5px]">
            <span>
              Uploading… {formatSize(phase.sent)} of {formatSize(phase.total)}
            </span>
            <button type="button" onClick={() => xhr.current?.abort()} className="inline-flex items-center gap-1 font-medium text-[color:var(--color-danger-fg)] hover:underline">
              <X className="size-3.5" aria-hidden />
              Cancel upload
            </button>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Upload progress">
            <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
      {phase.kind === "reading" ? (
        <p className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3.5 text-[13px]" aria-live="polite">
          <Loader2 className="size-4 animate-spin text-[color:var(--color-accent)]" aria-hidden />
          Reading your file and checking every row… this takes a few seconds for a large file.
        </p>
      ) : null}
      {phase.kind === "error" ? <Alert tone="danger">{phase.message}</Alert> : null}
    </div>
  );
}
