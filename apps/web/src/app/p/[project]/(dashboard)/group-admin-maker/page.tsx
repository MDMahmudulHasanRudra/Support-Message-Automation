import Link from "@/components/ProjectLink";
import { ADMIN_PROMOTION_JOB_LABELS } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Card, HelpButton, HelpSection, PageHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { getActiveAdminPromotionJobs, getAdminMakerAccounts, getRecentAdminPromotionJobs } from "@/server/groupAdminPromotion";
import { AdminJobProgress, formatTarget, JOB_STATUS_COLOR } from "./AdminJobProgress";
import { AdminMakerWizard } from "./AdminMakerWizard";

export const metadata = { title: "WhatsApp Groups Admin Maker" };

/**
 * WhatsApp → Groups Admin Maker. Running jobs come first and are read from the database on every
 * visit, so coming back to this page — after Reports, after a refresh, from another browser — shows
 * the same job where it is now. Starting another is below them.
 */
export default async function GroupAdminMakerPage() {
  const { canManage } = await pageAccess("bulk_messaging.view", "bulk_messaging.manage", "BULK_MESSAGING");
  const [active, recent, accounts] = await Promise.all([getActiveAdminPromotionJobs(), getRecentAdminPromotionJobs(), getAdminMakerAccounts()]);
  // Polls only while something is actually running; a paused job changes only when a person acts.
  const polling = active.some((j) => j.status === "CHECKING" || j.status === "RUNNING");

  return (
    <div>
      {polling ? <AutoRefresh intervalMs={4000} /> : null}
      <PageHeader
        title="WhatsApp Groups Admin Maker"
        description="Make a WhatsApp member an admin in every group where the selected account is an admin. Nobody is ever added to a group."
        actions={
          <HelpButton moduleTitle="WhatsApp Groups Admin Maker">
            <HelpSection title="What this does">
              <p>
                Enter one number. In every group where the selected account is an admin, and the number is already a member,
                that member is made an admin. Groups where the account is not an admin are skipped without being touched, and
                a number that is not a member is never added.
              </p>
            </HelpSection>
            <HelpSection title="It keeps running without you">
              <p>
                The work runs in the background worker, one group at a time and at least 8 seconds apart on one account, so a
                job over hundreds of groups takes a while. Close the page, refresh or go elsewhere — coming back here shows the
                same job where it is. Starting the same number again on the same account while it runs shows the running job
                instead of starting a second.
              </p>
            </HelpSection>
            <HelpSection title="Results">
              <p>
                Promoted (confirmed by reading the admin list back), Already admin (nothing changed), Not a member (never added),
                Skipped (the account is not an admin there), Could not verify (WhatsApp lists some members by an internal id
                instead of their number, so membership could not be confirmed and nothing was attempted), Unavailable, and
                Failed with WhatsApp&apos;s reason. A failure that may pass is tried once more before it is recorded.
              </p>
            </HelpSection>
            <HelpSection title="If the account disconnects">
              <p>
                The job pauses with &quot;Connection lost&quot;; nothing is marked done that was not. Reconnect the account and
                press Resume. Turning automation off pauses it the same way.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      {canManage ? null : <ViewOnlyNotice />}

      {active.length > 0 ? (
        <section className="mb-6 flex flex-col gap-4" aria-label="Running jobs">
          {active.map((job) => (
            <Card key={job.id} className="p-5">
              <AdminJobProgress job={job} showLink />
            </Card>
          ))}
        </section>
      ) : null}

      {canManage ? (
        <section className="mb-6" aria-label="Start a job">
          <AdminMakerWizard accounts={accounts.map((a) => ({ id: a.id, label: a.label, status: a.status, groupCount: a.groupCount }))} />
        </section>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-foreground)]">Recent jobs</h2>
        {recent.length === 0 ? (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No finished jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Target</Th>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th>Promoted</Th>
                  <Th>Already admin</Th>
                  <Th>Failed</Th>
                  <Th>Finished</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((job) => (
                  <tr key={job.id}>
                    <Td>
                      <Link className="link tabular" href={`/group-admin-maker/jobs/${job.id}`}>
                        {formatTarget(job.phoneNumber)}
                      </Link>
                    </Td>
                    <Td>{job.accountLabel}</Td>
                    <Td>
                      <Badge color={JOB_STATUS_COLOR[job.status] ?? "gray"}>{ADMIN_PROMOTION_JOB_LABELS[job.status] ?? job.status}</Badge>
                    </Td>
                    <Td>{job.counts.promoted.toLocaleString("en-US")}</Td>
                    <Td>{job.counts.alreadyAdmin.toLocaleString("en-US")}</Td>
                    <Td>{job.counts.failed.toLocaleString("en-US")}</Td>
                    <Td>{job.completedAt ? formatDateTime(job.completedAt) : "—"}</Td>
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
