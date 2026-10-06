import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { parseOpenView } from "@/server/supportAssignment";
import { CaseList } from "../CaseList";

/**
 * Support Assignment → Unanswered (SUPPORT_ASSIGNMENT.md): every customer still waiting, one row per
 * group, longest waiting first — with who it is assigned to and how its SLA stands.
 */
export default async function UnansweredCasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("support_assignment.view");
  const params = await searchParams;
  const view = parseOpenView(params.view);
  return (
    <div>
      <PageHeader
        title="Support Assignment"
        description="Customers waiting for a reply. Assign each one to a person, and the case completes itself when that person replies in the group."
        actions={
          <HelpButton moduleTitle="Support Assignment">
            <HelpSection title="What becomes a case">
              <p>
                A customer message in a group that no Support Team member has answered yet — the same waits as Messages →
                Unanswered groups, one case per WhatsApp group however many lines the customer sends.
              </p>
              <p>
                Messages made only of ignored words (&ldquo;thanks&rdquo;, &ldquo;ok&rdquo;) and messages from ignored senders are
                filtered out and kept under Completed → Ignored. Anything else the customer writes is a case, whatever words it
                uses: the ignore list only removes, it never decides what counts as support.
              </p>
            </HelpSection>
            <HelpSection title="When it completes">
              <p>
                When the assigned person replies in the group from their own WhatsApp, after being assigned, with more than an
                ignored word. A reply from somebody else closes the case as &ldquo;Answered by someone else&rdquo; — the customer is no
                longer waiting, but it is not credited to the assignee.
              </p>
            </HelpSection>
            <HelpSection title="Overdue and escalation">
              <p>
                If the assignee has not replied when the SLA runs out, the case turns overdue and the manager group is told. With
                escalation on, admins are told once more after the escalation delay. A reply at any point stops every further
                alert.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <CaseList session={session} view={view} basePath="/support-assignment/unanswered" params={params} />
    </div>
  );
}
