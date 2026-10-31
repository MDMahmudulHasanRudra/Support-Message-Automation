"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Download, Eye, Hash, ShieldAlert } from "lucide-react";
import { canonicalPrefix, CLIENT_CODE_MAX_WIDTH, CLIENT_CODE_PREFIX_MAX, parseSerial, previewClientCodes, type CodePlanOptions } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, SectionHeader, Table, Td, Th, useToast } from "@/components/ui";
import {
  applyClientCodeConversion,
  exportClientCodeConversion,
  previewClientCodeConversion,
  saveClientCodeSeries,
  type CodeSeriesFormState,
  type ConversionPreviewResult,
} from "@/server/actions/projectClientCodes";

interface Live {
  prefix: string;
  isPrimary: boolean;
  minWidth: number;
  nextSerial: string;
  version: number;
  lastIssued: string | null;
}

const CATEGORY_LABEL = { LEGACY_PATTERN: "Old generated form", CUSTOM: "Custom", IN_SERIES: "Already in this format" } as const;

export function ClientCodesPanel({
  projectId,
  projectName,
  canManage,
  applyEnabled,
  live,
  history,
  reserved,
  counts,
}: {
  projectId: string;
  projectName: string;
  canManage: boolean;
  applyEnabled: boolean;
  live: Live | null;
  history: Array<{ version: number; prefix: string; minWidth: number; nextSerial: string; createdAt: string; retiredAt: string | null }>;
  reserved: Array<{ prefix: string; projectName: string; retired: boolean }>;
  counts: { clients: number; legacy: number; aliases: number };
}) {
  return (
    <div className="space-y-8">
      {/* Keyed by the stored series, so a save or a conversion elsewhere never leaves the form showing old numbers. */}
      <SeriesCard
        key={live ? `${live.version}:${live.prefix}:${live.minWidth}:${live.nextSerial}` : "none"}
        projectId={projectId}
        canManage={canManage}
        live={live}
        reserved={reserved}
        counts={counts}
      />
      {history.length > 1 ? (
        <div>
          <SectionHeader title="History" description="Every series this project has had. Earlier prefixes stay reserved for it, and codes issued under them are never reissued." />
          <Table>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Prefix</Th>
                <Th>Digits</Th>
                <Th>Next number</Th>
                <Th>From</Th>
                <Th>Until</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.version}>
                  <Td className="tabular">v{h.version}</Td>
                  <Td className="font-mono">{h.prefix || "(numbers only)"}</Td>
                  <Td className="tabular">{h.minWidth}</Td>
                  <Td className="tabular">{h.nextSerial}</Td>
                  <Td>{new Date(h.createdAt).toLocaleDateString()}</Td>
                  <Td>{h.retiredAt ? new Date(h.retiredAt).toLocaleDateString() : <Badge color="green">Current</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      <ConversionCard projectId={projectId} projectName={projectName} canManage={canManage} applyEnabled={applyEnabled} counts={counts} live={live} />
    </div>
  );
}

function SeriesCard({
  projectId,
  canManage,
  live,
  reserved,
  counts,
}: {
  projectId: string;
  canManage: boolean;
  live: Live | null;
  reserved: Array<{ prefix: string; projectName: string; retired: boolean }>;
  counts: { clients: number; legacy: number; aliases: number };
}) {
  const [state, action, pending] = useActionState<CodeSeriesFormState, FormData>(saveClientCodeSeries.bind(null, projectId), {});
  const [prefix, setPrefix] = useState(live?.prefix ?? "");
  const [width, setWidth] = useState(String(live?.minWidth ?? 4));
  const [next, setNext] = useState(live?.nextSerial ?? "1");
  if (!live) return <Alert tone="warning">This project has no client code series yet. One is created when its first client is added.</Alert>;

  const changingPrefix = canonicalPrefix(prefix) !== live.prefix;
  const start = changingPrefix ? (parseSerial(next === live.nextSerial ? "1" : next) ?? null) : parseSerial(next);
  const w = Number(width);
  const preview = start && Number.isInteger(w) && w >= 1 && w <= CLIENT_CODE_MAX_WIDTH ? previewClientCodes(canonicalPrefix(prefix), start, w) : null;

  return (
    <Card>
      <SectionHeader
        title="Code series"
        action={
          <span className="flex items-center gap-1.5">
            <Hash className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
            {live.isPrimary ? <Badge color="blue">Primary project · numbers only</Badge> : <Badge color="gray">Prefix {live.prefix}</Badge>}
          </span>
        }
        description={`Last code issued: ${live.lastIssued ?? "none yet"} · ${counts.clients} client(s) · ${counts.aliases} former code(s) kept as aliases. Saving changes only codes given from now on.`}
      />
      <form action={action} className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Field
            label="Prefix"
            htmlFor="series-prefix"
            error={state.field === "prefix" ? state.error : undefined}
            hint={live.isPrimary ? "The primary project is numbers only." : `Letters A–Z, up to ${CLIENT_CODE_PREFIX_MAX}. A new prefix starts a new series from 1; the old one stays reserved.`}
          >
            <Input
              id="series-prefix"
              name="prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, CLIENT_CODE_PREFIX_MAX))}
              disabled={live.isPrimary || !canManage}
              className="w-36 font-mono uppercase"
              autoComplete="off"
            />
          </Field>
          <Field label="Minimum digits" htmlFor="series-width" error={state.field === "minWidth" ? state.error : undefined} hint="Can only grow.">
            <Input id="series-width" name="minWidth" type="number" min={live.minWidth} max={CLIENT_CODE_MAX_WIDTH} value={width} onChange={(e) => setWidth(e.target.value)} disabled={!canManage} className="w-24 tabular" />
          </Field>
          <Field label={changingPrefix ? "First number of the new series" : "Next number"} htmlFor="series-next" error={state.field === "nextSerial" ? state.error : undefined} hint={changingPrefix ? "Usually 1." : "Can only move forward; never reissued."}>
            <Input id="series-next" name="nextSerial" inputMode="numeric" value={changingPrefix && next === live.nextSerial ? "1" : next} onChange={(e) => setNext(e.target.value.replace(/[^0-9]/g, ""))} disabled={!canManage} className="w-40 tabular" />
          </Field>
        </div>
        <p className="text-[12.5px]" aria-live="polite">
          {preview ? (
            <>
              Next clients: <span className="font-mono">{preview.join(", ")}, …</span>
            </>
          ) : (
            <span className="text-[color:var(--color-muted-foreground)]">Fix the fields above to see the next codes.</span>
          )}
        </p>
        {reserved.length ? (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Reserved by other projects: {reserved.slice(0, 8).map((r) => `${r.prefix || "numbers only"} (${r.projectName}${r.retired ? ", earlier series" : ""})`).join(", ")}
            {reserved.length > 8 ? ` and ${reserved.length - 8} more` : ""}.
          </p>
        ) : null}
        {state.error && !state.field ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}
        {canManage ? (
          <Button type="submit" loading={pending}>
            Save code series
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

function ConversionCard({
  projectId,
  projectName,
  canManage,
  applyEnabled,
  counts,
  live,
}: {
  projectId: string;
  projectName: string;
  canManage: boolean;
  applyEnabled: boolean;
  counts: { clients: number; legacy: number; aliases: number };
  live: Live | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [options, setOptions] = useState<CodePlanOptions>({ convertLegacyPattern: true, convertCustom: false });
  const [preview, setPreview] = useState<(ConversionPreviewResult & { for: string }) | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const optionKey = JSON.stringify(options);
  const current = preview && preview.for === optionKey ? preview : null;

  const run = () =>
    startTransition(async () => {
      const result = await previewClientCodeConversion(projectId, options);
      setPreview({ ...result, for: optionKey });
    });
  const download = () =>
    startTransition(async () => {
      const file = await exportClientCodeConversion(projectId, options);
      if (file.error || !file.csv) return showToast({ tone: "danger", title: file.error ?? "Nothing to export." });
      const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv;charset=utf-8" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: file.fileName ?? "client-codes.csv" });
      a.click();
      URL.revokeObjectURL(url);
    });
  const apply = () =>
    startTransition(async () => {
      if (!current?.hash) return;
      const result = await applyClientCodeConversion(projectId, { options, hash: current.hash, confirmName: typed });
      setConfirming(false);
      setTyped("");
      showToast({ tone: result.ok ? "success" : "danger", title: result.message });
      if (result.ok) {
        setPreview(null);
        router.refresh();
      }
    });

  return (
    <Card>
      <SectionHeader
        title="Convert existing codes"
        description={`${counts.legacy} of ${counts.clients} client(s) still have an old generated code (CL-…). Converting gives them this project's codes in the order they were created. Every old code stays searchable and still finds the same client; issued invoices and receipts keep the code they were issued with.`}
      />
      {!live ? null : (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="sr-only">What to convert</legend>
            <label className="flex items-start gap-2 text-[13px]">
              <Checkbox checked={options.convertLegacyPattern} onChange={(e) => setOptions({ ...options, convertLegacyPattern: e.target.checked })} />
              <span>
                Codes in the old generated form (CL-000041)
                <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">
                  The form alone cannot prove a code was generated: check the preview for any that a client actually uses as a reference.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[13px]">
              <Checkbox checked={options.convertCustom} onChange={(e) => setOptions({ ...options, convertCustom: e.target.checked })} />
              <span>
                Custom codes too (typed by staff or taken from a file)
                <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">Off by default: these are usually real references. Converted or not, the old code still finds the client.</span>
              </span>
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={run} loading={pending && !confirming}>
              <Eye className="size-3.5" aria-hidden /> Preview (changes nothing)
            </Button>
            {current?.hash ? (
              <Button variant="ghost" onClick={download} disabled={pending}>
                <Download className="size-3.5" aria-hidden /> Export full preview (CSV)
              </Button>
            ) : null}
          </div>

          {current?.error ? <Alert tone="danger">{current.error}</Alert> : null}
          {current?.counts ? (
            <div className="space-y-3">
              <p className="text-[13px]">
                <strong className="tabular">{current.counts.changes}</strong> change(s), <strong className="tabular">{current.counts.kept}</strong> kept ·{" "}
                {current.counts.legacyPattern} old generated, {current.counts.custom} custom, {current.counts.inSeries} already in this format · {current.counts.archived} archived
                (converted like the rest, never freed) · the series then continues at {current.nextSerialAfter}.
              </p>
              <div className="max-h-[28rem] overflow-auto rounded-[var(--radius-lg)]">
                <Table>
                  <thead>
                    <tr>
                      <Th>Current code</Th>
                      <Th>New code</Th>
                      <Th>Kind</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows!.map((r) => (
                      <tr key={r.clientId}>
                        <Td className="font-mono">{r.from}</Td>
                        <Td className="font-mono">{r.to ?? <span className="text-[color:var(--color-muted-foreground)]">kept</span>}</Td>
                        <Td>
                          {CATEGORY_LABEL[r.category]}
                          {r.archived ? " · archived" : ""}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {current.rows!.length < current.counts.clients ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Showing {current.rows!.length} of {current.counts.clients}; the export has every row.</p> : null}

              {canManage && current.counts.changes > 0 ? (
                applyEnabled ? (
                  <Button variant="danger" onClick={() => setConfirming(true)}>
                    <ShieldAlert className="size-3.5" aria-hidden /> Apply this conversion
                  </Button>
                ) : (
                  <Alert tone="info">
                    Applying is switched off for this installation. Review and export the preview, take a database backup, then set CLIENT_CODE_CONVERSION_ENABLED=true and
                    restart the app to apply it.
                  </Alert>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={apply}
        title={`Convert ${current?.counts?.changes ?? 0} client code(s)?`}
        description="Exactly the previewed changes are applied, in one step. If any client or code changed since the preview, nothing is applied. Old codes stay searchable."
        confirmLabel="Apply conversion"
        tone="danger"
        loading={pending}
        confirmDisabled={typed.trim() !== projectName}
      >
        <Field label={`Type the project's name, ${projectName}, to confirm`} htmlFor="confirm-project-name">
          <Input id="confirm-project-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    </Card>
  );
}
