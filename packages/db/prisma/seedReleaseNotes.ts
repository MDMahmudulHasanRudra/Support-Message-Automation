import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Release Notes seeded from this repository's own git history — never invoked by the routine
 * `pnpm db:seed`.
 *
 * It began as a one-time historical backfill and still is one for v0.1.0–v0.14.0. It now also
 * carries the current release, because `DATABASE_URL` points at a host only reachable from inside
 * the Compose network, so a release note cannot be typed in from a developer's shell — and this
 * script is already idempotent by version, already wired to `pnpm db:seed:release-notes`, and
 * already the established way rows reach this table without the admin UI. A second script would
 * be a second answer to a question this one answers.
 *
 * A current release is entered as a DRAFT (see `status` below). Only a person publishes.
 *
 * `prisma/seed.ts` creates baseline/config data every fresh install needs and is safe to re-run on
 * every deploy. This is different in kind: it is historical content, reconstructed once from real
 * commit dates and real commit messages (`git log --reverse --date=short`), not something a fresh
 * install should ever recreate. Run it by hand, once, against a database that has never had it run
 * before: `pnpm db:seed:release-notes` (from the repo root; needs `DATABASE_URL` pointed at the
 * target database, same as `pnpm db:seed` itself).
 *
 * **Every version below is invented by this script — there is no real version history in this
 * repository to reconstruct** (zero git tags, every `package.json` still at the scaffolded
 * "0.1.0", no `CHANGELOG.md`). The RELEASE DATES and the CONTENT of every bullet are not invented:
 * each is grounded in a real, dated commit, cross-checked against this codebase's own
 * `CLAUDE.md`/`PROJECT_REFERENCE.md` for accuracy. Purely operational commits (repository merges,
 * a GitLab history-join, deployment/port-change status updates, planning-only commits that
 * describe no shipped change) are deliberately excluded — a changelog entry should describe
 * something a user of the product would notice, not a git or ops event.
 *
 * Idempotent by `version`, matching this file's own `update: {}` convention elsewhere in
 * `prisma/seed.ts`: re-running this after a release has already been created, or after an admin has
 * since edited it by hand, changes nothing — it never overwrites live content.
 *
 * Each row is inserted already PUBLISHED, with a matching `ReleaseNoteRevision` version 1 — the
 * same pair of writes `transitionReleaseNoteStatus("PUBLISH")` would have produced had this gone
 * through the admin UI on the day it shipped, so any future edit's revision numbering starts
 * correctly at 2. `createdByUserId`/`publishedByUserId` are left null: nobody specifically
 * published these through the app, and both columns are nullable for exactly this case.
 */

interface HistoricalRelease {
  version: string;
  title: string;
  releaseDate: string; // YYYY-MM-DD
  releaseType: "MAJOR" | "FEATURE" | "IMPROVEMENT" | "BUG_FIX" | "SECURITY" | "MAINTENANCE";
  /**
   * Defaults to PUBLISHED, which is right for the fourteen backfilled releases: they describe work
   * that shipped months ago, and recording them as drafts would be a fiction.
   *
   * A release for work that has only just landed is a DRAFT instead. Publishing is outward-facing
   * — it appears for every user of the dashboard — and a PUBLISHED release can never be deleted by
   * any path, so that decision belongs to whoever reviews the wording, one click away on the
   * release's own detail page (which doubles as the publish preview).
   */
  status?: "DRAFT" | "PUBLISHED";
  affectedModules: string[];
  whatsNew?: string[];
  improvements?: string[];
  bugFixes?: string[];
  security?: string[];
  breakingChanges?: string[];
  knownIssues?: string[];
  technicalNotes?: string[];
}

