"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import { saveShiftTemplate, setShiftTemplateActive } from "@/server/actions/teamManagement";

export interface ShiftTemplateRow {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  requiredHeadcount: number;
  colourSlot: number | null;
  description: string | null;
  isActive: boolean;
  position: number;
  /** How many dates have ever been assigned to it — why it can be disabled but not deleted. */
  assignmentCount: number;
}

/** Minutes → the `HH:MM` an `<input type="time">` expects. */
function toTimeValue(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Shift templates: what a shift means from now on.
 *
 * The one thing worth saying on screen, and said on screen rather than only here: editing the hours
 * changes what the shift means **going forward**. Every date already on the roster keeps the hours
 * it was assigned with, because those are snapshotted onto the assignment. A manager who does not
 * know that will assume an edit rewrites history, and will either avoid editing or be surprised
 * when last week's report does not move.
 */
export function ShiftTemplateManager({ templates }: { templates: ShiftTemplateRow[] }) {
  const [editing, setEditing] = useState<ShiftTemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function close() {
    setEditing(null);
    setCreating(false);
    setError(null);
  }

  function handleSave(formData: FormData) {
    startTransition(async () => {
      const result = await saveShiftTemplate(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      close();
      showToast({ tone: "success", title: "Shift saved" });
    });
  }

  function handleToggle(row: ShiftTemplateRow) {
    startTransition(async () => {
      const result = await setShiftTemplateActive(row.id, !row.isActive);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: row.isActive ? `“${row.name}” disabled` : `“${row.name}” enabled`,
        description: row.isActive ? "It stays on every date already assigned to it." : undefined,
      });
    });
  }

  const open = creating || editing !== null;

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden />
          New shift
        </Button>
      </div>

      <Card>
        {templates.length === 0 ? (
          <EmptyState>
            No shifts yet. Create the ones your team actually works — nothing here is assumed.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Shift</Th>
                <Th>Hours</Th>
                <Th>Required</Th>
                <Th>Assigned dates</Th>
                <Th>Status</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {templates.map((row) => {
                const crossesMidnight = row.endMinute <= row.startMinute;
                return (
                  <tr key={row.id}>
                    <Td>
                      <div className="font-medium">{row.name}</div>
                      {row.description ? (
                        <div className="text-xs text-[color:var(--color-muted-foreground)]">{row.description}</div>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">
                      {toTimeValue(row.startMinute)} – {toTimeValue(row.endMinute)}
                      {crossesMidnight ? (
                        <span className="ml-1.5 text-xs text-[color:var(--color-muted-foreground)]">next day</span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">{row.requiredHeadcount}</Td>
                    <Td className="tabular-nums">{row.assignmentCount || "—"}</Td>
                    <Td>
                      {row.isActive ? <Badge color="green" dot>Active</Badge> : <Badge color="gray">Disabled</Badge>}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                          <Pencil className="size-3.5" aria-hidden />
                          Edit
                        </Button>
                        <Button size="sm" variant="secondary" disabled={pending} onClick={() => handleToggle(row)}>
                          {row.isActive ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={open}
        onClose={close}
        title={editing ? `Edit ${editing.name}` : "New shift"}
        description="Times are local (Asia/Dhaka). An end time at or before the start means the shift runs past midnight."
      >
        <form action={handleSave} className="space-y-4">
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="Name" htmlFor="shift-name" required>
            <Input id="shift-name" name="name" defaultValue={editing?.name ?? ""} maxLength={60} required autoFocus />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" htmlFor="shift-start" required>
              <Input
                id="shift-start"
                name="startTime"
                type="time"
                defaultValue={editing ? toTimeValue(editing.startMinute) : "10:00"}
                required
              />
            </Field>
            <Field label="Ends" htmlFor="shift-end" required>
              <Input
                id="shift-end"
                name="endTime"
                type="time"
                defaultValue={editing ? toTimeValue(editing.endMinute) : "19:00"}
                required
              />
            </Field>
          </div>

          <Field
            label="People needed"
            htmlFor="shift-required"
            hint="A floor, not a cap. The coverage report only ever complains about fewer, and it counts people who can actually work — anyone on approved leave is subtracted."
          >
            <Input
              id="shift-required"
              name="requiredHeadcount"
              type="number"
              min={0}
              max={200}
              defaultValue={editing?.requiredHeadcount ?? 1}
            />
          </Field>

          <Field label="Description" htmlFor="shift-description">
            <Input id="shift-description" name="description" defaultValue={editing?.description ?? ""} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Colour" htmlFor="shift-colour" hint="1–6, for telling shifts apart on the roster grid.">
              <Input
                id="shift-colour"
                name="colourSlot"
                type="number"
                min={1}
                max={6}
                defaultValue={editing?.colourSlot ?? 1}
              />
            </Field>
            <Field label="Order" htmlFor="shift-position" hint="Where it sits in the roster grid.">
              <Input id="shift-position" name="position" type="number" min={0} defaultValue={editing?.position ?? 0} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isActive" defaultChecked={editing?.isActive ?? true} />
            Available for new assignments
          </label>

          {editing && editing.assignmentCount > 0 ? (
            <Alert tone="info">
              {editing.assignmentCount} date{editing.assignmentCount === 1 ? " has" : "s have"} already been assigned to
              this shift. Changing the hours here changes what it means from now on — those dates keep the hours they
              were assigned with.
            </Alert>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save shift
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
