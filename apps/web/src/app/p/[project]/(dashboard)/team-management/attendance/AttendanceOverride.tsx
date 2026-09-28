"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Dialog, Field, Input, Select, useToast } from "@/components/ui";
import { setAttendanceOverride } from "@/server/actions/teamManagement";

/**
 * A manager's verdict on one person's day.
 *
 * The only way any day in this system ever reads as ABSENT. Everything automatic stops at "no
 * activity recorded", because no message is evidence of no message and nothing more — somebody on
 * the phone, out at a customer site, or working in a group this account cannot see produces exactly
 * the same silence as somebody who did not come in.
 *
 * The override sits beside the evidence rather than replacing it, so "marked absent, and there were
 * forty messages" stays readable as precisely that.
 */
export function AttendanceOverride({
  teamMemberId,
  memberName,
  date,
  current,
  currentReason,
}: {
  teamMemberId: string;
  memberName: string;
  date: string;
  current: "WORKED" | "ABSENT" | "EXCUSED" | null;
  currentReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(current ?? "");
  const [reason, setReason] = useState(currentReason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleSave() {
    startTransition(async () => {
      const result = await setAttendanceOverride(
        teamMemberId,
        date,
        value === "" ? null : (value as "WORKED" | "ABSENT" | "EXCUSED"),
        reason.trim() || null,
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      showToast({ tone: "success", title: value ? "Correction recorded" : "Correction removed" });
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {current ? "Edit correction" : "Correct"}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${memberName} — ${date}`}
        description="The message counts are kept exactly as observed. Your verdict is recorded beside them, not instead of them."
      >
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Verdict" htmlFor="override-value">
            <Select id="override-value" value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">No correction — let the evidence stand</option>
              <option value="WORKED">Worked (field duty, phone support, a call-heavy day)</option>
              <option value="ABSENT">Did not work</option>
              <option value="EXCUSED">Away with my knowledge, outside the leave workflow</option>
            </Select>
          </Field>

          <Field
            label="Reason"
            htmlFor="override-reason"
            required={value === "ABSENT"}
            hint="Required when marking somebody absent — it is the one verdict this software will never reach on its own."
          >
            <Input id="override-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={pending}>
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
