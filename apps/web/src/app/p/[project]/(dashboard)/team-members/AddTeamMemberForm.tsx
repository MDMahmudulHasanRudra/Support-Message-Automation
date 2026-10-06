"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Field, Input, Select, useToast } from "@/components/ui";
import { createTeamMember, type TeamMemberFormState } from "@/server/actions/teamMembers";
import { MemberSuggestionLists, TeamSelect, type MemberFormOptions } from "./MemberFormFields";

/**
 * The add form, as a client component so a refusal can be shown beside the fields.
 *
 * It was a plain `<form action={createTeamMember}>` on the server page, which has nowhere to put a
 * message — so the action threw instead, and a throw in a Server Action replaces the page with the
 * error boundary. Adding a number somebody already had therefore looked like the app breaking,
 * rather than being told who has it.
 */
export function AddTeamMemberForm({ options }: { options: MemberFormOptions }) {
  const [state, formAction, pending] = useActionState<TeamMemberFormState, FormData>(createTeamMember, {});
  const formRef = useRef<HTMLFormElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!state.success) return;
    // Cleared only on success, so a refused submission keeps what was typed for correcting.
    formRef.current?.reset();
    showToast({ tone: "success", title: "Team member added" });
  }, [state, showToast]);

  return (
    <div className="space-y-3">
      <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
        <MemberSuggestionLists options={options} />
        <Field label="Name">
          <Input name="name" placeholder="Name" required />
        </Field>
        <Field label="Phone">
          <Input name="phoneNumber" placeholder="+8801XXXXXXXXX" inputMode="tel" required />
        </Field>
        <Field label="WhatsApp ID">
          <Input name="whatsappId" placeholder="Optional, e.g. 1459…" inputMode="numeric" />
        </Field>
        <Field label="Team">
          <TeamSelect teams={options.teams} />
        </Field>
        <Field label="Department">
          <Input name="department" placeholder="Optional" list="member-departments" />
        </Field>
        <Field label="Designation">
          <Input name="role" placeholder="e.g. Support Executive" list="member-designations" required />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue="ACTIVE">
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Disabled</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" className="w-full" loading={pending}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      </form>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
    </div>
  );
}
