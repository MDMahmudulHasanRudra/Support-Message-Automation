"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Field, Input, Select, useToast } from "@/components/ui";
import { createTeam, updateTeam, type TeamFormState } from "@/server/actions/teams";

interface TeamDefaults {
  name: string;
  code: string | null;
  description: string | null;
  status: string;
}

/** Create (inline, on the Teams page) or edit (its own page) one Team. */
export function TeamForm({ teamId, defaults }: { teamId?: string; defaults?: TeamDefaults }) {
  const action = teamId ? updateTeam.bind(null, teamId) : createTeam;
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!state.success) return;
    formRef.current?.reset();
    showToast({ tone: "success", title: "Team created" });
  }, [state, showToast]);

  const editing = Boolean(teamId);
  return (
    <div className="space-y-3">
      <form
        ref={formRef}
        action={formAction}
        className={editing ? "space-y-4" : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1.2fr_0.7fr_2fr_0.8fr_auto]"}
      >
        <Field label="Team name" required={editing}>
          <Input name="name" placeholder="e.g. Support Team" defaultValue={defaults?.name} required maxLength={80} />
        </Field>
        <Field label="Team code" hint={editing ? "Optional. Short identifier, e.g. SUPPORT." : undefined}>
          <Input name="code" placeholder="Optional" defaultValue={defaults?.code ?? ""} maxLength={24} />
        </Field>
        <Field label="Description">
          <Input name="description" placeholder="Optional" defaultValue={defaults?.description ?? ""} />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={defaults?.status === "DISABLED" ? "DISABLED" : "ACTIVE"}>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" className={editing ? "" : "w-full"} loading={pending}>
            {editing ? null : <Plus className="size-4" aria-hidden />}
            {editing ? "Save" : "Add team"}
          </Button>
        </div>
      </form>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
    </div>
  );
}
