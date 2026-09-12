"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, Repeat } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import {
  applyShiftChange,
  materialiseRosterForDate,
  previewShiftChange,
  setDutyAssignment,
  type ShiftChangePreview,
} from "@/server/actions/teamManagement";
import type { CoverageRow, ReplacementCandidate, RosterRow } from "@/server/teamManagementReports";
import { DutyStateBadge } from "../DutyStateBadge";

const AVAILABILITY_LABEL: Record<ReplacementCandidate["availability"], string> = {
  AVAILABLE: "Available",
  OFF: "Scheduled off",
  ON_LEAVE: "On approved leave",
  ALREADY_ASSIGNED: "Already assigned",
};

/**
 * One date's roster, and the two things a manager does to it: fill it from the weekly pattern, and
 * change somebody's shift.
 *
 * The shift change is a **preview then apply**, not a dropdown that writes immediately. Moving
 * somebody can leave their old shift below its required headcount, and that is a legitimate
 * decision — it just must not be an invisible one. The preview says what the shift would be left
 * with before anything is written, and offers a replacement in the same step so the two halves are
 * recorded as one decision rather than two unrelated edits.
 */
export function RosterDay({
  date,
  roster,
  coverage,
  candidates,
  templates,
}: {
  date: string;
  roster: RosterRow[];
  coverage: CoverageRow[];
  candidates: ReplacementCandidate[];
  templates: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<RosterRow | null>(null);
  const [changing, setChanging] = useState<RosterRow | null>(null);
  const [targetShift, setTargetShift] = useState("");
  const [replacement, setReplacement] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ShiftChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function closeAll() {
    setEditing(null);
    setChanging(null);
    setPreview(null);
    setTargetShift("");
    setReplacement("");
    setReason("");
    setError(null);
  }

  function handleMaterialise() {
    startTransition(async () => {
      const result = await materialiseRosterForDate(date);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: result.updated ? `${result.updated} assigned from the weekly schedule` : "Nothing to fill",
        // Said explicitly: a manager who presses this and sees a small number needs to know the
        // rest were skipped on purpose, not missed.
        description: result.unchanged
          ? `${result.unchanged} left alone — already assigned, or no weekly pattern set.`
          : undefined,
      });
    });
  }

  function handleSaveDuty(formData: FormData) {
    startTransition(async () => {
      const result = await setDutyAssignment(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      closeAll();
      showToast({ tone: "success", title: "Roster updated" });
    });
  }

  function handlePreview(shiftId: string) {
    setTargetShift(shiftId);
    setPreview(null);
    if (!changing || !shiftId) return;
    startTransition(async () => {
      const result = await previewShiftChange(changing.teamMemberId, date, shiftId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setPreview(result);
    });
  }

  function handleApply() {
    if (!changing || !targetShift) return;
    startTransition(async () => {
      const result = await applyShiftChange({
        teamMemberId: changing.teamMemberId,
        dateValue: date,
        newShiftTemplateId: targetShift,
        reason: reason.trim() || null,
        replacementTeamMemberId: replacement || null,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      closeAll();
      showToast({
        tone: "success",
        title: "Shift change recorded",
        description: result.updated === 2 ? "Both assignments are recorded as one change." : undefined,
      });
    });
  }

  const gaps = coverage.filter((row) => row.gap > 0);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {coverage.map((row) => (
            <Badge key={row.shiftTemplateId} color={row.gap > 0 ? "red" : "green"} dot>
              {row.shiftName} {row.effective}/{row.requiredHeadcount}
            </Badge>
          ))}
        </div>
        <Button variant="secondary" onClick={handleMaterialise} disabled={pending}>
          <CalendarPlus className="size-4" aria-hidden />
          Fill from weekly schedule
        </Button>
      </div>

      {gaps.length > 0 ? (
        <Alert tone="warning">
          {gaps.map((row) => `${row.shiftName} is short by ${row.gap}`).join("; ")}. Effective coverage already
          subtracts anyone on approved leave.
        </Alert>
      ) : null}

      <Card className="mt-3">
        <Table>
          <thead>
            <tr>
              <Th>Team member</Th>
              <Th>Scheduled</Th>
              <Th>Messages</Th>
              <Th>Reading</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {roster.map((row) => (
              <tr key={row.teamMemberId}>
                <Td>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-[color:var(--color-muted-foreground)]">{row.role}</div>
                </Td>
                <Td>
                  {row.shiftName ?? (
                    <span className="text-[color:var(--color-muted-foreground)]">
                      {row.status ? row.status.toLowerCase().replace("_", " ") : "not set"}
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums">{row.messageCount || "—"}</Td>
                <Td>
                  <DutyStateBadge state={row.derived} />
                </Td>
                <Td>
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                      Set duty
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setChanging(row)}>
                      <Repeat className="size-3.5" aria-hidden />
                      Change shift
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* ------------------------------------------------------------------ set one person's day */}
      <Dialog
        open={editing !== null}
        onClose={closeAll}
        title={editing ? `${editing.name} — ${date}` : ""}
        description="Sets this date only. It does not change their weekly pattern."
      >
        <form action={handleSaveDuty} className="space-y-4">
          <input type="hidden" name="teamMemberId" value={editing?.teamMemberId ?? ""} />
          <input type="hidden" name="dutyDate" value={date} />
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Duty" htmlFor="duty-status">
            <Select id="duty-status" name="status" defaultValue={editing?.status ?? "DUTY"}>
              <option value="DUTY">On duty</option>
              <option value="COVERAGE">Covering for somebody</option>
              <option value="EXTRA_DUTY">Extra duty</option>
              <option value="OFF">Day off</option>
              <option value="HOLIDAY">Holiday</option>
              <option value="UNASSIGNED">Not decided</option>
            </Select>
          </Field>

          <Field
            label="Shift"
            htmlFor="duty-shift"
            hint="Only used for a working status. The shift's current name and hours are copied onto this date, so a later edit to the shift cannot rewrite it."
          >
            <Select id="duty-shift" name="shiftTemplateId" defaultValue={editing?.shiftTemplateId ?? ""}>
              <option value="">No shift</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Reason" htmlFor="duty-reason" hint="Recorded in the change history.">
            <Input id="duty-reason" name="reason" defaultValue={editing?.overrideReason ?? ""} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={closeAll}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----------------------------------------------------------------------- the §80 workflow */}
      <Dialog
        open={changing !== null}
        onClose={closeAll}
        title={changing ? `Move ${changing.name} to another shift` : ""}
        description="You will see what the shift they leave would be left with before anything is written."
        size="lg"
      >
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Move them to" htmlFor="change-shift">
            <Select id="change-shift" value={targetShift} onChange={(event) => handlePreview(event.target.value)}>
              <option value="">Pick a shift…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </Field>

          {preview ? (
            <Alert tone={preview.leavesGap ? "warning" : "info"}>
              {preview.currentShiftName ? (
                <>
                  Moving them off <strong>{preview.vacatedShiftName}</strong> leaves it with{" "}
                  {preview.vacatedEffectiveAfter} of {preview.vacatedRequired} needed.
                  {preview.leavesGap ? " Assign somebody below, or accept the gap knowingly." : " Still covered."}
                </>
              ) : (
                <>They have no shift on this date, so nothing is vacated.</>
              )}
            </Alert>
          ) : null}

          {preview?.leavesGap ? (
            <Field
              label="Who covers the shift they leave"
              htmlFor="change-replacement"
              hint="Anyone on approved leave that day is listed but cannot be chosen. Recent extra duty is shown so the same person is not volunteered every time."
            >
              <Select
                id="change-replacement"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
              >
                <option value="">Leave the shift short</option>
                {candidates
                  .filter((candidate) => candidate.teamMemberId !== changing?.teamMemberId)
                  .map((candidate) => (
                    <option
                      key={candidate.teamMemberId}
                      value={candidate.teamMemberId}
                      disabled={candidate.availability === "ON_LEAVE" || candidate.availability === "ALREADY_ASSIGNED"}
                    >
                      {candidate.name} — {AVAILABILITY_LABEL[candidate.availability]} · {candidate.recentOffDayDuties}{" "}
                      extra in 30 days
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Reason" htmlFor="change-reason" hint="Kept forever against both assignments.">
            <Input
              id="change-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Covering a staff shortage"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={closeAll}>
              Cancel
            </Button>
            <Button onClick={handleApply} loading={pending} disabled={!targetShift}>
              Apply change
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
