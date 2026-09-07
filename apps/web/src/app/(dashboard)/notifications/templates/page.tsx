import { prisma } from "@support-automation/db";
import { NOTIFICATION_TEMPLATES } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { getTemplateLiveness } from "@/server/notificationTemplateStatus";
import { Alert, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { TemplateCard, type TestTarget } from "./TemplateCard";

/**
 * Every message this system sends that a person reads, in one place, editable.
 *
 * The catalogue comes from code (`NOTIFICATION_TEMPLATES`) and the table holds only overrides, so
 * this page always lists exactly what the worker can actually raise — it cannot drift into showing
 * a template nothing sends, or hiding one that does.
 */
export default async function NotificationTemplatesPage() {
  await requireSession();

  const [overrides, liveness, aiSettings, groups] = await Promise.all([
    prisma.notificationTemplate.findMany({
      include: { updatedBy: { select: { name: true, username: true } } },
    }),
    getTemplateLiveness(),
    prisma.aiSettings.findUnique({ where: { id: "global" }, select: { defaultReplyLanguage: true } }),
    // Only groups a message could actually reach: connected account, still a member. Offering a
    // dead group would produce a test that silently never arrives, which is the opposite of what
    // a test is for. Monitored ones are offered but marked — sending an alert into a monitored
    // group feeds it back in as a message, and a test is exactly when somebody would do that by
    // accident.
    prisma.whatsAppGroup.findMany({
      where: { isActive: true, account: { status: "CONNECTED" } },
      select: { id: true, name: true, isMonitored: true },
      orderBy: [{ isMonitored: "asc" }, { name: "asc" }],
      take: 300,
    }),
  ]);
  const byKey = new Map(overrides.map((row) => [row.key, row]));
  const testGroups: TestTarget[] = groups;

  const customerFacing = NOTIFICATION_TEMPLATES.filter((t) => t.audience === "CUSTOMER");
  const internal = NOTIFICATION_TEMPLATES.filter((t) => t.audience === "TEAM");

  const render = (definition: (typeof NOTIFICATION_TEMPLATES)[number]) => {
    const override = byKey.get(definition.key);
    return (
      <TemplateCard
        key={definition.key}
        definition={definition}
        liveness={liveness[definition.key] ?? { live: true }}
        testGroups={testGroups}
        replyLanguage={aiSettings?.defaultReplyLanguage ?? null}
        customBody={override?.body ?? null}
        updatedAt={
          override
            ? override.updatedAt.toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "Asia/Dhaka",
              })
            : null
        }
        updatedBy={override?.updatedBy?.name ?? override?.updatedBy?.username ?? null}
      />
    );
  };

  return (
    <div>
      <PageHeader
        title="Notification Templates"
        description="The wording of every alert this system sends. Edit any of them, or leave them on the built-in text."
        actions={
          <HelpButton moduleTitle="Notification Templates">
            <HelpSection title="What is on this page">
              <p>
                Every message the system sends that a person reads — the AI handover alert, rule
                alerts, escalation tiers, and the one message that goes into a customer&apos;s own
                group. Each shows a live preview using example values, so you are editing the
                message people will actually see rather than a form full of placeholders.
              </p>
            </HelpSection>
            <HelpSection title="Defaults live in the app, not in a saved copy">
              <p>
                A template you have not edited has no stored row at all — it uses the built-in
                wording, and will pick up any improvement to that wording in a future update.
                <strong> Reset to default</strong> deletes your version rather than copying today&apos;s
                default into place, so a reset template goes back to tracking the app.
              </p>
            </HelpSection>
            <HelpSection title="Placeholders">
              <p>
                <code>{"{{likeThis}}"}</code> is replaced with a real value when the message is
                sent. Each template lists only the placeholders that mean something for it — using
                one from a different template is refused when you save, because it would otherwise
                reach a customer as literal text.
              </p>
              <p>
                Leaving a placeholder out is fine; that detail simply is not shown. A line that
                contains only a placeholder which turns out to be empty is removed, so an
                unassigned case does not send &ldquo;Assigned to:&rdquo; with nothing after it.
              </p>
            </HelpSection>
            <HelpSection title="Why you cannot add a new one">
              <p>
                This list is not a setting — it is the set of moments the software actually has. A
                template added here would be a message nothing ever sends, configured on a page that
                implies it will. If you need an alert for something not listed, that needs building
                into the worker that raises it; ask, and it becomes one more entry here.
              </p>
            </HelpSection>
            <HelpSection title="&ldquo;Not sending right now&rdquo;">
              <p>
                A template shows this when nothing can currently raise it — the feature is off, the
                alert is muted in Notification Center, or nothing exists to trigger it (no rule with
                a notify action, no group with a priority tier). You can still edit and save it;
                preparing wording for something you are about to switch on is normal. The note is
                there so you do not finish, save, and only later discover it never sends.
              </p>
            </HelpSection>
            <HelpSection title="Send a test">
              <p>
                Delivers the <strong>saved</strong> wording, with the example values, to a group you
                pick — clearly labelled as a test so nobody acts on it. A preview shows the text but
                not what WhatsApp does with it, and for the message that tags a team member it is the
                only way to see a real @mention.
              </p>
              <p>
                It goes through the normal send queue, so it arrives in seconds rather than
                instantly, and it lands in a real conversation — prefer a test group. Groups the
                system monitors are marked, because an alert sent into one is read back in as an
                incoming message.
              </p>
            </HelpSection>
            <HelpSection title="Where each one is switched on or off">
              <p>
                This page controls wording only. Whether an alert is raised at all, which channels
                it uses, and which groups receive it are on <strong>Notification Center</strong>.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {customerFacing.length > 0 ? (
        <section className="mb-6">
          <div className="mb-3">
            <Alert tone="warning">
              The message below is posted in a customer&apos;s own conversation. Everything else on
              this page goes to your internal alerts group.
            </Alert>
          </div>
          <div className="space-y-4">{customerFacing.map(render)}</div>
        </section>
      ) : null}

      <section className="space-y-4">{internal.map(render)}</section>
    </div>
  );
}
