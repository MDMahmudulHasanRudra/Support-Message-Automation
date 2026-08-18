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

const STEP_LABELS = ["Select Account", "Number & Groups", "Review & Confirm"];

export function GroupParticipantAddWizard({
  accounts,
  maxPerJob,
  automationEnabled,
}: {
  accounts: AdderAccount[];
  maxPerJob: number;
  automationEnabled: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

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
  const overLimit = targets.length > maxPerJob;

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
        phoneNumber,
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
          <SectionHeader title="Phone Number" />
          <Field label="Number to add" hint="Include the country code, digits only (e.g. 8801XXXXXXXXX). No leading + needed.">
            <Input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="e.g. 8801XXXXXXXXX"
            />
          </Field>
          {phoneNumber.trim() && !normalizedPhone ? (
            <FieldError>That doesn&apos;t look like a valid phone number.</FieldError>
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
          <SectionHeader title={`Review (${targets.length} group(s))`} />
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Account" value={account?.label ?? ""} />
            <StatTile label="Phone number" value={normalizedPhone ?? phoneNumber} />
            <StatTile label="Target groups" value={targets.length} tone={overLimit ? "danger" : "neutral"} />
            <StatTile label="Estimated queue size" value={targets.length} />
          </div>
          {overLimit ? (
            <div className="mb-3">
              <Alert tone="danger">
                {targets.length} groups exceeds the configured maximum of {maxPerJob} per job. Remove some groups or
                raise the limit in Settings before confirming.
              </Alert>
            </div>
          ) : null}
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
            disabled={step === 2 && (targets.length === 0 || !normalizedPhone)}
            onClick={() => setStep((s) => Math.min(3, s + 1))}
          >
            Next
          </Button>
        ) : (
          <Button disabled={targets.length === 0 || overLimit || !normalizedPhone} onClick={() => setConfirmOpen(true)}>
            Confirm &amp; Queue
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        loading={confirming}
        title={`Add ${normalizedPhone ?? phoneNumber} to ${targets.length} group(s)?`}
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
