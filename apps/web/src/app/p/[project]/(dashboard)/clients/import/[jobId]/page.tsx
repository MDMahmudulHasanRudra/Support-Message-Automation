import { notFound } from "next/navigation";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { computeImportPreview, type RawImportRow } from "@/server/clientImport";
import { formatDateTime } from "@/lib/date";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Card, PageHeader, ProgressBar, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import type { ClientImportMapping } from "@support-automation/shared";
import { AbandonImport, ImportReview } from "./ImportReview";

/** Over ten minutes since it started: the same bound `abandonClientImport` enforces on the server. */
function isStale(startedAt: Date | null): boolean {
  return startedAt !== null && Date.now() - startedAt.getTime() > 10 * 60_000;
}

export default async function ClientImportJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireAccess("clients.import");
  const { jobId } = await params;
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId }, include: { createdBy: { select: { name: true } } } });
  if (!job) notFound();

  const header = (
    <PageHeader
      title={job.fileName}
      description={`${job.status.toLowerCase()} · started ${formatDateTime(job.createdAt)}${job.createdBy ? ` by ${job.createdBy.name}` : ""}`}
      actions={
        <Link href="/clients/import" className="text-sm underline underline-offset-2">
          All imports
        </Link>
      }
    />
  );

  if (job.status === "PREVIEW") {
    const rows = job.rows as unknown as RawImportRow[];
    const mapping = job.mapping as ClientImportMapping;
    const preview = await computeImportPreview(rows, mapping);
    const headers = Object.keys(rows[0] ?? {});
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Rows in the file" value={preview.totalRows.toLocaleString()} />
          <StatTile label="Will be created" value={preview.willCreate.toLocaleString()} tone="success" />
          <StatTile label="Match an existing client" value={preview.matchExisting.toLocaleString()} tone={preview.matchExisting ? "warning" : "neutral"} />
          <StatTile label="Repeat an earlier row" value={preview.repeatsInFile.toLocaleString()} tone={preview.repeatsInFile ? "warning" : "neutral"} />
          <StatTile label="Invalid" value={preview.invalidCount.toLocaleString()} tone={preview.invalidCount ? "danger" : "neutral"} />
        </div>
        {preview.missingRequired.length ? <Alert tone="warning">Map a column to {preview.missingRequired.join(", ")} before importing.</Alert> : null}

        <Card className="p-6">
          <ImportReview
            jobId={job.id}
            headers={headers}
            mapping={mapping as Record<string, string>}
            willCreate={preview.willCreate}
            matchExisting={preview.matchExisting + preview.repeatsInFile}
            invalidCount={preview.invalidCount}
            canConfirm={preview.missingRequired.length === 0 && preview.validRows > 0}
          />
        </Card>

        <div>
          <SectionHeader title="First rows" description="What the first rows will do with the current mapping." />
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Name</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((s) => (
                <tr key={s.rowNumber}>
                  <Td>{s.rowNumber}</Td>
                  <Td>{s.name}</Td>
                  <Td>
                    {s.decision === "CREATE" ? (
                      <Badge color="green">New client</Badge>
                    ) : s.decision === "MATCH" ? (
                      <Badge color="yellow">
                        Matches{" "}
                        {s.matchedClientId ? (
                          <Link className="link" href={`/clients/${s.matchedClientId}`}>
                            an existing client
                          </Link>
                        ) : null}
                      </Badge>
                    ) : (
                      <Badge color="gray">Repeats an earlier row</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>

        {preview.invalid.length > 0 ? (
          <div>
            <SectionHeader title={`Invalid rows (${preview.invalidCount.toLocaleString()})`} description={preview.invalidCount > preview.invalid.length ? `Showing the first ${preview.invalid.length}.` : undefined} />
            <Table>
              <thead>
                <tr>
                  <Th>Row</Th>
                  <Th>Problem</Th>
                </tr>
              </thead>
              <tbody>
                {preview.invalid.map((r) => (
                  <tr key={r.rowNumber}>
                    <Td>{r.rowNumber}</Td>
                    <Td>{r.errors.join(" ")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </div>
    );
  }

  const errors = (job.errors as unknown as Array<{ rowNumber: number; errors: string[] }>) ?? [];
  const stale = job.status === "PROCESSING" && isStale(job.startedAt);
  return (
    <div className="space-y-6">
      {header}
      {job.status === "PROCESSING" ? (
        <Alert tone={stale ? "warning" : "info"} title={stale ? "This import seems to have been interrupted" : "Import in progress"}>
          {stale ? "It has been running for over 10 minutes. Clients already imported are kept; close it and re-upload with Skip or Update to finish." : "This page shows the counts so far when you refresh it."}
          {stale ? (
            <div className="mt-2">
              <AbandonImport jobId={job.id} />
            </div>
          ) : null}
        </Alert>
      ) : null}
      {job.status === "PROCESSING" ? <ProgressBar value={job.importedCount + job.updatedCount + job.skippedCount + job.failedCount} max={Math.max(job.totalRows, 1)} /> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Rows in the file" value={job.totalRows.toLocaleString()} />
        <StatTile label="Created" value={job.importedCount.toLocaleString()} tone="success" />
        <StatTile label="Updated" value={job.updatedCount.toLocaleString()} />
        <StatTile label="Skipped" value={job.skippedCount.toLocaleString()} tone={job.skippedCount ? "warning" : "neutral"} />
        <StatTile label="Failed" value={job.failedCount.toLocaleString()} tone={job.failedCount ? "danger" : "neutral"} />
      </div>
      {errors.length > 0 ? (
        <div>
          <SectionHeader title="Row notes" description="Why rows were skipped or failed (the first 200)." />
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i}>
                  <Td>{e.rowNumber || "—"}</Td>
                  <Td>{e.errors.join(" ")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      <p className="text-xs text-[color:var(--color-muted-foreground)]">The file&apos;s rows are deleted when an import ends; only these counts and notes are kept.</p>
    </div>
  );
}
