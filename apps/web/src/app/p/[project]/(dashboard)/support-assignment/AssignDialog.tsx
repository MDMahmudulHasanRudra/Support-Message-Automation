"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Dialog, Input } from "@/components/ui";
import type { AssignableMember } from "@/server/supportAssignment";

/**
 * Pick the person, then confirm. Two steps on purpose: assigning messages somebody's phone, and a
 * bulk assignment can put a dozen cases on one person at once — so the dialog says exactly that
 * ("You are about to assign 4 support cases to Hasan") before anything is written.
 */
export function AssignDialog({
  open,
  onClose,
  onConfirm,
  members,
  caseCount,
  assignedCount,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (memberId: string, reassign: boolean) => void;
  members: AssignableMember[];
  /** How many cases are being assigned. */
  caseCount: number;
  /** How many of them already belong to somebody (they move only if "reassign" is ticked). */
  assignedCount: number;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<AssignableMember | null>(null);
  const [reassign, setReassign] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => [m.name, m.role, m.teamName ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [members, query]);

  const reset = () => {
    setQuery("");
    setChosen(null);
    setReassign(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  const moving = reassign ? caseCount : caseCount - assignedCount;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={chosen ? "Confirm assignment" : "Assign to employee"}
      description={chosen ? undefined : `Choose who answers ${caseCount === 1 ? "this customer" : `these ${caseCount} customers`}.`}
      footer={
        chosen ? (
          <>
            <Button variant="secondary" onClick={() => setChosen(null)} disabled={busy}>
              Back
            </Button>
            <Button
              onClick={() => {
                onConfirm(chosen.id, reassign);
              }}
              loading={busy}
              disabled={moving === 0}
            >
              Confirm assignment
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
        )
      }
    >
      {chosen ? (
        <div className="space-y-3 text-[13px]">
          <p>
            You are about to assign{" "}
            <strong className="tabular">
              {moving} {moving === 1 ? "support case" : "support cases"}
            </strong>{" "}
            to <strong>{chosen.name}</strong>.
          </p>
          {chosen.reachable ? (
            <p className="text-[color:var(--color-muted-foreground)]">They will be messaged on WhatsApp, if that notification is switched on.</p>
          ) : (
            <Alert tone="warning">
              {chosen.name} has no phone number on Team Members (only a WhatsApp id), so the WhatsApp notification cannot reach them. The
              assignment still counts; tell them another way, or add their number on Team Members.
            </Alert>
          )}
          {assignedCount > 0 ? (
            <label className="flex items-start gap-2.5">
              <Checkbox checked={reassign} onChange={(e) => setReassign(e.target.checked)} />
              <span>
                Also move the {assignedCount} {assignedCount === 1 ? "case that already belongs" : "cases that already belong"} to someone else
                <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">
                  Their history is kept, the deadline starts again, and {chosen.name} is notified. Left unticked, those stay where they are.
                </span>
              </span>
            </label>
          ) : null}
        </div>
      ) : (
        <div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, designation or Team"
              className="pl-8"
              aria-label="Search employees"
            />
          </div>
          <div role="listbox" aria-label="Employees" className="max-h-72 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
                {members.length === 0 ? "Nobody can be assigned: there is no active team member in the Teams that take assignments." : "Nobody matches that search."}
              </p>
            ) : (
              filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => setChosen(m)}
                  className="flex w-full items-center gap-3 border-b border-[var(--color-border)] px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block truncate text-[11px] text-[color:var(--color-muted-foreground)]">
                      {[m.role, m.teamName].filter(Boolean).join(" · ")}
                      {m.reachable ? "" : " · no phone number"}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">{m.openCount} open</span>
                </button>
              ))
            )}
          </div>
          <p className="mt-2 text-[11px] text-[color:var(--color-muted-foreground)]">&ldquo;Open&rdquo; is how many assigned cases each person has not answered yet.</p>
        </div>
      )}
    </Dialog>
  );
}
