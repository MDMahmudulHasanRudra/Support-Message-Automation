/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, HelpButton, HelpSection, Input, Label, PageHeader, Select, SectionHeader, Switch } from "@/components/ui";
import { createTeamsResolutionKeyword } from "@/server/actions/teamsResolutionKeywords";
import { TeamsResolutionKeywordsTable, type TeamsResolutionKeywordRow } from "./TeamsResolutionKeywordsTable";

export default async function TeamsResolutionKeywordsPage() {
  await requireSession();
  const keywords: TeamsResolutionKeywordRow[] = await prisma.teamsResolutionKeyword.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <PageHeader
        title="Resolution Keywords"
        description="Words/phrases in a Teams developer reply that a resolution rule can match."
        actions={
          <HelpButton moduleTitle="Resolution Keywords">
            <HelpSection title="What this page is for">
              <p>
                Keywords are the building blocks of Resolution Rules — reused by the same matcher
                as Support Activity Tracking's own keywords. When a developer's Teams message
                matches an active rule, the linked issue's customer is notified over WhatsApp.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <Card className="mb-6">
        <SectionHeader title="Add Keyword" />
        <form action={createTeamsResolutionKeyword} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Value">
            <Input name="value" placeholder="e.g. resolved" required />
          </Field>
          <Field label="Match Mode">
            <Select name="matchMode" defaultValue="CONTAINS">
              <option value="CONTAINS">Contains</option>
              <option value="EXACT">Exact</option>
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Label>
              <span className="mr-2 inline-flex items-center gap-2">
                <Switch name="caseSensitive" />
                Case sensitive
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

      <TeamsResolutionKeywordsTable keywords={keywords} />
    </div>
  );
}
