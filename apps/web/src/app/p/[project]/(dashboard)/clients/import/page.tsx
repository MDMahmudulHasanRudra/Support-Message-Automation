import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { formatDateTime } from "@/lib/date";
import Link from "@/components/ProjectLink";
import { Alert, Badge, ButtonLink, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { MAX_CLIENT_IMPORT_BYTES, MAX_CLIENT_IMPORT_ROWS } from "@support-automation/shared";
import { Download, FileSpreadsheet, ListChecks, Upload, Users } from "lucide-react";
import { hasPermission } from "@/server/permissions";
import { IMPORT_TEMPLATE_COLUMNS } from "@/server/clientImportTemplate";
import { ImportUpload } from "./ImportUpload";

function Step({ n, title, icon: Icon, children }: { n: number; title: string; icon: typeof Download; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-semibold text-[var(--color-on-primary)]">{n}</span>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
          {title}
        </h2>
      </div>
      <div className="flex flex-1 flex-col gap-3 text-sm">{children}</div>
    </Card>
  );
}

const STATUS_COLOR: Record<string, "green" | "yellow" | "red" | "gray" | "blue"> = { PREVIEW: "blue", PROCESSING: "yellow", COMPLETED: "green", PARTIAL: "yellow", FAILED: "red", CANCELLED: "gray" };

export default async function ClientImportPage() {
  const session = await requireAccess("clients.import");
  const canExport = await hasPermission(session, "clients.export");
  const jobs = await prisma.clientImportJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, fileName: true, status: true, createdAt: true, totalRows: true, importedCount: true, updatedCount: true, skippedCount: true, failedCount: true, createdBy: { select: { name: true } } },
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Import clients" description="Download the template, fill one client per row, upload it. You see a preview and every problem row before anything is saved." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Step n={1} title="Download the template" icon={Download}>
          <p className="text-[color:var(--color-muted-foreground)]">
            An Excel file made for this project: drop-downs with your own teams, staff, countries and currencies, a tip on every column, an <strong>Example</strong> sheet and a <strong>How to fill</strong> guide.
          </p>
          <div className="mt-auto flex flex-wrap gap-2">
            <ButtonLink href="/api/clients/import/template" variant="primary" size="md" download>
              <FileSpreadsheet className="size-4" aria-hidden />
              Download template
            </ButtonLink>
            {canExport ? (
              <ButtonLink href="/api/clients/import/template?data=current" size="md" download title="Your current clients in the template format: edit them, then upload and choose Update.">
                <Users className="size-4" aria-hidden />
                Template with my clients
              </ButtonLink>
            ) : null}
          </div>
        </Step>
        <Step n={2} title="Fill it in" icon={ListChecks}>
          <ul className="list-disc space-y-1 pl-5 text-[color:var(--color-muted-foreground)]">
            <li>One client per row on the first sheet. Only <strong>Name</strong> is required.</li>
            <li>Leave <strong>Client code</strong> empty for new clients — it is made for you.</li>
            <li>Phones with country code (+8801…); several in one cell separated by <code>;</code></li>
            <li>Dates as 2026-10-17 or 17/10/2026 (day first).</li>
            <li>A subscription needs Service, Start date and a Duration or an Expiry date.</li>
          </ul>
        </Step>
        <Step n={3} title="Upload and check" icon={Upload}>
          <ImportUpload maxMb={MAX_CLIENT_IMPORT_BYTES / 1024 / 1024} maxRows={MAX_CLIENT_IMPORT_ROWS} />
        </Step>
      </div>

      <details className="group rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold">
          <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
          Every column, what to write, and an example
          <span className="ml-2 font-normal text-[color:var(--color-muted-foreground)]">— the same guide is inside the template</span>
        </summary>
        <div className="overflow-x-auto px-5 pb-5">
          <Table>
            <thead>
              <tr>
                <Th>Column</Th>
                <Th>What to write</Th>
                <Th>Example</Th>
                <Th>Accepted values</Th>
              </tr>
            </thead>
            <tbody>
              {IMPORT_TEMPLATE_COLUMNS.map((c) => (
                <tr key={c.header}>
                  <Td className="whitespace-nowrap font-medium">
                    {c.header} {c.required ? <Badge color="blue">required</Badge> : null}
                  </Td>
                  <Td className="min-w-72 text-[color:var(--color-muted-foreground)]">{c.what}</Td>
                  <Td className="whitespace-nowrap">{c.example || "—"}</Td>
                  <Td className="text-[color:var(--color-muted-foreground)]">{c.accepted ?? (c.list ? "Pick from the drop-down" : c.format === "date" ? "2026-10-17 · 17/10/2026 · 17 Oct 2026" : "Free text")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
            Using another program&apos;s export? Upload it as it is — columns such as Mobile, Join Date, Exp Date and Assign2Emp are recognised, and you can map any column by hand on the preview.
          </p>
        </div>
      </details>

      <div>
        <SectionHeader title="Import history" />
        {jobs.length === 0 ? (
          <EmptyState>No imports yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Started</Th>
                <Th>By</Th>
                <Th>Status</Th>
                <Th>Rows</Th>
                <Th>Created</Th>
                <Th>Updated</Th>
                <Th>Skipped</Th>
                <Th>Failed</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <Td>
                    <Link className="link" href={`/clients/import/${j.id}`}>
                      {j.fileName}
                    </Link>
                  </Td>
                  <Td>{formatDateTime(j.createdAt)}</Td>
                  <Td>{j.createdBy?.name ?? "—"}</Td>
                  <Td>
                    <Badge color={STATUS_COLOR[j.status] ?? "gray"}>{j.status.toLowerCase()}</Badge>
                  </Td>
                  <Td className="tabular">{j.totalRows.toLocaleString()}</Td>
                  <Td className="tabular">{j.importedCount.toLocaleString()}</Td>
                  <Td className="tabular">{j.updatedCount.toLocaleString()}</Td>
                  <Td className="tabular">{j.skippedCount.toLocaleString()}</Td>
                  <Td className="tabular">{j.failedCount.toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="mt-3">
          <Alert tone="info">Imports run inside the request, up to {MAX_CLIENT_IMPORT_ROWS.toLocaleString()} rows at a time. For a bigger file, split it. An import interrupted by a restart can be closed from its page.</Alert>
        </div>
      </div>
    </div>
  );
}
