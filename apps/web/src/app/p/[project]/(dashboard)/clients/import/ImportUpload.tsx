"use client";

import { useActionState, useEffect, useState } from "react";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button } from "@/components/ui";
import { previewClientImport, type ClientImportFormState } from "@/server/actions/clientImport";

/** Step 3: choose a file. Nothing is imported — the next page is a preview with column mapping. */
export function ImportUpload({ maxMb, maxRows }: { maxMb: number; maxRows: number }) {
  const [state, formAction, pending] = useActionState<ClientImportFormState, FormData>(previewClientImport, {});
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (state.jobId) router.push(`/clients/import/${state.jobId}`);
  }, [state, router]);
  return (
    <form action={formAction} className="flex flex-1 flex-col gap-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <label
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDrop={() => setDragging(false)}
        className={`relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-[var(--color-accent)] bg-[var(--color-neutral-bg)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)]"
        }`}
      >
        {file ? <FileSpreadsheet className="size-7 text-[color:var(--color-success)]" aria-hidden /> : <UploadCloud className="size-7 text-[color:var(--color-muted-foreground)]" aria-hidden />}
        <span className="text-sm font-medium">{file ? file.name : "Drop your file here, or click to choose"}</span>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">
          {file ? `${(file.size / 1024).toFixed(0)} KB — ready to preview` : `.xlsx or .csv, up to ${maxMb} MB and ${maxRows.toLocaleString()} rows`}
        </span>
        <input
          type="file"
          name="file"
          accept=".csv,.xlsx"
          required
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            setFile(f ? { name: f.name, size: f.size } : null);
          }}
        />
      </label>
      <Button type="submit" loading={pending} disabled={!file}>
        Upload and preview
      </Button>
    </form>
  );
}
