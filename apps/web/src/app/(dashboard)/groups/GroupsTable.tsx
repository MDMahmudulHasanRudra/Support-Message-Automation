"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Select,
  Table,
  Td,
  Th,
  Tooltip,
} from "@/components/ui";
import {
  bulkSetMonitoring,
  requestGroupParticipantCount,
  requestGroupKnowledgeBuild,
  toggleGroupAiAutomation,
  toggleGroupAiExcluded,
  toggleGroupMonitoring,
  type BulkMonitoringResult,
} from "@/server/actions/groups";
import { GroupPriorityDialog, type TeamMemberOption } from "./GroupPriorityDialog";

export interface GroupRow {
  id: string;
  name: string;
  whatsappGroupId: string;
  accountLabel: string;
  isMonitored: boolean;
  isActive: boolean;
  participantCount: number | null;
  lastSyncedAt: string | null;
  priority: "P1" | "P2" | "P3" | null;
  assignedTeamMemberId: string | null;
  assignedTeamMemberName: string | null;
  escalationMonitoringEnabled: boolean;
  aiAutomationEnabled: boolean;
  /** A hard "never let AI answer here" — honoured even when the global scope has opted every
   * monitored group in. */
  aiAutomationExcluded: boolean;
  /** True when AiSettings.aiAutomationScope has opted every monitored group in, so this row's
   * own opt-in switch is not what decides eligibility. */
  aiScopeIsGlobal: boolean;
  /** ISO timestamp of the last knowledge-builder run for this group, or null if never. */
  knowledgeBuiltAt: string | null;
  /** ISO timestamp — while in the future, the AI fallback layer is paused for this group (a team
   * member sent a message recently; see WhatsAppGroup.aiSuppressedUntil). Null = not suppressed. */
  aiSuppressedUntil: string | null;
}

type PendingBulkAction = "enable" | "disable" | null;

