"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import { deleteHoliday, saveHoliday, saveLeaveType } from "@/server/actions/teamManagement";

export interface LeaveTypeRow {
  id: string;
  name: string;
  annualAllowanceDays: number | null;
  isPaid: boolean;
  isActive: boolean;
  position: number;
}

export interface HolidayRow {
  id: string;
  name: string;
  date: string;
  description: string | null;
}

/**
 * What the organisation offers, and which days it observes.
 *
 * Both empty on a fresh install, deliberately. Entitlement and the public calendar differ by
 * country and by company, and shipping a guess at either would be this software making a claim it
 * has no standing to make — then having that guess quietly become policy because nobody checked it.
 */
export function LeaveTypesAndHolidays({
  leaveTypes,
  holidays,
}: {
  leaveTypes: LeaveTypeRow[];
  holidays: HolidayRow[];
}) {
  const [editingType, setEditingType] = useState<LeaveTypeRow | null>(null);
  const [creatingType, setCreatingType] = useState(false);
  const [creatingHoliday, setCreatingHoliday] = useState(false);
  const [removingHoliday, setRemovingHoliday] = useState<HolidayRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function closeType() {
    setEditingType(null);
    setCreatingType(false);
    setError(null);
  }

  function handleSaveType(formData: FormData) {
    startTransition(async () => {
      const result = await saveLeaveType(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      closeType();
      showToast({ tone: "success", title: "Leave type saved" });
    });
  }

  function handleSaveHoliday(formData: FormData) {
    startTransition(async () => {
      const result = await saveHoliday(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCreatingHoliday(false);
      setError(null);
      showToast({
        tone: "success",
        title: "Holiday saved",
        // Said out loud because the opposite is the natural assumption.
        description: "Dates already on the roster are unchanged; this affects days filled from now on.",
      });
    });
  }

  function handleDeleteHoliday() {
    if (!removingHoliday) return;
    startTransition(async () => {
      const result = await deleteHoliday(removingHoliday.id);
      setRemovingHoliday(null);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({ tone: "success", title: "Holiday removed" });
    });
  }

  return (
    <>
      <div className="mb-10">
        <div className="flex items-end justify-between gap-3">
          <SectionHeader
            title="Leave types"
            description="Whatever your organisation actually offers. An allowance of “not tracked” and an allowance of zero are different answers, and both are allowed."
          />
          <Button size="sm" onClick={() => setCreatingType(true)}>
            <Plus className="size-3.5" aria-hidden />
            New type
          </Button>
        </div>
        <Card>
          {leaveTypes.length === 0 ? (
            <EmptyState>No leave types yet. Leave cannot be recorded until at least one exists.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Annual allowance</Th>
                  <Th>Paid</Th>
                  <Th>Status</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {leaveTypes.map((row) => (
                  <tr key={row.id}>
                    <Td className="font-medium">{row.name}</Td>
                    <Td className="tabular-nums">
                      {row.annualAllowanceDays === null ? (
                        <span className="text-[color:var(--color-muted-foreground)]">Not tracked</span>
                      ) : (
                        `${row.annualAllowanceDays} days`
                      )}
                    </Td>
                    <Td>{row.isPaid ? "Paid" : "Unpaid"}</Td>
                    <Td>{row.isActive ? <Badge color="green" dot>Active</Badge> : <Badge color="gray">Disabled</Badge>}</Td>
                    <Td>
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setEditingType(row)}>
                          Edit
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div>
        <div className="flex items-end justify-between gap-3">
          <SectionHeader
            title="Holidays"
            description="Days your organisation observes. No national or religious calendar is assumed — add the ones that apply to you."
          />
          <Button size="sm" onClick={() => setCreatingHoliday(true)}>
            <Plus className="size-3.5" aria-hidden />
            New holiday
          </Button>
        </div>
        <Card>
          {holidays.length === 0 ? (
            <EmptyState>No holidays declared.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Name</Th>
                  <Th>Note</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {holidays.map((row) => (
                  <tr key={row.id}>
                    <Td className="tabular-nums whitespace-nowrap">{row.date}</Td>
                    <Td className="font-medium">{row.name}</Td>
                    <Td className="text-[color:var(--color-muted-foreground)]">{row.description ?? "—"}</Td>
                    <Td>
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setRemovingHoliday(row)}>
                          <Trash2 className="size-3.5" aria-hidden />
                          Remove
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Dialog
        open={creatingType || editingType !== null}
        onClose={closeType}
        title={editingType ? `Edit ${editingType.name}` : "New leave type"}
      >
        <form action={handleSaveType} className="space-y-4">
          {editingType ? <input type="hidden" name="id" value={editingType.id} /> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Name" htmlFor="type-name" required>
            <Input id="type-name" name="name" defaultValue={editingType?.name ?? ""} required autoFocus />
          </Field>

          <Field
            label="Annual allowance"
            htmlFor="type-allowance"
            hint="Leave blank if you do not track an allowance for this type. Blank and 0 mean different things and are stored differently."
          >
            <Input
              id="type-allowance"
              name="annualAllowanceDays"
              type="number"
              min={0}
              max={366}
              defaultValue={editingType?.annualAllowanceDays ?? ""}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isPaid" defaultChecked={editingType?.isPaid ?? true} />
            Paid leave
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isActive" defaultChecked={editingType?.isActive ?? true} />
            Available when recording leave
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={closeType}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={creatingHoliday}
        onClose={() => {
          setCreatingHoliday(false);
          setError(null);
        }}
        title="New holiday"
        description="Affects days filled from the weekly schedule after this point. Dates already on the roster keep what somebody assigned them."
      >
        <form action={handleSaveHoliday} className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Date" htmlFor="holiday-date" required>
            <Input id="holiday-date" name="date" type="date" required />
          </Field>
          <Field label="Name" htmlFor="holiday-name" required>
            <Input id="holiday-name" name="name" required />
          </Field>
          <Field label="Note" htmlFor="holiday-description">
            <Input id="holiday-description" name="description" />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setCreatingHoliday(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={removingHoliday !== null}
        onClose={() => setRemovingHoliday(null)}
        onConfirm={handleDeleteHoliday}
        title={removingHoliday ? `Remove ${removingHoliday.name}?` : ""}
        description="Any date already rostered as a holiday keeps that assignment — this only stops future days being filled as one."
        confirmLabel="Remove"
        tone="danger"
        loading={pending}
      />
    </>
  );
}
