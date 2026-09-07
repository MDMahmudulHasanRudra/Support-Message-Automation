import { prisma } from "@support-automation/db";
import { NOTIFICATION_TEMPLATES } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { Alert, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { TemplateCard } from "./TemplateCard";

/**
 * Every message this system sends that a person reads, in one place, editable.
 *
 * The catalogue comes from code (`NOTIFICATION_TEMPLATES`) and the table holds only overrides, so
 * this page always lists exactly what the worker can actually raise — it cannot drift into showing
 * a template nothing sends, or hiding one that does.
 */
export default async function NotificationTemplatesPage() {
  await requireSession();

  const overrides = await prisma.notificationTemplate.findMany({
    include: { updatedBy: { select: { name: true, username: true } } },
  });
  const byKey = new Map(overrides.map((row) => [row.key, row]));

  const customerFacing = NOTIFICATION_TEMPLATES.filter((t) => t.audience === "CUSTOMER");
  const internal = NOTIFICATION_TEMPLATES.filter((t) => t.audience === "TEAM");

  const render = (definition: (typeof NOTIFICATION_TEMPLATES)[number]) => {
    const override = byKey.get(definition.key);
    return (
      <TemplateCard
        key={definition.key}
        definition={definition}
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
