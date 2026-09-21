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
import {
  SavedGroupSetBar,
  type SavedGroupSetOption,
} from "../group-message-sender/SavedGroupSetBar";

export interface AdderGroup {
  id: string;
  name: string;
  isMonitored: boolean;
  /** The chat inbox's own filing, reused rather than given a second parallel taxonomy — a group
   *  filed under "Premium" is Premium everywhere, which is the point of having filed it. */
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  isPinned: boolean;
}

export interface AdderAccount {
  id: string;
  label: string;
  status: string;
  groups: AdderGroup[];
}

const STEP_LABELS = ["Select Account", "Numbers & Groups", "Check Membership"];

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
  savedSets,
}: {
  accounts: AdderAccount[];
  teamMembers: AdderTeamMember[];
  maxPerJob: number;
  maxPerMinute: number;
  automationEnabled: boolean;
  savedSets: SavedGroupSetOption[];
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
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [selectionFilter, setSelectionFilter] = useState<"all" | "selected" | "unselected">("all");
  const [memberSearch, setMemberSearch] = useState("");
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

  /**
   * Filters compose rather than replace each other: category AND search AND selection-state all
   * narrow the same list at once.
   *
   * Name-substring was the only vocabulary here, which at 1,848 groups meant the fifty an operator
   * actually wants are reachable only if they happen to share a word in their name — and with the
   * box empty "Select all filtered" and "Select ALL groups" were the same button twice, which is
   * why this page read as having no filtered selection at all. Ported from Group Message Sender,
   * where the same problem was already solved.
   */
  const filteredGroups = useMemo(() => {
    let groups = account?.groups ?? [];

    if (categoryFilter === "__pinned__") groups = groups.filter((g) => g.isPinned);
    else if (categoryFilter === "__none__") groups = groups.filter((g) => !g.categoryId);
    else if (categoryFilter === "__monitored__") groups = groups.filter((g) => g.isMonitored);
    else if (categoryFilter) groups = groups.filter((g) => g.categoryId === categoryFilter);

    if (selectionFilter === "selected") groups = groups.filter((g) => selected.has(g.id));
    else if (selectionFilter === "unselected") groups = groups.filter((g) => !selected.has(g.id));

    const q = search.trim().toLowerCase();
    if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q));

    // Pinned first inside whatever survived, so groups somebody marked as important stay reachable
    // without scrolling a filtered list of four hundred.
    return [...groups].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return 0;
    });
  }, [account, search, categoryFilter, selectionFilter, selected]);

  /** Categories present on this account's groups, with live counts. */
  const categories = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; count: number }>();
    for (const g of account?.groups ?? []) {
      if (!g.categoryId || !g.categoryName) continue;
      const existing = byId.get(g.categoryId);
      if (existing) existing.count += 1;
      else byId.set(g.categoryId, { id: g.categoryId, name: g.categoryName, count: 1 });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [account]);

  const pinnedCount = useMemo(() => (account?.groups ?? []).filter((g) => g.isPinned).length, [account]);
  const monitoredCount = useMemo(() => (account?.groups ?? []).filter((g) => g.isMonitored).length, [account]);
  const filtersActive = Boolean(search || categoryFilter) || selectionFilter !== "all";

  /** The roster gets a search too — it is several hundred people once LID import has run. */
  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return teamMembers;
    return teamMembers.filter(
      (m) => m.name.toLowerCase().includes(q) || m.phoneNumber.includes(q) || m.role.toLowerCase().includes(q),
    );
  }, [teamMembers, memberSearch]);

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

  /**
   * `add` and `remove` rather than a single toggle: at this scale they are different intentions.
   * "Add the Premium ones to what I have" and "take the Premium ones back out" are both things
   * people mean, and a toggle over three hundred rows does neither predictably.
   */
  function applyToGroups(groups: AdderGroup[], mode: "add" | "remove") {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of groups) {
        if (mode === "remove") next.delete(g.id);
        else next.set(g.id, g.name);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    applyToGroups(filteredGroups, "add");
  }

  /**
   * Invert within what is currently filtered, never across the whole account — inverting 1,848
   * groups because somebody searched "Dhaka" and pressed the wrong button is the most expensive
   * mistake available on this screen, and every add is a ban signal.
   */
  function invertFiltered() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const g of filteredGroups) {
        if (next.has(g.id)) next.delete(g.id);
        else next.set(g.id, g.name);
      }
      return next;
    });
  }

  function clearFilters() {
    setSearch("");
    setCategoryFilter("");
    setSelectionFilter("all");
  }

  function clearSelection() {
    setSelected(new Map());
  }

  function removeTarget(groupId: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
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
                <Input
                  placeholder="Search name, role or number…"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  className="h-8 max-w-56 text-[12px]"
                />
                {/* Scoped to the filtered list, not the whole roster — the same "filter, then act
                    on exactly that" gesture the group picker below uses. */}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={filteredMembers.length === 0}
                  onClick={() =>
                    setSelectedMemberIds((prev) => {
                      const next = new Set(prev);
                      const allPicked = filteredMembers.every((m) => next.has(m.id));
                      for (const member of filteredMembers) {
                        if (allPicked) next.delete(member.id);
                        else next.add(member.id);
                      }
                      return next;
                    })
                  }
                >
                  {filteredMembers.length > 0 && filteredMembers.every((m) => selectedMemberIds.has(m.id))
                    ? `Deselect these (${filteredMembers.length})`
                    : `Select all (${filteredMembers.length})`}
                </Button>
                {selectedMemberIds.size > 0 ? (
                  <span className="tabular text-xs text-[color:var(--color-muted-foreground)]">
                    {selectedMemberIds.size} picked
                  </span>
                ) : null}
              </div>
              <div className="max-h-56 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
                {filteredMembers.length === 0 ? (
                  <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">
                    Nobody matches “{memberSearch}”.
                  </p>
                ) : null}
                {filteredMembers.map((member) => (
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
            {/* Filters first, then the actions that operate on what they left. Reading the row top
                to bottom is the order the work happens in: narrow, then act. */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search groups by name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
              />

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label="Filter by category"
                className="h-8 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[color:var(--color-foreground)] outline-none focus-visible:border-[var(--color-primary)]"
              >
                <option value="">All categories</option>
                {monitoredCount > 0 ? <option value="__monitored__">Monitored ({monitoredCount})</option> : null}
                {pinnedCount > 0 ? <option value="__pinned__">Pinned ({pinnedCount})</option> : null}
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name} ({category.count})
                  </option>
                ))}
                <option value="__none__">Uncategorised</option>
              </select>

              <select
                value={selectionFilter}
                onChange={(e) => setSelectionFilter(e.target.value as "all" | "selected" | "unselected")}
                aria-label="Filter by selection state"
                className="h-8 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[color:var(--color-foreground)] outline-none focus-visible:border-[var(--color-primary)]"
              >
                <option value="all">Selected or not</option>
                <option value="selected">Selected only</option>
                <option value="unselected">Not selected</option>
              </select>

              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={selectAllFiltered} disabled={filteredGroups.length === 0}>
                Select all {filteredGroups.length.toLocaleString()}
              </Button>
              {/* Removes only what the filters currently show, so taking one category back out does
                  not discard an unrelated selection made five minutes ago. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => applyToGroups(filteredGroups, "remove")}
                disabled={filteredGroups.length === 0}
              >
                Deselect these
              </Button>
              <Button variant="secondary" size="sm" onClick={invertFiltered} disabled={filteredGroups.length === 0}>
                Invert
              </Button>
              {selected.size > 0 ? (
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  Clear all ({selected.size.toLocaleString()})
                </Button>
              ) : null}
              <span className="ml-auto tabular text-xs text-[color:var(--color-muted-foreground)]">
                {selected.size.toLocaleString()} selected
              </span>
            </div>

            {/* Re-picking the same three hundred groups for every new hire is the recurring job on
                this page, more so than on the sender this was built for. */}
            <SavedGroupSetBar
              accountId={accountId}
              selectedIds={[...selected.keys()]}
              savedSets={savedSets}
              onLoad={(ids) => {
                const byId = new Map((account?.groups ?? []).map((g) => [g.id, g]));
                applyToGroups(
                  ids.map((id) => byId.get(id)).filter((g): g is AdderGroup => Boolean(g)),
                  "add",
                );
              }}
            />
            <div className="max-h-80 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {filteredGroups.length === 0 ? (
                <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">
                  No groups match these filters.{" "}
                  {filtersActive ? (
                    <button type="button" onClick={clearFilters} className="link cursor-pointer">
                      Clear them
                    </button>
                  ) : null}
                </p>
              ) : (
                filteredGroups.map((g) => (
                  <label
                    key={g.id}
                    className="flex cursor-pointer items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--color-neutral-bg)]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Checkbox checked={selected.has(g.id)} onChange={() => toggleGroup(g)} />
                      <span className="truncate">{g.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {g.categoryName ? <Badge color="gray">{g.categoryName}</Badge> : null}
                      {g.isMonitored ? <Badge color="blue">Monitored</Badge> : null}
                    </span>
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
            title={`Check ${totalAdds.toLocaleString()} number/group combination${totalAdds === 1 ? "" : "s"}`}
            description={`${phoneNumbers.length} number${phoneNumbers.length === 1 ? "" : "s"} × ${targets.length.toLocaleString()} group${targets.length === 1 ? "" : "s"}. Nothing is added yet — each group's member list is read first, and you choose what to add from the results.`}
          />
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Account" value={account?.label ?? ""} />
            <StatTile label="Numbers" value={phoneNumbers.length} />
            <StatTile label="Target groups" value={targets.length.toLocaleString()} />
            <StatTile
              label="To check"
              value={totalAdds.toLocaleString()}
              tone={overLimit ? "danger" : "neutral"}
              // The estimate belongs to the ADD phase, which only some of these will reach. Reading
              // rosters is fast and unmetered, so quoting a day-long figure for the check would be
              // wrong in the alarming direction.
              hint={`up to ${estimatedDuration} if all are added`}
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
            <Alert tone="info" title="This reads member lists first — it adds nobody">
              Each group&apos;s current members are read so you can see who is already in and who is not.
              You then pick what to add, and only that is queued — at {maxPerMinute} add
              {maxPerMinute === 1 ? "" : "s"} per minute across every job, because adding participants is
              the strongest ban signal WhatsApp reacts to. Checking is fast and costs none of that budget.
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
          {/* Per-row removal, because dropping three of 1,848 at the last moment otherwise means
              going back a step and hunting for them in the picker. */}
          <div className="max-h-64 overflow-y-auto">
            <Table>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.groupId}>
                    <Td className="font-medium">{t.groupName}</Td>
                    <Td className="w-px text-right">
                      <Button variant="ghost" size="sm" onClick={() => removeTarget(t.groupId)}>
                        Remove
                      </Button>
                    </Td>
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
            Check Membership
          </Button>
        )}
      </div>

      {/* Deliberately a light confirmation: this step adds nobody. The heavy one — naming the
          people, the groups and the fact that it is a real WhatsApp action — lives on the review
          screen, where the decision that actually sends something is made. */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        loading={confirming}
        title={`Check ${totalAdds.toLocaleString()} combination${totalAdds === 1 ? "" : "s"}?`}
        description={
          automationEnabled
            ? "Reads each group's member list so you can see who is genuinely missing. Nobody is added until you review the results and confirm."
            : "Automation is paused. The check still runs — it only reads — but nothing can be added until the kill switch is turned back on."
        }
        confirmLabel="Start Check"
      />
    </div>
  );
}
