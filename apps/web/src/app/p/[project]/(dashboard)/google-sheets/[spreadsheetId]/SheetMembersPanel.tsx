"use client";

import { useActionState, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, ConfirmDialog, Field, Select, Table, Td, Th, useToast } from "@/components/ui";
import { SHEET_MEMBER_ROLE_LABELS, SHEET_MEMBER_ROLES, type SheetMemberRole } from "@support-automation/shared";
import {
  addSheetMemberAction,
  changeSheetMemberRoleAction,
  removeSheetMemberAction,
  type SheetMemberActionResult,
} from "@/server/actions/googleSheetMembers";

export interface MemberView {
  userId: string;
  name: string;
  username: string;
  role: SheetMemberRole;
  sinceLabel: string;
  addedByName: string | null;
  teamMemberName: string | null;
  canWorkThroughApp: boolean;
  isSelf: boolean;
  /** The Google account(s) this person linked as their own (Phase 4), or null. */
  googleIdentity: string | null;
}

const ROLE_BADGE: Record<SheetMemberRole, "blue" | "green" | "gray"> = { LEAD: "blue", EDITOR: "green", MONITOR: "gray" };

/**
 * The spreadsheet's members, and — for the people who staff it — adding, re-roling and removing them.
 * A Lead who is not a manager staffs editors and monitors only; Lead rows are a manager's to change
 * (the server enforces it; this only hides controls that would be refused).
 */
export function SheetMembersPanel({
  spreadsheetId,
  members,
  candidates,
  canStaff,
  canMakeLeads,
}: {
  spreadsheetId: string;
  members: MemberView[];
  candidates: { id: string; name: string; username: string }[];
  canStaff: boolean;
  canMakeLeads: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [state, formAction, adding] = useActionState<SheetMemberActionResult, FormData>(addSheetMemberAction.bind(null, spreadsheetId), {});
  const assignable = SHEET_MEMBER_ROLES.filter((role) => canMakeLeads || role !== "LEAD");

  function settle(result: SheetMemberActionResult) {
    if (result.error) showToast({ tone: "danger", title: result.error });
    else showToast({ tone: "success", title: result.success ?? "Saved" });
    router.refresh();
  }

  const mayChange = (member: MemberView) => canStaff && (canMakeLeads || member.role !== "LEAD");

  return (
    <div className="space-y-4">
      {members.length === 0 ? (
        <p className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-4 py-3 text-[13px] text-[color:var(--color-muted-foreground)]">
          Nobody is a member yet. Until somebody is, no one is recorded as working on this spreadsheet — not its owner, and not the
          connected Google account.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Works through the app</Th>
              <Th>Since</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <Td className="min-w-[12rem]">
                  <span className="font-medium">{member.name}</span>{" "}
                  <span className="text-[12px] text-[color:var(--color-muted-foreground)]">@{member.username}</span>
                  {member.isSelf ? <span className="ml-1 text-[12px] text-[color:var(--color-muted-foreground)]">(you)</span> : null}
                  <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                    {member.googleIdentity ? (
                      <>Google: {member.googleIdentity}</>
                    ) : (
                      <>No Google identity linked — edits they make in Google directly cannot be credited to them.</>
                    )}
                  </p>
                  <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                    {member.teamMemberName ? (
                      <>Team member: {member.teamMemberName}</>
                    ) : (
                      <>
                        Not linked to a team member — their work is credited to the login only.{" "}
                        <Link href="/team-members" className="font-medium text-[color:var(--color-accent)] hover:underline">
                          Link on Team Members
                        </Link>
                      </>
                    )}
                  </p>
                </Td>
                <Td className="whitespace-nowrap">
                  {mayChange(member) ? (
                    <Select
                      aria-label={`Role of ${member.name}`}
                      className="h-8 min-w-[8.5rem] text-[13px]"
                      value={member.role}
                      disabled={pending}
                      onChange={(event) => {
                        const role = event.target.value;
                        startTransition(async () => settle(await changeSheetMemberRoleAction(spreadsheetId, member.userId, role)));
                      }}
                    >
                      {SHEET_MEMBER_ROLES.filter((role) => canMakeLeads || role !== "LEAD").map((role) => (
                        <option key={role} value={role}>
                          {SHEET_MEMBER_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge color={ROLE_BADGE[member.role]}>{SHEET_MEMBER_ROLE_LABELS[member.role]}</Badge>
                  )}
                </Td>
                <Td className="text-[12px]">
                  {member.role === "MONITOR" ? (
                    <span className="text-[color:var(--color-muted-foreground)]">No — monitors only</span>
                  ) : member.canWorkThroughApp ? (
                    "Yes"
                  ) : (
                    <span className="text-[color:var(--color-warning-fg)]">Not yet — their role lacks “Edit Google Sheets” here</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-[12px] text-[color:var(--color-muted-foreground)]">
                  {member.sinceLabel}
                  {member.addedByName ? <> · by {member.addedByName}</> : null}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {mayChange(member) ? (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRemoving(member)}>
                      Remove
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {canStaff ? (
        <form action={formAction} className="flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3.5">
          <Field label="Add a person" htmlFor="sheet-member-user" className="w-full sm:w-72">
            <Select id="sheet-member-user" name="userId" defaultValue="" required>
              <option value="" disabled>
                {candidates.length === 0 ? "Everyone who can enter this project is a member" : "Choose a login…"}
              </option>
              {candidates.map((login) => (
                <option key={login.id} value={login.id}>
                  {login.name} (@{login.username})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role" htmlFor="sheet-member-role" className="w-full sm:w-44">
            <Select id="sheet-member-role" name="role" defaultValue="EDITOR">
              {assignable.map((role) => (
                <option key={role} value={role}>
                  {SHEET_MEMBER_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={adding} disabled={candidates.length === 0}>
            Add member
          </Button>
          {state.error ? (
            <div className="w-full">
              <Alert tone="danger" title="Not added">
                {state.error}
              </Alert>
            </div>
          ) : state.success ? (
            <div className="w-full">
              <Alert tone="success" title={state.success} />
            </div>
          ) : null}
          {canMakeLeads ? null : (
            <p className="w-full text-[12px] text-[color:var(--color-muted-foreground)]">
              As this spreadsheet&apos;s Lead you add editors and monitors. Making someone a Lead is for a Google Sheets manager.
            </p>
          )}
        </form>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const member = removing;
          if (!member) return;
          startTransition(async () => {
            const result = await removeSheetMemberAction(spreadsheetId, member.userId);
            setRemoving(null);
            settle(result);
          });
        }}
        title={removing ? `Remove ${removing.name} from this spreadsheet?` : ""}
        description="They stop being a member from now on. Their earlier membership and anything credited to them stay in the history."
        confirmLabel="Remove"
        tone="danger"
        loading={pending}
      />
    </div>
  );
}