const RELEASES: HistoricalRelease[] = [
  {
    version: "0.1.0",
    title: "Foundation: the WhatsApp automation platform",
    releaseDate: "2026-08-11",
    releaseType: "MAJOR",
    affectedModules: [
      "Messages",
      "Automation Rules",
      "Bulk Messaging",
      "WhatsApp Accounts & Groups",
      "System & Settings",
    ],
    whatsNew: [
      "A rule-based automation engine deciding what happens to every incoming WhatsApp message",
      "The OpenWA WhatsApp provider, with QR pairing and session persistence",
      "The message pipeline, the outbound send queue, and notifications",
      "Group Message Sender: broadcast to many groups from an Excel file or a manual list",
      "Group Management: search, filters, pagination, and bulk monitoring toggles",
      "Message Monitoring: a unified list with filters and a detail view",
      "Logging a WhatsApp account out from the dashboard",
    ],
    improvements: [
      "A shared design system and redesigned app shell, applied across every existing page — Overview, Accounts, Groups, Messages, Automation Rules, Rule Tester, Group Message Sender, Automation Control, Notifications, System Logs, Settings, Team Members, and Login",
    ],
    bugFixes: [
      "A keyword matcher that could match inside another word instead of only on a whole-word boundary",
      "Group Message Sender misreporting its own sends as duplicates because of a cooldown self-match",
    ],
    technicalNotes: [
      "Monorepo foundation, Docker Compose topology, and the full initial database schema",
      "An integration test suite (mocked provider, real Postgres)",
    ],
  },
  {
    version: "0.2.0",
    title: "Username login, and a second number for notifications",
    releaseDate: "2026-08-12",
    releaseType: "IMPROVEMENT",
    affectedModules: ["WhatsApp Accounts & Groups", "Notifications", "Users & Permissions"],
    whatsNew: [
      "Add Number to Groups: add a phone number across many groups at once",
      "Support for more than one WhatsApp group as a notification destination",
    ],
    improvements: ["Login switched from email to username", "A page-size selector on the Groups list"],
    bugFixes: [
      "A false hydration-mismatch warning caused by a browser extension, not the app itself",
      "The Groups page crashing on every load right after the page-size selector shipped",
    ],
  },
  {
    version: "0.3.0",
    title: "AI Learning, Priority Support Escalation, multi-account routing",
    releaseDate: "2026-08-13",
    releaseType: "MAJOR",
    affectedModules: ["AI Learning", "Escalations", "WhatsApp Accounts & Groups"],
    whatsNew: [
      "AI Learning & Knowledge System",
      "Priority-Based Support Monitoring & Escalation",
      "Multi-account selection & routing for WhatsApp sends",
    ],
    bugFixes: [
      "Migrations and the database seed now run automatically instead of needing a manual step",
      "A stale WhatsApp connection status that didn't reflect the real session state",
    ],
  },
  {
    version: "0.4.0",
    title: "Conversation Learning, and a rebuilt command-center dashboard",
    releaseDate: "2026-08-15",
    releaseType: "MAJOR",
    affectedModules: ["Conversation Learning", "Notifications", "System & Settings"],
    whatsNew: [
      "Conversation Learning: real conversations are grouped into sessions, recurring patterns are scored with zero AI calls, and a human reviews and approves each one before it can ever become a rule",
      "An optional AI-assisted analysis pass for Conversation Learning, off by default",
      "Unknown Pattern Detection: an alert when a recurring question keeps going unanswered by any rule",
      "Overview rebuilt as a true command center — 8 KPI tiles, 8 module cards, and a message-activity chart",
    ],
    bugFixes: [
      "Notification alerts showed a raw WhatsApp group ID instead of its name",
      "Media messages (images, video, documents) stored unreadable base64 data instead of a plain label like \"[Image]\"",
      "Overview showed raw phone numbers instead of resolved sender names",
      "Server-rendered times didn't consistently use the Asia/Dhaka timezone",
      "A WhatsApp QR pairing that could hang indefinitely if the underlying library stalled",
      "The dashboard's own scrolling could drag the sidebar along with the page content",
    ],
    technicalNotes: [
      "A fully isolated, throwaway test database, so running the test suite can never touch real customer conversations again",
    ],
  },
  {
    version: "0.5.0",
    title: "AI Admin Assistant, and Microsoft Teams Integration",
    releaseDate: "2026-08-19",
    releaseType: "FEATURE",
    affectedModules: ["AI Learning", "Teams Integration", "Support Activity"],
    whatsNew: [
      "A floating AI Admin Assistant chat, answering questions from live system data on any dashboard page",
      "Microsoft Teams Integration: link a Teams conversation to a customer's WhatsApp conversation, with one-click connection",
    ],
    improvements: ["Support Activity Tracking, phase 2"],
  },
  {
    version: "0.6.0",
    title: "Support Session tracking",
    releaseDate: "2026-08-21",
    releaseType: "FEATURE",
    affectedModules: ["Support Activity"],
    whatsNew: [
      "Support Session tracking: who is handling a conversation, and for how long, across every monitored group",
      "A cross-group view of every session currently in progress",
    ],
  },
  {
    version: "0.7.0",
    title: "WhatsApp Chat inbox, and AI that can answer customers directly",
    releaseDate: "2026-08-30",
    releaseType: "MAJOR",
    affectedModules: ["WhatsApp Chat", "AI Learning", "Support Activity", "WhatsApp Accounts & Groups"],
    whatsNew: [
      "A WhatsApp-Web-style Chat inbox inside the dashboard",
      "Automation by AI: the assistant can answer a customer directly once the rule engine has no match, in groups that opt in",
      "A Knowledge Center: import your own documentation and review it before the assistant can use it",
      "OpenRouter and Ollama as AI providers",
      "The support roster can be populated straight from a WhatsApp group's own member list",
    ],
    improvements: [
      "Any message a team member sends now counts as support activity, and AI-handled conversations are credited too",
      "What the AI knows is now kept separate from what it has the authority to tell a customer",
      "Linking a new WhatsApp number opens a full-size QR dialog, and the Accounts page stops polling once nothing is left to wait for",
    ],
    bugFixes: [
      "Team members were being recognised by comparing raw strings, which never actually matched — recognition now normalises to digits first",
      "A second WhatsApp account could fail to produce a QR because its session directory didn't exist yet",
    ],
  },
  {
    version: "0.8.0",
    title: "Reliability fixes, and a Knowledge Center that reads real documents",
    releaseDate: "2026-09-03",
    releaseType: "IMPROVEMENT",
    affectedModules: ["AI Learning", "Automation Rules", "Notifications"],
    whatsNew: [
      "The Knowledge Center can build from links, PDFs, Word documents and spreadsheets, not just pasted text",
      "The assistant can learn about the ISPDIGITAL product directly from its own source repository",
    ],
    bugFixes: [
      "A failing rule could silently lose the message it was processing",
      "The same alert could be sent up to eight times instead of once",
      "An OpenRouter model that looked configured but silently failed to answer",
      "Rate limits could go silent on a customer mid-conversation instead of queuing their reply",
    ],
    improvements: [
      "\"Today\" is now defined consistently everywhere, instead of each page deciding its own day boundary",
      "The dashboard chart no longer reads every message in the table to draw itself",
      "The assistant answers in Bangla by default, and only switches language on real evidence",
    ],
    technicalNotes: ["Indexed the columns the app actually queries, and an import now remembers where its data came from"],
  },
  {
    version: "0.9.0",
    title: "Support Activity rebuilt, Notification Center, four response modes",
    releaseDate: "2026-09-05",
    releaseType: "IMPROVEMENT",
    affectedModules: ["Support Activity", "Notifications", "AI Learning"],
    whatsNew: [
      "Notification Center: every alert now has an identity and its own routing, instead of one shared destination for everything",
      "Direct alerts to a specific person, not only to the group they are in",
      "Four AI response modes, from verified-knowledge-only up to live product research plus general knowledge",
      "Google Gemini as an AI provider",
      "The assistant can research an answer directly from the product's source when nothing is written down yet",
    ],
    improvements: [
      "Support Activity rebuilt around who handled what, and for how long",
      "Presence: online the moment someone messages, offline after two hours of silence",
      "The console is now usable with a finger, not just a mouse",
      "The AI has learned how the team actually talks, from the team's own replies",
      "The reply language is now a real dropdown, not a free-text guess",
    ],
    bugFixes: [
      "The team's communication-style builder was silently reading 2 replies instead of 336",
      "The reply-language setting wasn't actually saving",
    ],
    technicalNotes: ["Teams export shipped; the remaining part of that phase was intentionally left unbuilt, and why is documented"],
  },
  {
    version: "0.10.0",
    title: "Softify Assist gets its name, and every message becomes editable",
    releaseDate: "2026-09-07",
    releaseType: "FEATURE",
    affectedModules: ["Notifications", "AI Learning", "WhatsApp Accounts & Groups", "System & Settings"],
    whatsNew: [
      "The product now has a name: Softify Assist",
      "Automatic reply-language detection, matching the customer's own script",
      "Adding several team members to a group at once, skipping anyone already in it",
      "A relink path for replacing a WhatsApp number, instead of a confusing second account",
    ],
    improvements: [
      "Every message the system sends is now editable, with a live preview before saving",
      "Each message template now says plainly whether it can currently send",
      "The knowledge base is searched in the language it was written in",
      "A follow-up question is now read as a follow-up, not a brand-new one",
    ],
    technicalNotes: ["The Forge integration stopped inventing troubleshooting steps nobody had actually documented"],
  },
  {
    version: "0.11.0",
    title: "See who nobody has answered yet",
    releaseDate: "2026-09-08",
    releaseType: "IMPROVEMENT",
    affectedModules: ["Support Activity"],
    whatsNew: [
      "A view of customers nobody has answered yet",
      "Four more dashboard charts, each answering a question worth acting on",
    ],
    improvements: ["The assistant now gives the steps to follow, not just the answer, when steps were already written down"],
    bugFixes: [
      "\"Nothing new to learn from\" was being reported as an error",
      "A setting that had no effect on anything was removed",
    ],
  },
  {
    version: "0.12.0",
    title: "Message collection reliability, and a rebuilt chat inbox",
    releaseDate: "2026-09-11",
    releaseType: "MAJOR",
    affectedModules: ["WhatsApp Chat", "Messages", "WhatsApp Accounts & Groups"],
    whatsNew: [
      "Pin, categorise and archive conversations in the Chat inbox",
      "Every conversation now shows a face, and its thread reads like a real conversation",
      "Saved replies in the composer, and drafts that survive leaving a conversation",
      "Bulk \"mark as read\" for waiting conversations",
      "Every dashboard figure is now a way into the real rows behind it",
    ],
    bugFixes: [
      "A dropped WhatsApp session could stop collecting messages entirely with no visible symptom — the listener is now rewired, a gap after reconnecting is filled automatically, and a dropped session reconnects itself",
      "One unscanned QR code could hold up the entire worker process",
      "A message stranded mid-pipeline by a crash is now finished automatically instead of sitting silently unprocessed",
      "The health check could report the worker as fine while it was actually collecting nothing",
      "Assigning a category moved zero conversations, because of a NULL comparison that matched nothing",
      "Opening a conversation now clears it from \"waiting\"; a queued reply already counts as an answer, whether a person or the AI sent it",
    ],
    improvements: ["Search now reaches all 1,856 groups, not just the 300 shown on screen"],
    technicalNotes: ["The two properties that stop a duplicate reply on shutdown are now pinned down explicitly"],
  },
  {
    version: "0.13.0",
    title: "Team Management",
    releaseDate: "2026-09-12",
    releaseType: "MAJOR",
    affectedModules: ["Team Management"],
    whatsNew: ["Team Management: shifts, weekly duty schedules, a daily roster, leave management, and WhatsApp-based attendance"],
    improvements: [
      "Attendance is derived as evidence from real group activity, never a presence claim — a scheduled day with no messages reads \"no activity recorded\", never \"absent\"",
      "Coverage accounts for approved leave, so a shift reads as genuinely short-staffed rather than just looking empty",
    ],
  },
  {
    version: "0.14.0",
    title: "Dashboard status indicators, and Release Notes",
    releaseDate: "2026-09-13",
    releaseType: "IMPROVEMENT",
    affectedModules: ["System & Settings", "Release Notes"],
    whatsNew: ["Release Notes: this changelog"],
    improvements: ["The Overview dashboard now shows real system status, worker liveness, and a consolidated list of what needs attention"],
  },
  {
    version: "0.15.0",
    title: "AI that answers with your steps, and the audit that hardened it",
    releaseDate: "2026-09-16",
    releaseType: "FEATURE",
    // DRAFT: this describes work that landed today. Somebody reads it and presses Publish.
    status: "DRAFT",
    affectedModules: [
      "AI Learning",
      "Conversation Learning",
      "Support Activity",
      "Notifications",
      "System & Settings",
    ],
    whatsNew: [
      "AI Sandbox: ask a question the way a customer would and see exactly what the live system would have done — the answer it would have drafted, how confident it was, and which gate would have stopped it. Nothing is sent, no customer is involved, and no rate limit is spent.",
      "Knowledge Builder: pick the groups and the date range you want, and the AI proposes question-and-answer entries from those conversations for you to edit, approve or reject — instead of waiting for the hourly job to reach them.",
      "Knowledge entries can now carry step-by-step instructions, and the AI actually uses them. Ask \"how do I record a payment\" and the reply names the real screens in the real order, taken from what your team wrote down.",
      "Support Sessions in Reports can be closed in bulk. Select the open rows and close them together instead of one at a time.",
      "The sidebar collapses to icons and remembers your choice.",
      "A named visual theme, Midnight Indigo, applied consistently across the dashboard in light and dark mode.",
    ],
    improvements: [
      "Before writing an answer, the system now works out what your knowledge actually supports. If two different documented procedures apply, it offers them as separate labelled options instead of merging them into a sequence that exists nowhere. If a how-to question has no documented steps at all, it says so plainly and hands over, rather than assembling something plausible.",
      "Questions written in Banglish or Bengali now find knowledge written in English. Most customers do not write in the language most entries are stored in, and the search now bridges that instead of coming back empty.",
      "A single weak keyword match no longer stops that wider search from running — which is what used to happen most often to exactly the questions that needed it.",
      "Knowledge matching is whole-word now, so \"net\" no longer matches \"internet\", \"network\" or \"cabinet\" and invents a connection between unrelated entries.",
      "A follow-up question is understood as a follow-up. \"Does the same apply for this client?\" used to be answered as though it were the first thing anyone had said.",
      "Longer replies are allowed, so a step-by-step answer in Bengali is no longer cut off and handed over when it was very nearly finished.",
      "Every handover reason in the AI Activity log is explained in plain language beside its code, so nobody has to guess what stopped a reply.",
      "The Overview dashboard no longer leaves blank gaps in its chart grid, and its spacing is tighter.",
    ],
    bugFixes: [
      "Muting the WhatsApp channel for AI handover alerts silently destroyed the whole handover — no record, no tag in the group, no research queued — while making the dashboard look healthier. Muting one channel now only mutes that channel.",
      "When the AI tagged a colleague for help in a customer's group, that tag was counted as though the AI had answered. The next message was blocked, the block raised another tag, and the cycle sustained itself: a customer writing every few minutes could never be answered again, and watched your team be tagged over and over. The tag is no longer mistaken for an answer, and a conversation is tagged once rather than once per message.",
      "The same customer could receive two AI answers to two questions sent seconds apart.",
      "A message the system retried after an interruption alerted the team twice, tagged the group twice, and queued the same question for research twice.",
      "A retried message could have its finished reply silently discarded — the customer saw the request for help and never the answer, with nothing recorded as failed.",
      "A reply limit of 0 blocked every outbound message, including replies typed by hand in the chat inbox, while reporting the self-contradicting \"limit reached (0/0)\". Zero can no longer be saved; the switch for turning limits off is Rate limiting enabled.",
      "Clearing a number field on a settings form and saving wrote 0 rather than keeping the current value. On the confidence threshold that meant the AI sent whatever it drafted.",
      "A reply typed on the business handset did not close an open escalation case, so the alert ladder kept escalating a conversation a colleague had already answered.",
      "Bengali words were being broken apart by the recurring-pattern detector, so Bengali conversations barely registered as patterns at all.",
      "A customer sending only a screenshot, voice note or sticker used to receive a confident generic reply to something nobody had looked at. Those are handed to a person now.",
      "An answer cut short by the length limit is handed over instead of being sent half-finished.",
      "Step-by-step instructions typed into a knowledge entry reached no customer: the field was shown to the AI but never searched, so the entry whose steps named the exact screen lost its place to a vaguer one.",
      "Exporting the knowledge base to a spreadsheet, editing it and importing it back silently dropped every set of steps it carried.",
    ],
    security: [
      "The downloadable knowledge import template contained two invented product facts — a reset procedure and a claim about staffed support hours that contradicted this deployment's own shift times. Nothing marked them as examples, and the normal workflow is to download the template, add rows and upload it, so they landed in the review queue looking like well-written entries, one click from being quoted to a customer as fact. The sample row now asserts nothing and is refused if uploaded unedited.",
      "Knowledge entries now start unverified. Human verification is the only thing standing between a draft entry and a customer, and it used to be something a writer had to opt out of rather than into.",
      "Product knowledge read from the source repository now skips test data, seed files, samples and drafts, which were previously summarised into guides exactly as though they were real documentation.",
      "A mechanical check now blocks a reply that gives numbered instructions when nothing in the reference material documented any. Asked for confident navigation, a model will invent a screen; being told not to is a request, and this is the check.",
      "The automated test suite now refuses to run against anything but a throwaway database. One of these tests deliberately writes a verified knowledge entry stating a refund policy that does not exist.",
    ],
    knownIssues: [
      "Images, voice notes and stickers cannot be read. A message containing only media is handed to a person rather than answered.",
      "The token figure in the AI Activity log counts the answer itself, not the extra searches or live research a message may also have paid for. Treat it as the cost of the answer, not of the message.",
      "Answering from the product's own source while the customer waits requires the Softify Forge integration to be configured, enabled and pointed at a project.",
    ],
    technicalNotes: [
      "Four database migrations are committed but not yet deployed. Run the migration deploy before this release goes live, or queries touching the newly added columns will fail.",
      "742 automated tests pass across the rule engine, shared, AI client and worker suites, 535 of them in the worker. Integration tests must be run against the isolated throwaway database, never the live one.",
    ],
  },
];

