import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { formatDateTime } from "@/lib/date";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { CLIENT_IMPORT_FIELDS, MAX_CLIENT_IMPORT_BYTES, MAX_CLIENT_IMPORT_ROWS } from "@support-automation/shared";
import { ImportUpload } from "./ImportUpload";

const STATUS_COLOR: Record<string, "green" | "yellow" | "red" | "gray" | "blue"> = { PREVIEW: "blue", PROCESSING: "yellow", COMPLETED: "green", PARTIAL: "yellow", FAILED: "red", CANCELLED: "gray" };

export default async function ClientImportPage() {
  await requireAccess("clients.import");
  const jobs = await prisma.clientImportJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, fileName: true, status: true, createdAt: true, totalRows: true, importedCount: true, updatedCount: true, skippedCount: true, failedCount: true, createdBy: { select: { name: true } } },
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Import clients" description="Upload a file, check the preview, map the columns, then confirm. Nothing is created until you confirm." />
      <Card className="max-w-3xl p-6">
        <ImportUpload maxMb={MAX_CLIENT_IMPORT_BYTES / 1024 / 1024} maxRows={MAX_CLIENT_IMPORT_ROWS} />
        <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">
          Columns it understands: {CLIENT_IMPORT_FIELDS.map((f) => f.label).join(", ")}. Several phones or emails in one cell can be separated with a semicolon. Rows that match a client you already have are handled by the policy you choose at the confirmation.
        </p>
      </Card>

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
