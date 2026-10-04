import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "@/components/ProjectLink";
import { ACTIVE_ADMIN_PROMOTION_JOB_STATUSES, ADMIN_PROMOTION_ITEM_LABELS } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, type BadgeColor, Card, PageHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { getAdminPromotionJob } from "@/server/groupAdminPromotion";
import { AdminJobProgress } from "../../AdminJobProgress";
import { AdminJobActions } from "../../AdminJobActions";

export const metadata = { title: "Admin Maker job" };

const ITEM_COLOR: Record<string, BadgeColor> = {
  PENDING: "gray",
  PROMOTED: "green",
  ALREADY_ADMIN: "cyan",
  NOT_MEMBER: "gray",
  NOT_ACCOUNT_ADMIN: "gray",
  CANNOT_VERIFY: "yellow",
  GROUP_UNAVAILABLE: "gray",
  FAILED: "red",
};

/** Per-group filter chips, so 1,800 rows of "Skipped" never bury the four that failed. */
const FILTERS: Array<{ key: string; label: string; statuses: string[] | null }> = [
  { key: "attention", label: "Promoted, failed or unverified", statuses: ["PROMOTED", "FAILED", "CANNOT_VERIFY"] },
  { key: "all", label: "All groups", statuses: null },
  { key: "PROMOTED", label: "Promoted", statuses: ["PROMOTED"] },
  { key: "ALREADY_ADMIN", label: "Already admin", statuses: ["ALREADY_ADMIN"] },
  { key: "NOT_MEMBER", label: "Not a member", statuses: ["NOT_MEMBER"] },
  { key: "NOT_ACCOUNT_ADMIN", label: "Skipped", statuses: ["NOT_ACCOUNT_ADMIN"] },
  { key: "CANNOT_VERIFY", label: "Could not verify", statuses: ["CANNOT_VERIFY"] },
  { key: "FAILED", label: "Failed", statuses: ["FAILED"] },
  { key: "PENDING", label: "Waiting", statuses: ["PENDING"] },
];

export default async function AdminPromotionJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { canManage } = await pageAccess("bulk_messaging.view", "bulk_messaging.manage", "BULK_MESSAGING");
  const { id } = await params;
  const detail = await getAdminPromotionJob(id);
  if (!detail) notFound();
  const { job, items } = detail;
  const filterKey = (await searchParams).show ?? "attention";
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0]!;
  const shown = filter.statuses ? items.filter((i) => filter.statuses!.includes(i.status)) : items;
  const active = (ACTIVE_ADMIN_PROMOTION_JOB_STATUSES as readonly string[]).includes(job.status);
  const polling = job.status === "CHECKING" || job.status === "RUNNING";
  const paused = job.status === "PAUSED_DISCONNECTED" || job.status === "STOPPED_KILL_SWITCH";

  return (
    <div>
      {polling ? <AutoRefresh intervalMs={4000} /> : null}
      <Link href="/group-admin-maker" className="link mb-3 inline-flex items-center gap-1 text-[13px]">
        <ArrowLeft className="size-3.5" aria-hidden />
        Groups Admin Maker
      </Link>
      <PageHeader
        title="Admin Maker job"
        description={`Started ${formatDateTime(job.createdAt)}${job.createdBy ? ` by ${job.createdBy}` : ""}.${job.completedAt ? ` Finished ${formatDateTime(job.completedAt)}.` : ""}`}
        actions={canManage ? <AdminJobActions jobId={job.id} canCancel={active} canResume={paused} /> : null}
      />
      {canManage ? null : <ViewOnlyNotice />}

      <Card className="mb-5 p-5">
        <AdminJobProgress job={job} />
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--color-foreground)]">
            Per-group results ({shown.length.toLocaleString("en-US")} of {items.length.toLocaleString("en-US")})
          </h2>
          <nav aria-label="Filter results" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/group-admin-maker/jobs/${job.id}?show=${f.key}`}
                aria-current={f.key === filter.key ? "true" : undefined}
                className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
                  f.key === filter.key
                    ? "border-[var(--color-primary)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                    : "border-[var(--color-border)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                }`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        </div>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">No groups with this result{active ? " yet" : ""}.</p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Status</Th>
                  <Th>Reason</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 2000).map((item) => (
                  <tr key={item.id}>
                    <Td>
                      {item.groupNameSnapshot}
                      <span className="block text-[11px] text-[color:var(--color-subtle-foreground)]">{item.group.whatsappGroupId}</span>
                    </Td>
                    <Td>
                      <Badge color={ITEM_COLOR[item.status] ?? "gray"}>{ADMIN_PROMOTION_ITEM_LABELS[item.status] ?? item.status}</Badge>
                    </Td>
                    <Td className="max-w-md text-[13px] text-[color:var(--color-muted-foreground)]">{item.reason ?? "—"}</Td>
                    <Td>{item.processedAt ? formatDateTime(item.processedAt) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
