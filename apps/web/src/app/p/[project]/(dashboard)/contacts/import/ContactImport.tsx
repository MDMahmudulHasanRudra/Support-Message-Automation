"use client";

import { useRef, useState, useTransition } from "react";
import { FileUp, Users } from "lucide-react";
import { CONTACT_IMPORT_FIELD_LABEL, CONTACT_IMPORT_FIELDS, MAX_CONTACT_IMPORT_ROWS, type ContactImportField } from "@support-automation/shared";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { importFromClientList, previewContactImport, runContactImport, type ContactImportPreview } from "@/server/actions/contacts";
import type { ContactImportResult } from "@/server/contacts";

function ResultCard({ result }: { result: ContactImportResult }) {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <Card className="p-4">
      <h2 className="text-[14px] font-semibold">Import finished</h2>
      <dl className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["New contacts", result.created],
          ["Updated", result.updated],
          ["Already complete", result.unchanged],
          ["Rows left out", result.skipped],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2">
            <dd className="tabular text-[20px] font-semibold">{n(value as number)}</dd>
            <dt className="text-[12.5px] text-[color:var(--color-muted-foreground)]">{label}</dt>
          </div>
        ))}
      </dl>
      {result.problems.length ? (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer font-medium">{n(result.problems.length)} values could not be read</summary>
          <ul className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto text-[12.5px] text-[color:var(--color-muted-foreground)]">
            {result.problems.map((p, i) => (
              <li key={i}>
                Row {p.line}: {p.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <Link href="/contacts" className="link mt-3 inline-block text-[13px] font-medium">
        Open Contacts
      </Link>
    </Card>
  );
}

export function ContactImport({ canUseClients }: { canUseClients: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ContactImportPreview | null>(null);
  const [mapping, setMapping] = useState<Array<ContactImportField | "">>([]);
  const [tag, setTag] = useState("");
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const withFile = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return null;
    const form = new FormData();
    form.set("file", file);
    return form;
  };

  const read = () => {
    const form = withFile();
    if (!form) return;
    setResult(null);
    start(async () => {
      const r = await previewContactImport(form);
      if ("error" in r) {
        setError(r.error);
        setPreview(null);
        return;
      }
      setError(null);
      setPreview(r);
      setMapping(r.mapping);
    });
  };

  const run = () => {
    const form = withFile();
    if (!form) return;
    form.set("mapping", JSON.stringify(mapping));
    form.set("tag", tag);
    start(async () => {
      const r = await runContactImport(form);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setResult(r);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  const fromClients = () =>
    start(async () => {
      const r = await importFromClientList();
      if ("error" in r) setError(r.error);
      else {
        setError(null);
        setResult(r);
      }
    });

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? <ResultCard result={result} /> : null}

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
            <FileUp className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-semibold">From a file</h2>
            <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">Excel or CSV, up to {MAX_CONTACT_IMPORT_ROWS.toLocaleString("en-US")} rows. The first row names the columns; several numbers in one cell are fine.</p>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={read} aria-label="Choose a file" className="mt-3 block w-full text-[13px] file:mr-3 file:rounded-[var(--radius-md)] file:border-0 file:bg-[var(--color-neutral-bg)] file:px-3 file:py-2 file:text-[13px] file:font-medium" />
          </div>
        </div>

        {preview ? (
          <div className="mt-5 border-t border-[var(--color-border)] pt-4">
            <p className="text-[13.5px] font-semibold">
              <span className="tabular">{preview.rows.toLocaleString("en-US")}</span> rows found. What is in each column?
            </p>
            {preview.truncated ? <p className="mt-1 text-[12.5px] text-[color:var(--color-warning-fg)]">Only the first {MAX_CONTACT_IMPORT_ROWS.toLocaleString("en-US")} rows will be read.</p> : null}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-[13px]">
                <thead>
                  <tr className="text-left">
                    <th className="py-1.5 pr-3 font-medium text-[color:var(--color-muted-foreground)]">In your file</th>
                    <th className="py-1.5 pr-3 font-medium text-[color:var(--color-muted-foreground)]">Save as</th>
                    <th className="py-1.5 font-medium text-[color:var(--color-muted-foreground)]">Example</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {preview.headers.map((header, i) => (
                    <tr key={i}>
                      <td className="max-w-40 truncate py-1.5 pr-3 font-medium">{header}</td>
                      <td className="py-1.5 pr-3">
                        <Select aria-label={`Save ${header} as`} value={mapping[i] ?? ""} onChange={(e) => setMapping((m) => m.map((v, n) => (n === i ? (e.target.value as ContactImportField | "") : v)))}>
                          <option value="">Do not import</option>
                          {CONTACT_IMPORT_FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {CONTACT_IMPORT_FIELD_LABEL[f]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="max-w-56 truncate py-1.5 text-[color:var(--color-muted-foreground)]">{preview.sample.map((r) => r[i]).find(Boolean) ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <Field label="Tag everyone in this file (optional)">
                <Input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} placeholder="For example: Fair 2026" />
              </Field>
              <Button onClick={run} disabled={pending || !mapping.some(Boolean)}>
                {pending ? "Importing…" : `Import ${preview.rows.toLocaleString("en-US")} rows`}
              </Button>
            </div>
          </div>
        ) : pending ? (
          <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">Reading the file…</p>
        ) : null}
      </Card>

      {canUseClients ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
              <Users className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[14.5px] font-semibold">From your client list</h2>
              <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">Copies names, numbers and emails here. Your clients, dues and subscriptions are only read, never changed. Safe to run again.</p>
            </div>
            <Button variant="secondary" onClick={fromClients} disabled={pending}>
              {pending ? "Working…" : "Copy client list"}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