export function GroupsTable({
  groups,
  pageSize,
  pageSizeHrefs,
  teamMembers = [],
}: {
  groups: GroupRow[];
  pageSize?: number;
  pageSizeHrefs?: Array<{ size: number; href: string }>;
  teamMembers?: TeamMemberOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingBulkAction>(null);
  const [lastResult, setLastResult] = useState<BulkMonitoringResult | null>(null);

  const [toggleTarget, setToggleTarget] = useState<GroupRow | null>(null);
  const [isToggling, startToggle] = useTransition();
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [isFetchingCount, startFetchCount] = useTransition();
  const [priorityTarget, setPriorityTarget] = useState<GroupRow | null>(null);
  const [togglingAiId, setTogglingAiId] = useState<string | null>(null);
  const [isTogglingAi, startToggleAi] = useTransition();

  const allVisibleSelected = useMemo(
    () => groups.length > 0 && groups.every((g) => selected.has(g.id)),
    [groups, selected],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        groups.forEach((g) => next.delete(g.id));
        return next;
      }
      const next = new Set(prev);
      groups.forEach((g) => next.add(g.id));
      return next;
    });
  }

  async function confirmBulk() {
    if (!pendingAction) return;
    const enabled = pendingAction === "enable";
    setBusy(true);
    try {
      const result = await bulkSetMonitoring([...selected], enabled);
      setLastResult(result);
      setPendingAction(null);
      if (!result.error) {
        setSelected(new Set());
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function confirmSingleToggle() {
    if (!toggleTarget) return;
    const id = toggleTarget.id;
    startToggle(async () => {
      await toggleGroupMonitoring(id);
      setToggleTarget(null);
      router.refresh();
    });
  }

  function fetchParticipantCount(id: string) {
    setFetchingId(id);
    startFetchCount(async () => {
      await requestGroupParticipantCount(id);
      router.refresh();
    });
  }

  function toggleAiAutomation(id: string) {
    setTogglingAiId(id);
    startToggleAi(async () => {
      await toggleGroupAiAutomation(id);
      router.refresh();
    });
  }

  function toggleAiExcluded(id: string) {
    setTogglingAiId(id);
    startToggleAi(async () => {
      await toggleGroupAiExcluded(id);
      router.refresh();
    });
  }

  function buildKnowledge(id: string) {
    setTogglingAiId(id);
    startToggleAi(async () => {
      await requestGroupKnowledgeBuild(id);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            {selected.size} selected (of {groups.length} visible)
          </span>
          {pageSizeHrefs ? (
            <label className="flex items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)]">
              Show
              <Select
                className="h-7 w-20 py-0 text-xs"
                value={pageSize}
                onChange={(e) => {
                  const target = pageSizeHrefs.find((p) => p.size === Number(e.target.value));
                  if (target) router.push(target.href);
                }}
              >
                {pageSizeHrefs.map(({ size }) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("enable")}
          >
            Bulk Enable Monitoring
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingAction("disable")}
          >
            Bulk Disable Monitoring
          </Button>
        </div>
      </div>

      {lastResult ? (
        <div className="mb-3">
          <Alert
            tone={lastResult.error ? "danger" : "success"}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setLastResult(null)}>
                Dismiss
              </Button>
            }
          >
            {lastResult.error ? (
              lastResult.error
            ) : (
              <ul className="space-y-0.5">
                <li>{lastResult.updated} updated successfully</li>
                {lastResult.alreadyInTargetState > 0 ? (
                  <li>{lastResult.alreadyInTargetState} already in the requested state</li>
                ) : null}
                {lastResult.notFound > 0 ? (
                  <li>{lastResult.notFound} not found (may have been removed)</li>
                ) : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap font-normal normal-case">
                <Checkbox checked={allVisibleSelected} onChange={toggleAllVisible} />
                All visible
              </label>
            </Th>
            <Th>Group</Th>
            <Th>Account</Th>
            <Th>Monitored</Th>
            <Th>Status</Th>
            <Th>Participants</Th>
            <Th>Last Synced</Th>
            <Th>Priority Support</Th>
            <Th>AI Automation</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const staleMonitoring = g.isMonitored && !g.isActive;
            return (
              <tr key={g.id}>
                <Td>
                  <Checkbox checked={selected.has(g.id)} onChange={() => toggleOne(g.id)} />
                </Td>
                <Td>
                  <Tooltip content={g.whatsappGroupId}>
                    <span className="cursor-help underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2">
                      {g.name}
                    </span>
                  </Tooltip>
                </Td>
                <Td>{g.accountLabel}</Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <Badge color={g.isMonitored ? "green" : "gray"} dot>
                      {g.isMonitored ? "Monitored" : "Not Monitored"}
                    </Badge>
                    {staleMonitoring ? (
                      <Badge color="yellow">Inactive · still monitored</Badge>
                    ) : null}
                  </div>
                </Td>
                <Td>
                  <Badge color={g.isActive ? "blue" : "gray"} dot>
                    {g.isActive ? "Active" : "Inactive"}
                  </Badge>
                </Td>
                <Td>
                  {g.participantCount !== null ? (
                    <span className="tabular-nums">{g.participantCount}</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={isFetchingCount && fetchingId === g.id}
                      onClick={() => fetchParticipantCount(g.id)}
                    >
                      Fetch
                    </Button>
                  )}
                </Td>
                <Td>{g.lastSyncedAt ? new Date(g.lastSyncedAt).toLocaleString() : "—"}</Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    {g.priority ? (
                      <Badge color={g.priority === "P1" ? "red" : g.priority === "P2" ? "yellow" : "blue"} dot>
                        {g.priority}
                        {!g.escalationMonitoringEnabled ? " (paused)" : ""}
                      </Badge>
                    ) : (
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">Not monitored</span>
                    )}
                    {g.assignedTeamMemberName ? (
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">→ {g.assignedTeamMemberName}</span>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setPriorityTarget(g)}>
                      Configure
                    </Button>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    {/* An exclusion beats every other AI gate, so it is what the badge reports
                        when set — otherwise the row would claim "Enabled" for a group AI is
                        never allowed to answer in. */}
                    {g.aiAutomationExcluded ? (
                      <Tooltip content="AI will never answer in this group, whatever the global scope says.">
                        <Badge color="red" dot>
                          Excluded
                        </Badge>
                      </Tooltip>
                    ) : g.aiAutomationEnabled || g.aiScopeIsGlobal ? (
                      <Tooltip
                        content={
                          g.aiScopeIsGlobal && !g.aiAutomationEnabled
                            ? "Eligible because AI Settings is set to answer in every monitored group."
                            : "Switched on for this group."
                        }
                      >
                        <Badge color="green" dot>
                          {g.aiScopeIsGlobal && !g.aiAutomationEnabled ? "On (all groups)" : "Enabled"}
                        </Badge>
                      </Tooltip>
                    ) : (
                      <Badge color="gray" dot>
                        Disabled
                      </Badge>
                    )}

                    {!g.aiAutomationExcluded && g.aiSuppressedUntil && new Date(g.aiSuppressedUntil) > new Date() ? (
                      <Tooltip content="A team member sent a message recently — the AI fallback layer is paused for this group until then.">
                        <Badge color="yellow">Human active until {new Date(g.aiSuppressedUntil).toLocaleTimeString()}</Badge>
                      </Tooltip>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1">
                      {/* Hidden while excluded: the opt-in switch has no effect there, and
                          offering it would suggest otherwise. */}
                      {!g.aiAutomationExcluded ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={isTogglingAi && togglingAiId === g.id}
                          onClick={() => toggleAiAutomation(g.id)}
                        >
                          {g.aiAutomationEnabled ? "Disable AI" : "Enable AI"}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={isTogglingAi && togglingAiId === g.id}
                        onClick={() => toggleAiExcluded(g.id)}
                      >
                        {g.aiAutomationExcluded ? "Allow AI" : "Exclude"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={isTogglingAi && togglingAiId === g.id}
                        onClick={() => buildKnowledge(g.id)}
                        title="Read this group's stored conversation and distil it into knowledge entries"
                      >
                        Learn
                      </Button>
                    </div>

                    {/* Without this the Learn button looked like it did nothing: the build is
                        queued for the worker, so there is no immediate result to show — only
                        evidence that a run has happened. */}
                    <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                      {g.knowledgeBuiltAt
                        ? `Knowledge built ${new Date(g.knowledgeBuiltAt).toLocaleDateString()}`
                        : "Never learned from"}
                    </span>
                  </div>
                </Td>
                <Td>
                  <Button variant="secondary" size="sm" onClick={() => setToggleTarget(g)}>
                    {g.isMonitored ? "Stop Monitoring" : "Start Monitoring"}
                  </Button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {priorityTarget ? (
        <GroupPriorityDialog group={priorityTarget} teamMembers={teamMembers} onClose={() => setPriorityTarget(null)} />
      ) : null}

      <ConfirmDialog
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={confirmBulk}
        loading={busy}
        title={pendingAction === "enable" ? "Enable monitoring?" : "Disable monitoring?"}
        description={`This will ${pendingAction === "enable" ? "enable" : "disable"} monitoring for ${selected.size} group(s).`}
        confirmLabel={pendingAction === "enable" ? "Enable Monitoring" : "Disable Monitoring"}
      />

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={confirmSingleToggle}
        loading={isToggling}
        title={toggleTarget?.isMonitored ? "Stop monitoring this group?" : "Start monitoring this group?"}
        description={
          toggleTarget
            ? `${toggleTarget.isMonitored ? "Disable" : "Enable"} monitoring for "${toggleTarget.name}".`
            : undefined
        }
        confirmLabel={toggleTarget?.isMonitored ? "Stop Monitoring" : "Start Monitoring"}
      />
    </div>
  );
}
