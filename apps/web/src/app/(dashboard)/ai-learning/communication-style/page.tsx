/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { Alert, Card, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile } from "@/components/ui";
import { getCommunicationStyleProfile } from "@/server/actions/communicationStyle";
import { StyleProfileCard } from "./StyleProfileCard";

/**
 * Where an operator reads what the assistant learned about how their team talks, and decides
 * whether it may use it.
 *
 * The page leads with the guidance itself rather than with settings, because the only question
 * worth asking here is "is this actually how we sound" — and that can only be answered by reading
 * it.
 */
export default async function CommunicationStylePage() {
  await requireSession();

  const [profile, aiSettings, approver] = await Promise.all([
    getCommunicationStyleProfile(),
    prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.communicationStyleProfile
      .findUnique({ where: { id: "global" }, select: { approvedBy: { select: { name: true } } } })
      .then((row) => row?.approvedBy?.name ?? null),
  ]);

  const learningOn = aiSettings.communicationStyleLearningEnabled;
  const live = profile.humanApproved && Boolean(profile.guidance?.trim());

  return (
    <div>
      <PageHeader
        title="Communication Style"
        description="Teaches the AI how your team talks to customers, learned from the replies your executives actually sent."
        actions={
          <HelpButton moduleTitle="Communication Style">
            <HelpSection title="What this learns">
              <p>
                Manner, not facts. How your team opens a reply, how formal they are, how long their
                answers run, how they acknowledge a problem before solving it, how they close. The
                assistant then writes the same way, instead of sounding like a generic bot.
              </p>
            </HelpSection>
            <HelpSection title="What it will never learn">
              <p>
                Anything about the product itself. A line that states a price, a duration, a policy
                or a promise is dropped before it is ever stored — those are facts, and facts come
                from the knowledge base, which has its own verification. Customer numbers, emails
                and links are stripped out of the replies before the AI ever reads them.
              </p>
            </HelpSection>
            <HelpSection title="Why it needs your approval">
              <p>
                A wrong knowledge entry produces one wrong answer. Wrong style guidance shapes every
                answer, and there is no per-reply review to catch it. So nothing here reaches a
                customer until you have read it and approved it — and every rebuild clears that
                approval, so new wording never inherits the trust you gave the old.
              </p>
            </HelpSection>
            <HelpSection title="Where it sits">
              <p>
                Style never overrides the language rules, the business-question guard, or a fact
                from the knowledge base. If the tone suggests being reassuring and there is nothing
                to reassure with, the conversation still goes to a human.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {!aiSettings.aiEngineEnabled ? (
        <div className="mb-5">
          <Alert tone="warning">
            The AI engine is off, so nothing here runs.{" "}
            <Link className="link" href="/ai-learning/settings">
              Turn it on in AI Settings
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Status"
          value={live ? "In use" : learningOn ? "Not applied" : "Off"}
          hint={
            live
              ? "Every AI reply follows this"
              : learningOn
                ? "Learned, but waiting for your approval"
                : "Learning is switched off"
          }
        />
        <StatTile
          label="Replies studied"
          value={profile.messagesAnalyzed}
          hint={profile.messagesAnalyzed > 0 ? "Written by your team" : "Nothing analysed yet"}
        />
        <StatTile
          label="Last rebuilt"
          value={profile.lastBuiltAt ? formatDateTime(profile.lastBuiltAt) : "Never"}
          hint={approver && profile.humanApproved ? `Approved by ${approver}` : "Rebuilds every 12 hours"}
        />
      </div>

      {profile.lastError ? (
        <div className="mb-5">
          <Alert tone="info">{profile.lastError}</Alert>
        </div>
      ) : null}

      <StyleProfileCard
        learningEnabled={learningOn}
        aiEngineEnabled={aiSettings.aiEngineEnabled}
        guidance={profile.guidance}
        approved={profile.humanApproved}
      />

      <div className="mt-5">
        <Card>
          <SectionHeader
            title="Where the examples come from"
            description="Only genuine human replies — never the assistant's own output."
          />
          <ul className="space-y-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            <li>
              <strong className="text-[color:var(--color-foreground)]">Replies sent from your business
              number</strong> that this system did not send itself. If an executive typed it, it counts.
            </li>
            <li>
              <strong className="text-[color:var(--color-foreground)]">Messages from people on your team
              roster</strong> replying from their own numbers.
            </li>
            <li>
              Anything the automation or the AI sent is excluded — learning tone from its own output
              would tighten a loop around whatever voice it started with.
            </li>
            <li>
              Your internal notification groups are excluded too. Machine-written alerts are not how
              anyone talks to a customer.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
