import { HardDrive } from "lucide-react";
import { formatMediaBytes, MESSAGE_MEDIA_TYPE_LABELS } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Alert, Card, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import {
  getMediaCleanupJobs,
  getMediaStorageHealth,
  getMediaStorageSettingsView,
  getMediaUsage,
} from "@/server/mediaStorageReports";
import { MediaStorageSettingsForm } from "./MediaStorageSettingsForm";
import { MediaCleanupPanel } from "./MediaCleanupPanel";

/**
 * Settings → WhatsApp → Message & Media Storage (MEDIA_STORAGE.md).
 *
 * Text is always stored and has no switch. What is configurable is which attachment types are
 * fetched from now on, and how long stored files are kept. Every number on this page is read from
 * the media rows — the size recorded when each file was written — never estimated.
 */
export default async function MediaStorageSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit");
  const [settings, usage, jobs, health] = await Promise.all([
    getMediaStorageSettingsView(),
    getMediaUsage(),
    getMediaCleanupJobs(),
    getMediaStorageHealth(),
  ]);
  const activeJob = jobs.find((j) => j.status === "SCHEDULED" || j.status === "RUNNING") ?? null;
  const inFlight = usage.byStatus.PENDING + usage.byStatus.DOWNLOADING;

  return (
    <div>
      {activeJob || inFlight > 0 ? <AutoRefresh intervalMs={5000} /> : null}
      <PageHeader
        title="Message & Media Storage"
        description="Every message's text is always kept. Choose which attachments are stored, and for how long."
        actions={
          <HelpButton moduleTitle="Message & Media Storage">
            <HelpSection title="What is always stored">
              <p>
                The text of every WhatsApp message — and a record that a message carried a photo,
                video, voice note or file — is always stored. There is no switch for it.
              </p>
            </HelpSection>
            <HelpSection title="What the switches do">
              <p>
                Each switch decides whether attachments of that type that arrive <strong>from now on</strong> are
                downloaded and kept. Turning one off deletes nothing already stored. Turning one on does
                not recover anything that arrived while it was off — WhatsApp only offers a file for a
                limited time.
              </p>
              <p>
                Files are downloaded in the background, after the message is saved, so a large video never
                slows down replies. While one is on its way the chat shows &ldquo;Media is being
                stored&rdquo;.
              </p>
            </HelpSection>
            <HelpSection title="Retention and cleanup">
              <p>
                Retention removes stored <strong>files</strong> older than the period you choose, in the
                background and in small batches. The messages stay, word for word; the chat shows where
                a file was removed. A cleanup can also be started by hand. Removed files cannot be
                restored.
              </p>
            </HelpSection>
            <HelpSection title="Backups">
              <p>
                A database backup does <strong>not</strong> include media files. They live on the
                media volume (<code>support_automation_media</code>), which must be backed up separately.
                Restoring only the database brings back every message and its file details, but not the
                files themselves.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {!health.configured ? (
        <div className="mb-4">
          <Alert tone="warning">
            Media storage is not configured on this server (<code>MEDIA_STORAGE_DIR</code>). Attachments are still
            recorded with every message, but their files cannot be shown here until it is set — for the
            dashboard and the worker, to the same directory.
          </Alert>
        </div>
      ) : null}

      <Card className="mb-5">
        <SectionHeader
          title="Storage used"
          description="Stored files, from the size recorded when each was written."
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Total stored" value={formatMediaBytes(usage.totalBytes)} hint={`${usage.totalFiles.toLocaleString("en-US")} file(s)`} />
          <StatTile
            label="Being stored"
            value={inFlight.toLocaleString("en-US")}
            hint="Waiting for, or being downloaded by, the worker"
            tone={inFlight > 0 ? "accent" : "neutral"}
          />
          <StatTile
            label="Could not be stored"
            value={(usage.byStatus.FAILED + usage.byStatus.NOT_STORED).toLocaleString("en-US")}
            hint={`${usage.byStatus.FAILED.toLocaleString("en-US")} failed · ${usage.byStatus.NOT_STORED.toLocaleString("en-US")} switched off or too large`}
          />
          <StatTile
            label="Free on the media disk"
            value={health.freeBytes === null ? "—" : formatMediaBytes(health.freeBytes)}
            hint={health.freeBytes === null ? "Not measurable here" : "Below 2 GB, new files are not stored"}
            tone={health.freeBytes !== null && health.freeBytes < 5 * 1024 ** 3 ? "warning" : "neutral"}
          />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[11px] font-medium tracking-[0.04em] text-[color:var(--color-subtle-foreground)] uppercase">
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 text-right font-medium">Files</th>
                <th className="py-2 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {usage.byType.map((row) => (
                <tr key={row.type} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-3 text-[color:var(--color-foreground)]">{MESSAGE_MEDIA_TYPE_LABELS[row.type]}</td>
                  <td className="tabular py-2 pr-3 text-right text-[color:var(--color-muted-foreground)]">{row.files.toLocaleString("en-US")}</td>
                  <td className="tabular py-2 text-right text-[color:var(--color-foreground)]">{formatMediaBytes(row.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <MediaStorageSettingsForm settings={settings} canManage={canManage} />

      <MediaCleanupPanel
        canManage={canManage}
        activeJob={activeJob}
        jobs={jobs.map((j) => ({ ...j, olderThanLabel: formatDateTime(j.olderThan), createdLabel: formatDateTime(j.createdAt), completedLabel: j.completedAt ? formatDateTime(j.completedAt) : null }))}
      />

      <p className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        <HardDrive className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Database backups do not include media files. Back up the media volume as well — restoring the
          database alone brings back the messages and their file details, but not the files.
        </span>
      </p>
    </div>
  );
}
