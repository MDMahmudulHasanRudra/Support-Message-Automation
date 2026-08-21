import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, HelpButton, HelpSection, Input, Label, PageHeader, Select, SectionHeader, Switch } from "@/components/ui";
import { createSupportKeyword } from "@/server/actions/supportKeywords";
import { SupportKeywordsTable, type SupportKeywordRow } from "./SupportKeywordsTable";

export default async function SupportKeywordsPage() {
  await requireSession();
  const keywords: SupportKeywordRow[] = await prisma.supportKeyword.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <PageHeader
        title="Support Keywords"
        description="Words/phrases a support rule can match against a message body."
        actions={
          <HelpButton moduleTitle="Support Keywords">
            <HelpSection title="What this page is for">
              <p>
                Keywords are the building blocks of Support Rules — a keyword by itself does
                nothing until a Rule references it. Case-insensitive is the default, matching
                every other text-matching convention in this app.
              </p>
            </HelpSection>
            <HelpSection title="Contains vs. Exact">
              <p>
                <strong>Contains</strong> matches the keyword anywhere in the message, at a whole-word
                boundary. <strong>Exact</strong> requires the entire (trimmed) message to equal the
                keyword exactly.
              </p>
            </HelpSection>
            <HelpSection title="Marks completion">
              <p>
                Flags this keyword as a support-session completion signal (e.g. &quot;done&quot;,
                &quot;download&quot;) — when a team member&apos;s message matches it, the group&apos;s
                open support session closes and its resolution time is recorded. This checkbox alone
                does nothing: the keyword still needs to be attached to an active Support Rule (of
                type Keyword Match) scoped to the relevant group/members before it can actually fire.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <Card className="mb-6">
        <SectionHeader title="Add Keyword" />
        <form action={createSupportKeyword} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Value">
            <Input name="value" placeholder="e.g. done" required />
          </Field>
          <Field label="Match Mode">
            <Select name="matchMode" defaultValue="CONTAINS">
              <option value="CONTAINS">Contains</option>
              <option value="EXACT">Exact</option>
            </Select>
          </Field>
          <div className="flex items-end gap-4 pb-2">
            <Label>
              <span className="mr-2 inline-flex items-center gap-2">
                <Switch name="caseSensitive" />
                Case sensitive
              </span>
            </Label>
            <Label>
              <span className="mr-2 inline-flex items-center gap-2">
                <Switch name="marksCompletion" />
                Marks completion
              </span>
            </Label>
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        </form>
      </Card>

      <SupportKeywordsTable keywords={keywords} />
    </div>
  );
}
