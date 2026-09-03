"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Plug } from "lucide-react";
import { Alert, Badge, Button, Card, Field, SectionHeader, SwitchField } from "@/components/ui";
import {
  checkForgeConnection,
  readForgeSyncStatus,
  requestForgeSync,
  updateForgeSettings,
  type ForgeConnectionCheck,
} from "@/server/actions/forge";

export interface ForgeSettingsValues {
  enabled: boolean;
  projectId: string | null;
  projectName: string | null;
  syncUserGuides: boolean;
  syncModuleGuides: boolean;
  researchUnanswered: boolean;
  autoVerifyUserGuides: boolean;
}

/**
 * The switches, plus the two things that need the network: proving the credentials work, and
 * asking for a sync now.
 *
 * "Sync now" polls rather than blocking. A full repository pass is dozens of model calls and takes
 * minutes; a spinner that never resolves would read as a hang.
 */
export function ForgeSettingsCard({
  configured,
  settings,
  lastSyncCompletedAt,
}: {
  configured: boolean;
  settings: ForgeSettingsValues;
  lastSyncCompletedAt: string | null;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ForgeConnectionCheck | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState(settings.projectId ?? "");

  function testConnection() {
    setChecking(true);
    void (async () => {
      try {
        setCheck(await checkForgeConnection());
      } finally {
        setChecking(false);
      }
    })();
  }

  function syncNow() {
    setSyncing(true);
    setSyncMessage(null);
    void (async () => {
      try {
        const queued = await requestForgeSync();
        if (!queued.queued) {
          setSyncMessage(queued.error ?? "Could not start the sync.");
          return;
        }
        // Up to ~10 minutes. A full first pass over a large repository genuinely takes minutes,
        // and stopping early would report a failure that has not happened.
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const status = await readForgeSyncStatus();
          if (status.status === "DONE") {
            const r = status.result ?? {};
            setSyncMessage(
              `Read ${r.documentsRead ?? 0} document(s) and ${r.modulesRead ?? 0} product area(s). ` +
                `Learned ${r.entriesCreated ?? 0} answer(s)` +
                (r.entriesBlocked ? `, blocked ${r.entriesBlocked} that would have exposed internals.` : "."),
            );
            router.refresh();
            return;
          }
          if (status.status === "FAILED") {
            setSyncMessage(status.error ?? "The sync failed.");
            return;
          }
        }
        setSyncMessage("Still running. Reload the page in a few minutes to see the result.");
      } finally {
        setSyncing(false);
      }
    })();
  }

  return (
    <Card>
      <SectionHeader title="Connection and what to learn" description="Which product this support system answers questions about, and how much of it the AI is allowed to read." />
      <form
        action={(formData) => startSaving(async () => {
          await updateForgeSettings(formData);
          router.refresh();
        })}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={testConnection} loading={checking} disabled={!configured}>
            <Plug className="size-3.5" aria-hidden />
            Test connection
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={syncNow}
            loading={syncing}
            disabled={!configured || !settings.enabled || !settings.projectId}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Sync now
          </Button>
          {settings.projectName ? <Badge color="blue">{settings.projectName}</Badge> : null}
          {lastSyncCompletedAt ? (
            <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
              Last synced {lastSyncCompletedAt}
            </span>
          ) : null}
        </div>

        {check ? (
          check.ok ? (
            <Alert tone="success">
              Connected as {check.identity?.name} ({check.identity?.email}). API version{" "}
              {check.identity?.apiVersion}. {check.projects?.length ?? 0} project(s) in scope.
            </Alert>
          ) : (
            <Alert tone="danger">{check.error}</Alert>
          )
        ) : null}

        {syncMessage ? <Alert tone="info">{syncMessage}</Alert> : null}

        {check?.ok && (check.projects?.length ?? 0) > 0 ? (
          <Field
            label="Project to learn from"
            hint="The Forge project whose repository holds the product your customers ask about."
          >
            <select
              name="projectId"
              value={selectedProject}
              onChange={(event) => setSelectedProject(event.target.value)}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
            >
              <option value="">Not selected</option>
              {check.projects!.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              type="hidden"
              name="projectName"
              value={check.projects!.find((project) => project.id === selectedProject)?.name ?? ""}
            />
          </Field>
        ) : (
          <>
            <input type="hidden" name="projectId" value={settings.projectId ?? ""} />
            <input type="hidden" name="projectName" value={settings.projectName ?? ""} />
          </>
        )}

        <div className="space-y-2.5">
          <SwitchField
            name="enabled"
            defaultChecked={settings.enabled}
            disabled={!configured}
            label="Learn from this product's repository"
            description="Off means nothing is read and nothing changes. Every other switch here does nothing while this is off."
          />
          <SwitchField
            name="syncUserGuides"
            defaultChecked={settings.syncUserGuides}
            label="Read the user guides your team wrote"
            description="The hand-written, customer-facing documentation in the repository. The most reliable source there is."
          />
          <SwitchField
            name="autoVerifyUserGuides"
            defaultChecked={settings.autoVerifyUserGuides}
            label="Publish guide answers without review"
            description="A guide your team wrote for customers is already authoritative. Turn this off if you would rather check every answer first."
          />
          <SwitchField
            name="syncModuleGuides"
            defaultChecked={settings.syncModuleGuides}
            label="Write guides for undocumented areas by reading the code"
            description="For product areas nobody has documented, the AI reads the code behind them and writes a user guide. These always wait for review — a model's reading of code is evidence, not fact."
          />
          <SwitchField
            name="researchUnanswered"
            defaultChecked={settings.researchUnanswered}
            label="Research questions nothing could answer"
            description="When a customer asks something the knowledge base does not cover, look it up in the code afterwards so the next person to ask gets an answer. Costs an AI call per new question."
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!configured}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
