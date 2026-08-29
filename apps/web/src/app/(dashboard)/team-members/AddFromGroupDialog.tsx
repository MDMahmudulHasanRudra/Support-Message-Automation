"use client";

import { UserPlus, Users } from "lucide-react";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  useToast,
} from "@/components/ui";
import {
  addTeamMembersFromGroup,
  getGroupParticipantCandidates,
  readGroupParticipants,
  requestGroupParticipants,
  type AddFromGroupState,
  type GroupParticipantCandidate,
} from "@/server/actions/teamMembers";

const INITIAL: AddFromGroupState = {};

export interface GroupOption {
  id: string;
  name: string;
}

/**
 * Adds support members by picking them out of a group instead of typing numbers.
 *
 * The phone number is the exact key the whole system matches team members on, so a typo does not
 * fail loudly — it silently classifies a colleague as a customer, which can auto-reply to your own
 * staff. Every number offered here came from a message WhatsApp actually delivered, so it cannot
 * be mistyped.
 */
export function AddFromGroupDialog({ groups }: { groups: GroupOption[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [candidates, setCandidates] = useState<GroupParticipantCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, startLoading] = useTransition();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(addTeamMembersFromGroup, INITIAL);

  useEffect(() => {
    if (state.addedCount === undefined) return;
    showToast({
      tone: "success",
      title: `${state.addedCount} member${state.addedCount === 1 ? "" : "s"} added`,
      description:
        state.addedCount === 0 ? "Everyone selected was already on the roster." : undefined,
    });
    // Deferred via a microtask (fires before the next paint, so no visible delay) rather than
    // called directly in the effect body — the convention already used in DashboardShell and
    // Dialog, and what react-hooks/set-state-in-effect asks for.
    queueMicrotask(() => {
      setOpen(false);
      setSelected(new Set());
      setCandidates(null);
      setGroupId("");
    });
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  function loadCandidates(nextGroupId: string) {
    setGroupId(nextGroupId);
    setSelected(new Set());
    setCandidates(null);
    setFetchError(null);
    if (!nextGroupId) return;
    startLoading(async () => {
      setCandidates(await getGroupParticipantCandidates(nextGroupId));
    });
  }

  /**
   * Asks WhatsApp itself who is in the group, for the case message history cannot answer: a
   * quiet group, or one being set up before any traffic exists. The worker does the fetching,
   * so this polls for the answer rather than blocking on it.
   */
  function fetchFromWhatsApp() {
    if (!groupId) return;
    setFetching(true);
    setFetchError(null);
    void (async () => {
      try {
        await requestGroupParticipants(groupId);
        // Roughly 30s of polling. Reading a roster is one WhatsApp round trip, so anything
        // slower than this means the session is unhealthy rather than merely busy.
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const state = await readGroupParticipants(groupId);
          if (state.status === "READY") {
            setCandidates(state.participants);
            setSelected(new Set());
            return;
          }
          if (state.status === "FAILED") {
            setFetchError(state.error ?? "Could not read this group's members.");
            return;
          }
        }
        setFetchError("The worker did not answer in time. Check that the WhatsApp account is connected.");
      } finally {
        setFetching(false);
      }
    })();
  }

  function toggle(value: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <UserPlus className="size-3.5" aria-hidden />
        Add from a group
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add support members from a group"
        description="Pick a group, then choose the people who work support in it. Their numbers come straight from WhatsApp, so nothing has to be typed."
        size="lg"
      >
        <form action={formAction} className="space-y-4">
          <Field label="Group">
            <Select value={groupId} onChange={(event) => loadCandidates(event.target.value)}>
              <option value="">Select a group…</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>

          {groupId ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" onClick={fetchFromWhatsApp} loading={fetching}>
                <Users className="size-3.5" aria-hidden />
                Load members from WhatsApp
              </Button>
              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                Reads the group&apos;s actual member list, including people who have never messaged.
              </span>
            </div>
          ) : null}

          {fetchError ? <Alert tone="danger">{fetchError}</Alert> : null}

          {loading || fetching ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              {fetching ? "Asking WhatsApp for the member list…" : "Loading people…"}
            </p>
          ) : null}

          {candidates !== null && !loading && !fetching ? (
            candidates.length === 0 ? (
              <Alert tone="info">
                Nobody new to add from message history — either everyone who has spoken here is
                already on the roster, or nobody has messaged since this app started watching. Use{" "}
                <strong>Load members from WhatsApp</strong> to read the group&apos;s actual member
                list instead.
              </Alert>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {candidates.length} {candidates.length === 1 ? "person" : "people"} not yet on the roster
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSelected((current) =>
                        current.size === candidates.length
                          ? new Set()
                          : new Set(candidates.map((c) => `${c.phoneNumber}|${c.suggestedName ?? ""}`)),
                      )
                    }
                  >
                    {selected.size === candidates.length ? "Clear all" : "Select all"}
                  </Button>
                </div>
              <div className="max-h-72 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)]">
                {candidates.map((candidate) => {
                  const value = `${candidate.phoneNumber}|${candidate.suggestedName ?? ""}`;
                  return (
                    <label
                      key={candidate.phoneNumber}
                      className="flex cursor-pointer items-center gap-3 border-b border-[var(--color-border)] px-3 py-2.5 last:border-b-0 hover:bg-[var(--color-neutral-bg)]/60"
                    >
                      <Checkbox
                        name="selected"
                        value={value}
                        checked={selected.has(value)}
                        onChange={() => toggle(value)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[color:var(--color-foreground)]">
                          {candidate.suggestedName ?? "(no WhatsApp name)"}
                        </span>
                        <span className="block truncate font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--color-muted-foreground)]">
                          {candidate.phoneNumber}
                        </span>
                      </span>
                      {candidate.messageCount > 0 ? (
                        <span className="tabular shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
                          {candidate.messageCount} msg
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              </>
            )
          ) : null}

          {selected.size > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Role" hint="Applied to everyone selected. Edit individually later.">
                  <Input name="role" defaultValue="Support" required />
                </Field>
                <Field label="Department" hint="Optional.">
                  <Input name="department" placeholder="e.g. Retail" />
                </Field>
              </div>

              <Alert tone="warning">
                Adding someone here changes how the system reads their messages: they stop being
                treated as a customer, so automation and escalation no longer fire on what they
                write. Only add your own staff.
              </Alert>
            </>
          ) : null}

          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={selected.size === 0}>
              {selected.size === 0
                ? "Add selected"
                : `Add ${selected.size} member${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
