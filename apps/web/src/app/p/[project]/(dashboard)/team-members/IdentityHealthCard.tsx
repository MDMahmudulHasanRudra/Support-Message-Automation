import Link from "@/components/ProjectLink";
import { Card, SectionHeader, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { AddSenderButton } from "./AddSenderButton";
import { IDENTITY_HEALTH_WINDOW_DAYS, LIKELY_STAFF_MIN_GROUPS, type RosterIdentityHealth } from "@/server/rosterIdentityHealth";

/**
 * Team Members → Identity check: the roster problems that make reports wrong without an error
 * (rosterIdentityHealth.ts). Renders nothing when there is nothing to fix.
 */
export function IdentityHealthCard({ health, canManage }: { health: RosterIdentityHealth; canManage: boolean }) {
  const { ownNumberMembers, quietMembers, unknownFrequentSenders, pendingReattributions } = health;
  if (!ownNumberMembers.length && !quietMembers.length && !unknownFrequentSenders.length && !pendingReattributions) return null;

  return (
    <Card className="mb-6">
      <SectionHeader
        title="Identity check"
        description="Problems on this roster that make reports credit messages to the wrong person — or to nobody."
      />
      <div className="space-y-4 text-[13px]">
        {pendingReattributions > 0 ? (
          <p className="text-[color:var(--color-muted-foreground)]">
            {pendingReattributions} recent roster change(s) are still being applied to stored messages and Duty History. Reports
            already show the new roster.
          </p>
        ) : null}

        {ownNumberMembers.length > 0 ? (
          <div>
            <p className="font-medium">Number is one of our WhatsApp accounts</p>
            <p className="text-[color:var(--color-muted-foreground)]">
              Everything sent from one of our own accounts is the business&apos;s message, so it is never credited to{" "}
              {ownNumberMembers.map((m) => m.name).join(", ")}. Give them their own number, or accept that this work shows as the
              business number&apos;s.
            </p>
          </div>
        ) : null}

        {quietMembers.length > 0 ? (
          <div>
            <p className="font-medium">No message matched in the last {IDENTITY_HEALTH_WINDOW_DAYS} days</p>
            <p className="text-[color:var(--color-muted-foreground)]">
              {quietMembers.map((m) => m.name).join(", ")}. Usually a number entered wrongly, or a colleague WhatsApp shows only by a
              private WhatsApp ID nobody has linked yet — open one of their messages in WhatsApp Chat and use &ldquo;This person
              is…&rdquo;.
            </p>
          </div>
        ) : null}

        {unknownFrequentSenders.length > 0 ? (
          <div>
            <p className="font-medium">Possible team members not on the roster</p>
            <p className="mb-2 text-[color:var(--color-muted-foreground)]">
              Senders nobody on the roster matches, who wrote in {LIKELY_STAFF_MIN_GROUPS} or more groups in the last{" "}
              {IDENTITY_HEALTH_WINDOW_DAYS} days. If one is a colleague, every message they sent is being counted as a
              customer&apos;s. &ldquo;Add to team&rdquo; puts them on the roster and collects every message they already sent into
              the Team Report, Team Performance, Duty History and the Activity Feed.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>WhatsApp name</Th>
                  <Th>Number / WhatsApp ID</Th>
                  <Th>Groups</Th>
                  <Th>Messages</Th>
                  <Th>Last message</Th>
                  {canManage ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {unknownFrequentSenders.map((s) => (
                  <tr key={s.sender}>
                    <Td>{s.name ?? "(no WhatsApp name)"}</Td>
                    <Td className="font-[family-name:var(--font-mono)] text-[12px]">{s.phone ?? `WhatsApp ID ${s.whatsappId ?? s.sender}`}</Td>
                    <Td className="tabular text-right">{s.groups}</Td>
                    <Td className="tabular text-right">{s.messages}</Td>
                    <Td>{formatDateTime(s.lastAt)}</Td>
                    {canManage ? (
                      <Td>
                        <AddSenderButton senderId={s.sender} suggestedName={s.name} />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2 text-[color:var(--color-muted-foreground)]">
              See also the <Link href="/team-report" className="underline">Team Report</Link>&apos;s reliability section.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
