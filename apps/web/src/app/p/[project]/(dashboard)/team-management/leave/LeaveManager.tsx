"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Th,
  Textarea,
  useToast,
} from "@/components/ui";
import type { BadgeColor } from "@/components/ui";
import { cancelLeaveRequest, createLeaveRequest, decideLeaveRequest } from "@/server/actions/teamManagement";
import type { LeaveRequestRow } from "@/server/teamManagementReports";

const STATUS_COLOR: Record<LeaveRequestRow["status"], BadgeColor> = {
  REQUESTED: "yellow",
  APPROVED: "green",
  REJECTED: "gray",
  CANCELLED: "gray",
};

/**
 * Leave requests, and deciding them.
 *
 * The consequence worth stating on screen, because it is not obvious and it is the whole design:
 * approving leave **keeps** the duty rows that already existed and marks them LEAVE. The plan
 * survives, which is what lets the coverage report say "Morning needs 2, has 2 assigned, 1 on
 * leave, short by 1" rather than simply showing an empty shift with no explanation.
 */
export function LeaveManager({
  requests,
  members,
  leaveTypes,
  canManage,
}: {
  requests: LeaveRequestRow[];
  members: { id: string; name: string }[];
  leaveTypes: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<{ row: LeaveRequestRow; decision: "APPROVED" | "REJECTED" } | null>(null);
  const [cancelling, setCancelling] = useState<LeaveRequestRow | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      const result = await createLeaveRequest(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCreating(false);
      setError(null);
      showToast({ tone: "success", title: "Leave request created" });
    });
  }

  function handleDecide() {
    if (!deciding) return;
    const { row, decision } = deciding;
    startTransition(async () => {
      const result = await decideLeaveRequest(row.id, decision, note.trim() || null);
      setDeciding(null);
      setNote("");
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: decision === "APPROVED" ? `Leave approved for ${row.memberName}` : "Leave rejected",
        description:
          decision === "APPROVED"
            ? "Their duty rows now read LEAVE and still show the shift they were on, so coverage reports the gap."
            : undefined,
      });
    });
  }

  function handleCancel() {
    if (!cancelling) return;
    const row = cancelling;
    startTransition(async () => {
      const result = await cancelLeaveRequest(row.id);
      setCancelling(null);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({ tone: "success", title: "Leave cancelled", description: result.message });
    });
  }

  return (
    <>
      {canManage ? (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            Record leave
          </Button>
        </div>
      ) : null}

      <Card>
        {requests.length === 0 ? (
          <EmptyState>No leave requests recorded.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Team member</Th>
                <Th>Type</Th>
                <Th>Dates</Th>
                <Th>Days</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((row) => (
                <tr key={row.id}>
                  <Td className="font-medium">{row.memberName}</Td>
                  <Td>{row.leaveTypeName}</Td>
                  <Td className="tabular-nums text-xs">
                    {row.startDate.toISOString().slice(0, 10)} → {row.endDate.toISOString().slice(0, 10)}
                  </Td>
                  <Td className="tabular-nums">{row.dayCount}</Td>
                  <Td className="text-[color:var(--color-muted-foreground)]">{row.reason ?? "—"}</Td>
                  <Td>
                    <Badge color={STATUS_COLOR[row.status]} dot>
                      {row.status.charAt(0) + row.status.slice(1).toLowerCase()}
                    </Badge>
                    {row.managerNote ? (
                      <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{row.managerNote}</div>
                    ) : null}
                  </Td>
                  <Td>
                    {canManage ? (
                      <div className="flex justify-end gap-1.5">
                        {row.status === "REQUESTED" ? (
                          <>
                            <Button size="sm" onClick={() => setDeciding({ row, decision: "APPROVED" })}>
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setDeciding({ row, decision: "REJECTED" })}
                            >
                              Reject
                            </Button>
                          </>
                        ) : row.status === "APPROVED" ? (
                          <Button size="sm" variant="ghost" onClick={() => setCancelling(row)}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={creating}
        onClose={() => {
          setCreating(false);
          setError(null);
        }}
        title="Record leave"
        description="Dates are inclusive and counted once, so a holiday declared later cannot change the size of a decided request."
      >
        <form action={handleCreate} className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Team member" htmlFor="leave-member" required>
            <Select id="leave-member" name="teamMemberId" required>
              <option value="">Pick somebody…</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Leave type" htmlFor="leave-type" required>
            <Select id="leave-type" name="leaveTypeId" required>
              <option value="">Pick a type…</option>
              {leaveTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="leave-start" required>
              <Input id="leave-start" name="startDate" type="date" required />
            </Field>
            <Field label="To" htmlFor="leave-end" required>
              <Input id="leave-end" name="endDate" type="date" required />
            </Field>
          </div>

          <Field label="Reason" htmlFor="leave-reason">
            <Textarea id="leave-reason" name="reason" rows={3} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create request
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deciding !== null}
        onClose={() => {
          setDeciding(null);
          setNote("");
        }}
        onConfirm={handleDecide}
        title={
          deciding?.decision === "APPROVED"
            ? `Approve leave for ${deciding.row.memberName}?`
            : `Reject this request?`
        }
        description={
          deciding?.decision === "APPROVED"
            ? "Their existing duty rows are kept and marked as leave, so the shifts they were on report the gap rather than silently looking empty."
            : undefined
        }
        confirmLabel={deciding?.decision === "APPROVED" ? "Approve" : "Reject"}
        tone={deciding?.decision === "APPROVED" ? "primary" : "danger"}
        loading={pending}
      >
        <Field label="Note" htmlFor="leave-note" hint="Optional. Shown beside the decision.">
          <Input id="leave-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={handleCancel}
        title="Cancel this approved leave?"
        description="Their duty rows will still read LEAVE. Cover was very likely arranged, so putting the original shift back is a deliberate edit on the roster rather than something this undoes for you."
        confirmLabel="Cancel leave"
        tone="danger"
        loading={pending}
      />
    </>
  );
}
