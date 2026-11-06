import { pageAccess } from "@/server/authorize";
import { Card, HelpButton, HelpSection, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { loadLifecyclePolicy } from "@/server/conversationLifecycle";
import { InboxStatusForm } from "./InboxStatusForm";

/**
 * Settings → Support → Inbox status (Inbox V3, feature UNIFIED_INBOX_V3). What a customer's new message does
 * to a conversation the team has resolved or snoozed. A pending conversation always reopens on the
 * customer's next message — that is what pending means.
 */
export default async function InboxStatusSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit");
  const policy = await loadLifecyclePolicy();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Inbox status"
        description="Open, Pending, Snoozed and Resolved on every conversation — and what a customer message does to them."
        actions={
          <HelpButton moduleTitle="Inbox status">
            <HelpSection title="The four states">
              <p>
                <strong>Open</strong>: the team owes the customer something. <strong>Pending</strong>: the team has done its part and waits
                on the customer; their next message makes it Open. <strong>Snoozed</strong>: put aside until a time you choose, then Open by
                itself. <strong>Resolved</strong>: done.
              </p>
            </HelpSection>
            <HelpSection title="What this never does">
              <p>A status never sends anything, and never changes automation, AI or monitoring for a group. Messages are stored and shown as usual whatever the status.</p>
            </HelpSection>
          </HelpButton>
        }
      />
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <InboxStatusForm reopenResolved={policy.reopenResolvedOnCustomerMessage} reopenSnoozed={policy.reopenSnoozedOnCustomerMessage} canManage={canManage} />
      </Card>
    </div>
  );
}
