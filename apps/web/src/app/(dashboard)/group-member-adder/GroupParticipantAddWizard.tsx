"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Unplug } from "lucide-react";
import { normalizePhoneNumber } from "@support-automation/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldError,
  Input,
  SectionHeader,
  Select,
  StatTile,
  StepIndicator,
  Table,
  Td,
  Textarea,
} from "@/components/ui";
import { createGroupParticipantAddJob } from "@/server/actions/groupParticipantAdd";

export interface AdderGroup {
  id: string;
  name: string;
  isMonitored: boolean;
}

export interface AdderAccount {
  id: string;
  label: string;
  status: string;
  groups: AdderGroup[];
}

const STEP_LABELS = ["Select Account", "Numbers & Groups", "Review & Confirm"];

/** A roster member who can actually be added — see `reachable` on the page for what excludes one. */
export interface AdderTeamMember {
  id: string;
  name: string;
  phoneNumber: string;
  role: string;
}

export function GroupParticipantAddWizard({
  accounts,
  teamMembers,
  maxPerJob,
  maxPerMinute,
  automationEnabled,
}: {
  accounts: AdderAccount[];
  teamMembers: AdderTeamMember[];
  maxPerJob: number;
  maxPerMinute: number;
  automationEnabled: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  // Two ways in, because both are real: adding the support roster to new groups is a pick-list
  // job, and adding a number nobody has onboarded yet is a typing job. Kept as separate inputs
  // rather than one combined box so picking a colleague cannot be undone by a stray keystroke.
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [extraNumbers, setExtraNumbers] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;

  // Anything separated by a newline, comma or space. People paste from a spreadsheet, a chat
  // message or their own notes, and rejecting a list because it used the wrong separator is a
  // pointless thing to make somebody fix by hand.
  const typedNumbers = useMemo(
    () => extraNumbers.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean),
    [extraNumbers],
  );
  const invalidTyped = useMemo(
    () => typedNumbers.filter((entry) => !normalizePhoneNumber(entry)),
    [typedNumbers],
  );

  const phoneNumbers = useMemo(() => {
    const out: string[] = [];
    for (const member of teamMembers) {
      if (!selectedMemberIds.has(member.id)) continue;
      const normalized = normalizePhoneNumber(member.phoneNumber);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    for (const entry of typedNumbers) {
      const normalized = normalizePhoneNumber(entry);
      // Deduped against the picked members too: a number typed by hand that turns out to be a
      // colleague already ticked would otherwise be queued twice, added once, and reported failed.
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return out;
  }, [teamMembers, selectedMemberIds, typedNumbers]);

  const filteredGroups = useMemo(() => {
    const groups = account?.groups ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [account, search]);

  const targets = useMemo(
    () => [...selected.entries()].map(([groupId, groupName]) => ({ groupId, groupName })),
    [selected],
  );
  // The unit that matters is adds, not groups: 5 people across 500 groups is 2,500 of them.
  const totalAdds = targets.length * phoneNumbers.length;
  const overLimit = totalAdds > maxPerJob;
  const estimatedDuration = useMemo(() => {
    if (totalAdds === 0 || maxPerMinute <= 0) return "—";
    const minutes = Math.ceil(totalAdds / maxPerMinute);
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = minutes / 60;
    if (hours < 24) return `about ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
    return `about ${(hours / 24).toFixed(1)} days`;
  }, [totalAdds, maxPerMinute]);

  function toggleGroup(g: AdderGroup) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(g.id)) next.delete(g.id);
      else next.set(g.id, g.name);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of filteredGroups) next.set(g.id, g.name);
      return next;
    });
  }

  function selectAllGroups() {
    const next = new Map<string, string>();
    for (const g of account?.groups ?? []) next.set(g.id, g.name);
    setSelected(next);
  }

  function clearSelection() {
    setSelected(new Map());
  }

  async function handleConfirm() {
    if (!account) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await createGroupParticipantAddJob({
        accountId: account.id,
        phoneNumbers,
        targets,
      });
      if (result.error) {
        setError(result.error);
        setConfirming(false);
        setConfirmOpen(false);
        return;
      }
      router.push(`/group-member-adder/jobs/${result.jobId}`);
    } catch {
      setError("Failed to create the job. Please try again.");
      setConfirming(false);
      setConfirmOpen(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Unplug className="size-5" aria-hidden />}>
          No connected WhatsApp account is available. Connect an account on the Accounts page first.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!automationEnabled ? (
        <Alert tone="warning" title="Automation is currently PAUSED (kill switch)">
          You can prepare a job, but nothing will be added until it is resumed on the Automation Control page.
        </Alert>
      ) : null}

      <StepIndicator steps={STEP_LABELS} currentStep={step} />

      <div key={step} className="animate-fade-in-rise space-y-6">
      {step === 1 ? (
        <Card>
          <SectionHeader title="WhatsApp Account" />
          <Select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              clearSelection();
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.status}) — {a.groups.length} synchronized group(s)
              </option>
            ))}
          </Select>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <SectionHeader
            title="Who to add"
            description="Pick from your team, type numbers, or both. Everyone chosen is added to every group you select below."
          />

          {teamMembers.length > 0 ? (
            <div className="mb-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-[color:var(--color-foreground)]">
                  Team members
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelectedMemberIds((prev) =>
                      prev.size === teamMembers.length ? new Set() : new Set(teamMembers.map((m) => m.id)),
                    )
                  }
                >
                  {selectedMemberIds.size === teamMembers.length ? "Clear all" : `Select all (${teamMembers.length})`}
                </Button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
                {teamMembers.map((member) => (
                  <label
                    key={member.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2 last:border-b-0 hover:bg-[color:var(--color-muted)]"
                  >
                    <Checkbox
                      checked={selectedMemberIds.has(member.id)}
                      onChange={() =>
                        setSelectedMemberIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(member.id)) next.delete(member.id);
                          else next.add(member.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      <span className="font-medium text-[color:var(--color-foreground)]">{member.name}</span>
                      <span className="ml-2 text-[color:var(--color-muted-foreground)]">{member.role}</span>
                    </span>
                    <span className="tabular text-[13px] text-[color:var(--color-muted-foreground)]">
                      {member.phoneNumber}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <Field
            label="Other numbers"
            hint="One per line, or separated by commas. Country code, digits only — no leading + needed."
          >
            <Textarea
              value={extraNumbers}
              onChange={(e) => setExtraNumbers(e.target.value)}
              placeholder={"8801XXXXXXXXX\n8801YYYYYYYYY"}
              rows={3}
            />
          </Field>
          {invalidTyped.length > 0 ? (
            <FieldError>
              Not a valid number: {invalidTyped.slice(0, 3).join(", ")}
              {invalidTyped.length > 3 ? ` and ${invalidTyped.length - 3} more` : ""}.
            </FieldError>
          ) : null}
          {phoneNumbers.length > 0 ? (
            <p className="mt-2 text-[13px] text-[color:var(--color-muted-foreground)]">
              {phoneNumbers.length} number{phoneNumbers.length === 1 ? "" : "s"} to add.
            </p>
          ) : null}

          <div className="mt-6 border-t border-[var(--color-border)] pt-6">
            <SectionHeader title="Target Groups" />
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search groups by name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-sm"
              />
              <Button variant="secondary" size="sm" onClick={selectAllFiltered}>
                Select all filtered ({filteredGroups.length})
              </Button>
              <Button variant="secondary" size="sm" onClick={selectAllGroups}>
                Select ALL groups ({account?.groups.length ?? 0})
              </Button>
              {selected.size > 0 ? (
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  Clear selection
                </Button>
              ) : null}
              <span className="text-xs text-[color:var(--color-muted-foreground)]">{selected.size} selected</span>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {filteredGroups.length === 0 ? (
                <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">No groups match your search.</p>
              ) : (
                filteredGroups.map((g) => (
                  <label
                    key={g.id}
                    className="flex cursor-pointer items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--color-neutral-bg)]"
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox checked={selected.has(g.id)} onChange={() => toggleGroup(g)} />
                      {g.name}
                    </span>
                    {g.isMonitored ? <Badge color="blue">Monitored</Badge> : null}
                  </label>
                ))
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <SectionHeader
            title={`Review — ${totalAdds.toLocaleString()} add${totalAdds === 1 ? "" : "s"}`}
            description={`${phoneNumbers.length} number${phoneNumbers.length === 1 ? "" : "s"} × ${targets.length.toLocaleString()} group${targets.length === 1 ? "" : "s"}. Anyone already in a group is skipped without an add being attempted.`}
          />
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Account" value={account?.label ?? ""} />
            <StatTile label="Numbers" value={phoneNumbers.length} />
            <StatTile label="Target groups" value={targets.length.toLocaleString()} />
            <StatTile
              label="Total adds"
              value={totalAdds.toLocaleString()}
              tone={overLimit ? "danger" : "neutral"}
              // The honest expectation. At three per minute a full 2,000-add job runs for most of
              // a day, and an operator who thinks it stalled will start a second one.
              hint={estimatedDuration}
            />
          </div>
          {overLimit ? (
            <div className="mb-3">
              <Alert tone="danger">
                {totalAdds.toLocaleString()} adds exceeds the maximum of {maxPerJob.toLocaleString()} per job. Select
                fewer numbers or groups, or raise the limit on Sending Limits.
              </Alert>
            </div>
          ) : null}
          <div className="mb-3">
            <Alert tone="info">
              This runs at {maxPerMinute} add{maxPerMinute === 1 ? "" : "s"} per minute across every job, so it will
              take {estimatedDuration} and keep going on its own — leave the page, it does not need watching. Adding
              participants is the strongest ban signal WhatsApp reacts to, which is why it is paced this way.
            </Alert>
          </div>
          {!automationEnabled ? (
            <div className="mb-3">
              <Alert tone="warning">
                Automation is paused — this job will queue but nothing will be added until the kill switch is turned
                back on.
              </Alert>
            </div>
          ) : null}
          <div className="max-h-64 overflow-y-auto">
            <Table>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.groupId}>
                    <Td className="font-medium">{t.groupName}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      ) : null}
      </div>

      {error ? (
        <Alert tone="danger" title="Could not queue this job">
          {error}
        </Alert>
      ) : null}

      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
          Back
        </Button>
        {step < 3 ? (
          <Button
            disabled={step === 2 && (targets.length === 0 || phoneNumbers.length === 0 || invalidTyped.length > 0)}
            onClick={() => setStep((s) => Math.min(3, s + 1))}
          >
            Next
          </Button>
        ) : (
          <Button disabled={targets.length === 0 || phoneNumbers.length === 0 || overLimit || invalidTyped.length > 0} onClick={() => setConfirmOpen(true)}>
            Confirm &amp; Queue
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        loading={confirming}
        title={`Add ${phoneNumbers.length} number${phoneNumbers.length === 1 ? "" : "s"} to ${targets.length.toLocaleString()} group${targets.length === 1 ? "" : "s"}?`}
        description={
          automationEnabled
            ? "This queues the add-to-group requests for gradual processing by the worker."
            : "Automation is paused — this will queue the job, but nothing runs until the kill switch is turned back on."
        }
        confirmLabel="Confirm & Queue"
      />
    </div>
  );
}
