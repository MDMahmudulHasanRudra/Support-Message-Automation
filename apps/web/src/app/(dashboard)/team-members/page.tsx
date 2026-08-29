/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, HelpButton, HelpSection, Input, PageHeader, SectionHeader } from "@/components/ui";
import { createTeamMember } from "@/server/actions/teamMembers";
import { TeamMembersTable, type TeamMemberRow } from "./TeamMembersTable";
import { AddFromGroupDialog } from "./AddFromGroupDialog";

export default async function TeamMembersPage() {
  await requireSession();
  const [members, groups] = await Promise.all([
    prisma.internalTeamMember.findMany({ orderBy: { createdAt: "desc" } }) as Promise<TeamMemberRow[]>,
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div>
      <PageHeader
        title="Internal Team Members"
        description="Messages from active team members are ignored by client automation by default."
        actions={
          <>
            <AddFromGroupDialog groups={groups} />
            <HelpButton moduleTitle="Internal Team Members">
            <HelpSection title="What this page is for">
              <p>
                The roster of your own staff's WhatsApp numbers — the people who work inside your
                support groups, not clients. The system uses this list to tell "a client wrote this"
                apart from "one of our own people wrote this," which changes how automation treats a
                message.
              </p>
            </HelpSection>
            <HelpSection title="Phone number must match exactly">
              <p>
                This number is the actual match key — it's how the system recognizes their WhatsApp
                messages. It must exactly match the number they message from (international format,
                e.g. +8801XXXXXXXXX). If it doesn't match, their messages get processed as if from a
                client — which could trigger unwanted auto-replies to your own staff, or open Priority
                Support escalation cases against your own team's chatter.
              </p>
            </HelpSection>
            <HelpSection title="What being an active team member actually changes">
              <p>
                If no rule matches a message and the sender is an active team member, the system
                automatically ignores it by default — you can override this per case with a
                higher-priority rule that explicitly targets team-member senders. Rule conditions can
                also be scoped to "Sender = Team Member" or "Sender = Client" directly. And in a
                Priority Support group, a message from an active team member is treated as a human
                reply — it immediately closes any open escalation case for that chat.
              </p>
            </HelpSection>
            <HelpSection title="Disable vs. Delete">
              <p>
                <strong>Disable</strong> stops treating that number as staff going forward, without
                losing the record — use this for someone who's left or is on leave.{" "}
                <strong>Delete</strong> permanently removes the record. Neither one touches or hides
                past messages already stored from that number — only future messages are affected.
              </p>
            </HelpSection>
            <HelpSection title="If you disable/delete someone who's assigned elsewhere">
              <p>
                A group's "Assigned Team Member" (Groups page) and the Priority Support "Escalation
                Admin" (Policies page) are both picked from this same roster. If that person becomes
                inactive or is deleted, their notification tier is silently skipped (logged as a
                warning) rather than causing an error — the case still proceeds to its next tier on
                schedule.
              </p>
            </HelpSection>
            </HelpButton>
          </>
        }
      />

      <Card className="mb-6">
        <SectionHeader title="Add Team Member" />
        <form action={createTeamMember} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Name">
            <Input name="name" placeholder="Name" required />
          </Field>
          <Field label="Phone">
            <Input name="phoneNumber" placeholder="+8801XXXXXXXXX" required />
          </Field>
          <Field label="Role">
            <Input name="role" placeholder="Role" required />
          </Field>
          <Field label="Department">
            <Input name="department" placeholder="Optional" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        </form>
      </Card>

      <TeamMembersTable members={members} />
    </div>
  );
}
