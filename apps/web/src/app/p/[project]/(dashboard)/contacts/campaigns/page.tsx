import { CONTACT_CAMPAIGN_CHANNEL_LABEL } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { listCampaigns, loadContactFacets } from "@/server/contacts";
import Link from "@/components/ProjectLink";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { NewCampaignButton } from "./NewCampaignButton";

export const metadata = { title: "Contact campaigns" };

const STATUS_LABEL = { DRAFT: "Not started", RUNNING: "Running", FINISHED: "Finished" } as const;
const STATUS_COLOR = { DRAFT: "gray", RUNNING: "blue", FINISHED: "green" } as const;
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });

/** Offers and wake-up calls to the people on the Contacts list (CONTACTS.md). */
export default async function ContactCampaignsPage() {
  await requireAccess("contacts.campaign", "CONTACTS");
  const [campaigns, facets] = await Promise.all([listCampaigns(), loadContactFacets()]);
  return (
    <div className="min-w-0">
      <PageHeader
        title="Campaigns"
        description="Offers, reminders and wake-up calls to the people on your Contacts list."
        actions={
          <>
            <HelpButton moduleTitle="Campaigns">
              <HelpSection title="Email">
                <p>Sent through your own mail server (Settings → Email) at the pace set there. Anyone marked No offers is left out, and the check is repeated just before each email goes.</p>
              </HelpSection>
              <HelpSection title="WhatsApp, Messenger, Instagram, Telegram, SMS and calls">
                <p>These become a list you work through one person at a time. Each person&apos;s message is ready: send it inside the chat if they have written to you before, or open it on your phone. Nothing goes out by itself, because automatic messages to people who did not write first are how a number gets banned.</p>
              </HelpSection>
            </HelpButton>
            <NewCampaignButton knownTags={facets.tags.map((t) => t.tag)} />
          </>
        }
      />
      {campaigns.length === 0 ? (
        <Card>
          <EmptyState>No campaigns yet. Tick people on the Contacts list, or press New campaign to choose by tag.</EmptyState>
        </Card>
      ) : (
        <ul className="space-y-2">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Card className="relative p-3.5 transition-colors hover:border-[var(--color-border-strong)] sm:p-4">
                <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/contacts/campaigns/${c.id}`} className="truncate text-[14.5px] font-semibold after:absolute after:inset-0 hover:underline">
                        {c.name}
                      </Link>
                      <Badge color={STATUS_COLOR[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-[color:var(--color-muted-foreground)]">
                      {CONTACT_CAMPAIGN_CHANNEL_LABEL[c.channel]} · {DATE.format(new Date(c.createdAt))}
                      {c.createdByName ? ` · ${c.createdByName}` : ""}
                    </p>
                  </div>
                  <p className="tabular text-[13px] text-[color:var(--color-muted-foreground)]">
                    <span className="font-semibold text-[color:var(--color-foreground)]">{c.done.toLocaleString("en-US")}</span> done · {c.pending.toLocaleString("en-US")} waiting · {c.skipped.toLocaleString("en-US")} left out
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
