"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import {
  Alert,
  Badge,
  type BadgeColor,
  Button,
  Checkbox,
  ConfirmDialog,
  Table,
  Td,
  Th,
  Tooltip,
} from "@/components/ui";
import {
  confirmParticipantAddSelection,
  type ConfirmParticipantAddResult,
} from "@/server/actions/groupParticipantAdd";

export interface ReviewRow {
  id: string;
  phoneNumber: string;
  groupName: string;
  status: string;
  reason: string | null;
}

/** Only these can be chosen. Everything else is a settled answer, not a decision to make. */
const SELECTABLE = new Set(["READY", "CANNOT_VERIFY"]);

/**
 * The screen between knowing and doing.
 *
 * Its whole purpose is that nothing on it has happened yet: every row is a (number, group) pair
 * whose membership has been read from WhatsApp, and the add only occurs for what a person ticks.
 * Rows that are already members, invalid, or blocked are shown but not selectable — an operator
 * cannot accidentally spend an add on an answer the system already has.
 */
export function MembershipReview({ jobId, rows }: { jobId: string; rows: ReviewRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(
    // Pre-ticked to the confidently-eligible ones only. CANNOT_VERIFY is left off on purpose: it
    // means we could not prove the person is absent, so including it by default would make the
    // cautious case the silent default.
    () => new Set(rows.filter((row) => row.status === "READY").map((row) => row.id)),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConfirmParticipantAddResult | null>(null);

  const selectable = useMemo(() => rows.filter((row) => SELECTABLE.has(row.status)), [rows]);
  const readyRows = useMemo(() => rows.filter((row) => row.status === "READY"), [rows]);
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.id));

  const groupCount = useMemo(
    () => new Set(rows.filter((row) => selected.has(row.id)).map((row) => row.groupName)).size,
    [rows, selected],
  );
  const peopleCount = useMemo(
    () => new Set(rows.filter((row) => selected.has(row.id)).map((row) => row.phoneNumber)).size,
    [rows, selected],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllSelectable() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.id)));
  }

  async function confirm() {
    setBusy(true);
    try {
      const outcome = await confirmParticipantAddSelection(jobId, [...selected]);
      setResult(outcome);
      setConfirming(false);
      if (!outcome.error) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sticky top-0 z-20 mb-3 -mx-5 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[color:var(--color-foreground)]">
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && selectable.some((row) => selected.has(row.id))}
            onChange={toggleAllSelectable}
            disabled={selectable.length === 0}
            aria-label="Select every eligible entry"
          />
          Select all eligible ({selectable.length})
        </label>
        {readyRows.length !== selectable.length ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set(readyRows.map((row) => row.id)))}
          >
            Only the {readyRows.length} confirmed
          </Button>
        ) : null}
        <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
          {selected.size} selected
        </span>
        <div className="ml-auto">
          <Button disabled={busy || selected.size === 0} onClick={() => setConfirming(true)}>
            <UserPlus className="size-3.5" aria-hidden />
            Add Selected ({selected.size})
          </Button>
        </div>
      </div>

      {result ? (
        <div className="mb-3">
          <Alert
            tone={result.error ? "danger" : "success"}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Dismiss
              </Button>
            }
          >
            {result.error ? (
              result.error
            ) : (
              <ul className="space-y-0.5">
                <li>{result.queued} queued for adding</li>
                {result.skipped ? (
                  <li>{result.skipped} skipped — no longer eligible when the request ran</li>
                ) : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>{null}</Th>
            <Th>Number</Th>
            <Th>Group</Th>
            <Th>Status</Th>
            <Th>Details</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const canSelect = SELECTABLE.has(row.status);
            return (
              <tr key={row.id}>
                <Td>
                  {canSelect ? (
                    <Checkbox
                      checked={selected.has(row.id)}
                      onChange={() => toggleOne(row.id)}
                      aria-label={`Select ${row.phoneNumber} for ${row.groupName}`}
                    />
                  ) : (
                    /* Not a disabled checkbox: there is no decision here to disable. A dash says
                       "this row is an answer", which a greyed tickbox does not. */
                    <span className="text-[color:var(--color-muted-foreground)]">—</span>
                  )}
                </Td>
                <Td className="tabular whitespace-nowrap">{row.phoneNumber}</Td>
                <Td className="max-w-xs truncate">{row.groupName}</Td>
                <Td>
                  <Badge color={reviewStatusColor(row.status)} dot>
                    {REVIEW_STATUS_LABEL[row.status] ?? row.status}
                  </Badge>
                </Td>
                <Td className="max-w-md">
                  {row.reason ? (
                    <Tooltip content={row.reason}>
                      <span className="block truncate text-[13px] text-[color:var(--color-muted-foreground)]">
                        {row.reason}
                      </span>
                    </Tooltip>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        loading={busy}
        title={`Add ${peopleCount} ${peopleCount === 1 ? "person" : "people"} to ${groupCount} ${groupCount === 1 ? "group" : "groups"}?`}
        /* Says plainly that this is the real thing, and names the one safeguard that still runs
           at send time — a person who joined since the check is skipped, not added twice. */
        description={`This queues ${selected.size} real WhatsApp add${selected.size === 1 ? "" : "s"}. Anyone who has joined since the check will be skipped automatically rather than added again.`}
        confirmLabel="Add Selected"
      />
    </div>
  );
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
  READY: "Ready to add",
  CANNOT_VERIFY: "Cannot confirm",
  ALREADY_MEMBER: "Already member",
  INVALID_NUMBER: "Invalid",
  NOT_ON_WHATSAPP: "Not on WhatsApp",
  NO_PERMISSION: "No permission",
  GROUP_UNAVAILABLE: "Group unavailable",
  CHECK_FAILED: "Check failed",
  NOT_SELECTED: "Not selected",
};

function reviewStatusColor(status: string): BadgeColor {
  if (status === "READY") return "green";
  if (status === "ALREADY_MEMBER") return "blue";
  if (status === "CANNOT_VERIFY") return "yellow";
  if (status === "INVALID_NUMBER" || status === "NOT_ON_WHATSAPP" || status === "NO_PERMISSION") return "red";
  return "gray";
}