async function main() {
  let created = 0;
  let skipped = 0;

  for (const release of RELEASES) {
    const existing = await prisma.releaseNote.findUnique({ where: { version: release.version }, select: { id: true } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const releaseDate = new Date(`${release.releaseDate}T00:00:00.000Z`);
    const status = release.status ?? "PUBLISHED";
    const content = {
      title: release.title,
      summary: null,
      releaseDate,
      releaseType: release.releaseType,
      // Shared with the revision snapshot below — ReleaseNoteRevision.status is required, and
      // this is genuinely what status the content was AT, matching the pattern
      // `transitionReleaseNoteStatus("PUBLISH")` itself uses.
      status,
      whatsNew: release.whatsNew ?? [],
      improvements: release.improvements ?? [],
      bugFixes: release.bugFixes ?? [],
      security: release.security ?? [],
      breakingChanges: release.breakingChanges ?? [],
      knownIssues: release.knownIssues ?? [],
      technicalNotes: release.technicalNotes ?? [],
      affectedModules: release.affectedModules,
    };

    // Interactive form (not the array form): the revision needs the id the create below produces,
    // which the array form of $transaction can't express — same pattern already used for the
    // publish transition itself in server/actions/releaseNotes.ts.
    await prisma.$transaction(async (tx) => {
      const row = await tx.releaseNote.create({
        data: {
          version: release.version,
          // A DRAFT has never been public, so there is no prior public state to snapshot and
          // nothing to number: `currentVersion` stays 0 and revision v1 is written by the publish
          // itself, exactly as `transitionReleaseNoteStatus("PUBLISH")` does it. Writing a
          // revision here would make the real publish start numbering at 2 and claim an edit
          // history that never happened.
          currentVersion: status === "PUBLISHED" ? 1 : 0,
          publishedAt: status === "PUBLISHED" ? releaseDate : null,
          ...content,
        },
        select: { id: true },
      });
      if (status === "PUBLISHED") {
        await tx.releaseNoteRevision.create({ data: { releaseNoteId: row.id, version: 1, ...content } });
      }
    });

    created += 1;
    const label = status === "PUBLISHED" ? "" : " [DRAFT — review and publish from the dashboard]";
    console.log(`Created v${release.version} — ${release.title} (${release.releaseDate})${label}`);
  }

  console.log(`\nDone. ${created} release note(s) created, ${skipped} already existed and were left untouched.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
