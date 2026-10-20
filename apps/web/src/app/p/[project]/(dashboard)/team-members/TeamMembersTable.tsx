"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import Link from "@/components/ProjectLink";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th, Tooltip } from "@/components/ui";
import { deleteTeamMember, toggleTeamMemberStatus } from "@/server/actions/teamMembers";
import { whatsappIdBadge } from "@support-automation/shared";

export interface TeamMemberRow {
  id: string;
  name: string;
  phoneNumber: string;
  whatsappId: string | null;
  role: string;
  department: string | null;
  status: string;
  team: { id: string; name: string; status: string } | null;
  /**
   * Other members who share one of this member's identifiers (WHATSAPP_IDENTITY.md §3). Messages
   * from that identifier are credited to nobody until the clash is fixed.
   */
  identityClash?: string[];
  /** Their earlier history after being added or re-identified: being collected, or what was found. */
  historySync?: { state: "SYNCING" | "DONE" | "FAILED"; messages: number | null; groups: number | null; firstAt: string | null };
}

function HistorySyncNote({ sync }: { sync: NonNullable<TeamMemberRow["historySync"]> }) {
  if (sync.state === "SYNCING") {
    return (
      <Tooltip content="Their earlier messages in groups are being collected into Team Performance, Duty History and the Activity Feed. The Team Report and every other report already count them.">
        <span className="ml-2 align-middle">
          <Badge color="blue">Syncing history…</Badge>
        </span>
      </Tooltip>
    );
  }
  if (sync.state === "FAILED") {
    return (
      <span className="ml-2 align-middle">
        <Badge color="red">History sync failed</Badge>
      </span>
    );
  }
  if (!sync.messages) return null;
  const since = sync.firstAt ? new Date(sync.firstAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : null;
  return (
    <span className="mt-0.5 block text-[11px] text-[color:var(--color-muted-foreground)]">
      History synced: {sync.messages.toLocaleString("en-US")} message(s) in {sync.groups ?? 0} group(s){since ? ` since ${since}` : ""}
    </span>
  );
}

type DialogState = { kind: "delete" | "toggle"; member: TeamMemberRow } | null;

export function TeamMembersTable({ members, unified = false }: { members: TeamMemberRow[]; unified?: boolean }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  function confirm() {
    if (!dialog) return;
    const { kind, member } = dialog;
    startTransition(async () => {
      if (kind === "delete") {
        const result = await deleteTeamMember(member.id);
        if (result.error) setNotice({ tone: "error", text: result.error });
        else if (result.deactivated) {
          setNotice({ tone: "info", text: `${member.name} has messages or activity on record, so they were disabled instead of deleted to keep that history. Their reports are unchanged. If they were added by mistake and their messages are a customer's, set "Count their messages from" on their edit page instead.` });
        } else setNotice({ tone: "info", text: `${member.name} was deleted.` });
      }
      if (kind === "toggle") await toggleTeamMemberStatus(member.id);
      setDialog(null);
      router.refresh();
    });
  }

  if (members.length === 0) {
    return <EmptyState>No team members yet — add one above.</EmptyState>;
  }

  return (
    <div>
      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${notice.tone === "error" ? "border-[var(--color-danger)] text-[color:var(--color-danger)]" : "border-[var(--color-border)]"}`}
        >
          {notice.text}
        </div>
      ) : null}
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Phone</Th>
            <Th>Team</Th>
            <Th>Designation</Th>
            <Th>Department</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <Td>
                {m.name}
                {m.historySync ? <HistorySyncNote sync={m.historySync} /> : null}
              </Td>
              <Td className="font-[family-name:var(--font-mono)] text-xs">
                {m.phoneNumber}
                {/* Mapped from message history, so this is a WhatsApp id rather than a number.
                    It recognises them fine; it cannot receive an escalation. */}
                {unified && whatsappIdBadge(m) === "UNLINKED_BD_MOBILE" ? (
                  // UNIFIED_REPORTING: the number typed is a real mobile number, so what is missing is the private
                  // WhatsApp ID. Display only: sending rules are unchanged.
                  <Tooltip content="This phone number is on file, but WhatsApp shows this person in groups by a private WhatsApp ID that has not been linked, so some of their messages may not be credited to them. Use Link to member in the Identity check below, or This person is… in WhatsApp Chat.">
                    <span className="ml-2 align-middle">
                      <Badge color="yellow">WhatsApp ID not linked</Badge>
                    </span>
                  </Tooltip>
                ) : m.whatsappId && m.whatsappId.trim() === m.phoneNumber.trim() ? (
                  <Tooltip content="This is a WhatsApp id, not a phone number. They will be recognised in groups, but a support escalation cannot reach them directly until you enter their real number.">
                    <span className="ml-2 align-middle">
                      <Badge color="yellow">Needs phone number</Badge>
                    </span>
                  </Tooltip>
                ) : null}
                {m.identityClash?.length ? (
                  <Tooltip
                    content={`Shares a phone number or WhatsApp ID with ${m.identityClash.join(", ")}. Their messages are counted as a team member's but credited to nobody in reports until one of the two records is corrected.`}
                  >
                    <span className="ml-2 align-middle">
                      <Badge color="red">Identity clash</Badge>
                    </span>
                  </Tooltip>
                ) : null}
              </Td>
              <Td>
                {m.team ? (
                  <Link className="link" href={`/teams/${m.team.id}`}>
                    {m.team.name}
                  </Link>
                ) : (
                  <span className="text-[color:var(--color-subtle-foreground)]">No team</span>
                )}
                {m.team?.status === "DISABLED" ? (
                  <span className="ml-1.5 text-[11px] text-[color:var(--color-subtle-foreground)]">(disabled)</span>
                ) : null}
              </Td>
              <Td>{m.role}</Td>
              <Td>{m.department ?? "—"}</Td>
              <Td>
                <Badge color={m.status === "ACTIVE" ? "green" : "gray"} dot>
                  {m.status}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Link href={`/team-members/${m.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "toggle", member: m })}>
                    {m.status === "ACTIVE" ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDialog({ kind: "delete", member: m })}>
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog?.kind === "delete" ? "danger" : "primary"}
        title={
          dialog?.kind === "delete"
            ? `Delete ${dialog.member.name}?`
            : dialog?.kind === "toggle"
              ? `${dialog.member.status === "ACTIVE" ? "Disable" : "Enable"} ${dialog.member.name}?`
              : ""
        }
        description={
          dialog?.kind === "delete"
            ? "This permanently removes the team member. If they have recorded support activity they are disabled instead, so past reports keep their name."
            : dialog?.kind === "toggle" && dialog.member.status === "ACTIVE"
              ? "Their messages will no longer be treated as internal team member messages by automation."
              : undefined
        }
        confirmLabel={dialog?.kind === "delete" ? "Delete" : dialog?.member.status === "ACTIVE" ? "Disable" : "Enable"}
      />
    </div>
  );
}
