import { runMetadataLines, type ReportRunMetadata } from "@support-automation/shared";

/**
 * What this run was computed from, in one collapsed block under the header line: calculation version,
 * the moment and the data cutoff, the period with the context read around it, the filters, how senders
 * are identified, and counts of collection and identity quality. The same lines go in the Excel "Run
 * information" sheet, so a screenshot and a file say the same thing. Counts and plain notes only — no
 * score — and it changes no figure.
 */
export function RunInformation({ meta }: { meta: ReportRunMetadata }) {
  const lines = runMetadataLines(meta);
  return (
    <details className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <summary className="cursor-pointer text-[13px] font-medium text-[color:var(--color-foreground)]">
        Run information
        <span className="ml-2 font-normal text-[color:var(--color-muted-foreground)]">
          {meta.calculationVersions.join(", ")} · {meta.timezone}
        </span>
      </summary>
      <dl className="mt-3 divide-y divide-[var(--color-border)]">
        {lines.map((line) => (
          <div key={line.label} className="flex items-start justify-between gap-3 py-1.5 text-[13px]">
            <dt className="min-w-0">
              <span className="text-[color:var(--color-foreground)]">{line.label}</span>
              {line.note ? <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">{line.note}</span> : null}
            </dt>
            <dd className="tabular m-0 max-w-[60%] shrink-0 text-right font-medium text-[color:var(--color-foreground)]">{line.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
