import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Release Notes seeded from this repository's own git history. Runs on every deploy after the migrations (the
 * `migrate` service): add-only by version, so nothing an admin edited or removed is touched.
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
    title: "Procedure-aware AI, real duty hours, and a second way to link WhatsApp",
    releaseDate: "2026-09-16",
    releaseType: "FEATURE",
    affectedModules: [
      "AI Learning",
      "Conversation Learning",
      "Support Activity",
      "Team Management",
      "WhatsApp Accounts & Groups",
      "Messages",
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
      "Link a WhatsApp account by phone number. WhatsApp offers two official ways to link a device, and this software only used one: alongside scanning a QR code, you can now enter the account's number, get a code back, and type that code into Linked devices on the phone. Useful when nobody can hold a phone up to the screen - a remote server, a number in another office. The QR remains the default and is unchanged.",
      "Duty History shows the hours actually worked, not only the shift that was planned. Each day now carries the first and last message stored from that person and the span between them, beside the shift they were rostered onto.",
      "Duty History flags a late start or an early finish against that day's own shift times, past a grace period you set. A smaller overrun is still shown - it is simply not called late.",
      "A By person view of Duty History folds a date range into one row per colleague, so \"who was late most often this fortnight\" is a glance rather than a scroll.",
      "Summary tiles above Duty History: days scheduled, days with activity, late starts, and the typical day for the range on screen.",
      "Expand any Duty History row to see which groups that person worked in that day, with the message count and the first and last time for each.",
      "Export Duty History to CSV or Excel, honouring the filters and the view currently on screen - for timesheet and payroll conversations.",
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
      "A manual attendance correction now shows who made it, when, and why, beside the evidence it was laid over - so \"marked absent, and there were forty messages\" stays readable as exactly that.",
      "The punctuality grace periods live in Team Management then Settings rather than in the software's source, so what counts as late is your decision and can be changed.",
      "Logging an account out now also forgets the number it was set to pair with, so the next attempt asks for the new one instead of quietly reusing the number that just left.",
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
      "The missed-message catch-up dropped every reply that quoted another message - 29 of the 706 messages recovered on the first production run. The history WhatsApp returns carries a quoted message's id in a different shape to the live listener, and only one of the two was understood.",
      "Two example team members reappeared in the live roster after being deleted, because the start-up seed recreated them on every redeploy. They would have sat in schedules, attendance and duty planning as though they were staff. Examples now seed only into an empty roster.",
      "Choosing a different linking method while a connection attempt was already running did nothing at all. The new attempt silently rejoined the old one, so the method picked was never used and the dialog waited for a code that could not arrive.",
      "The linking dialog contradicted itself: selecting the phone-number option left the QR instructions on screen, and showed a spinner claiming to wait for a code before any number had been entered.",
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
      "A link code is issued once per attempt and is not refreshed, unlike the QR code which rotates until it is scanned. If it expires, ask for a new one.",
    ],
  },
  {
    version: "0.16.0",
    title: "Smarter answers and link by phone number",
    summary: "AI finds the right knowledge more often, and a number can be linked without scanning a QR code.",
    releaseDate: "2026-09-18",
    releaseType: "FEATURE",
    affectedModules: [
      "AI Learning",
      "WhatsApp Accounts & Groups"
    ],
    whatsNew: [
      "Link a WhatsApp number with a phone code as well as by QR",
      "Message reactions, editing, and creating or joining groups from the number"
    ],
    improvements: [
      "AI ranks your knowledge by how well it fits the question, not just by matching words"
    ],
    bugFixes: []
  },
  {
    version: "0.17.0",
    title: "Roles enforced everywhere, and a safer way to add numbers",
    summary: "What a role allows now applies on every page and every button.",
    releaseDate: "2026-09-23",
    releaseType: "IMPROVEMENT",
    affectedModules: [
      "Users & Permissions",
      "Bulk Messaging",
      "WhatsApp Accounts & Groups"
    ],
    whatsNew: [
      "Add Number to Groups checks who is already a member before adding anyone",
      "Only the Primary number answers customers; other numbers collect"
    ],
    improvements: [
      "The sidebar shows only the pages a role can open",
      "Large lists can be selected, filtered and handled in bulk",
      "The Accounts page says what a link attempt is actually doing"
    ],
    bugFixes: []
  },
  {
    version: "0.18.0",
    title: "Team Report, Teams and a tidier sidebar",
    summary: "See each member's support work by day, week and month.",
    releaseDate: "2026-09-27",
    releaseType: "FEATURE",
    affectedModules: [
      "Reports",
      "Team",
      "AI Learning",
      "Navigation"
    ],
    whatsNew: [
      "Team Report: groups supported, replies, customer waits, missed and recall support, for one person or the whole team",
      "Teams, with a Team filter that follows who was in the team at the time",
      "AI Sandbox: correct an AI answer, verify it and save it as knowledge",
      "AI can tell a customer when it could not understand them"
    ],
    improvements: [
      "Ten collapsible modules instead of fifty always-open rows",
      "All settings in one Settings module",
      "All Reports hub"
    ],
    bugFixes: []
  },
  {
    version: "0.19.0",
    title: "Multiple projects",
    summary: "One installation can run many separate projects, with each one's data kept apart.",
    releaseDate: "2026-09-29",
    releaseType: "MAJOR",
    affectedModules: [
      "Main Admin",
      "Projects"
    ],
    whatsNew: [
      "Projects: separate data, people and settings for each",
      "Main Admin Portal to create projects and decide who may enter them",
      "Switch modules on or off per project"
    ],
    improvements: [
      "The database itself refuses data crossing between projects"
    ],
    bugFixes: []
  },
  {
    version: "0.20.0",
    title: "Main Admin workspace and support reports",
    summary: "Work in every project from one screen, with eleven new reports.",
    releaseDate: "2026-10-01",
    releaseType: "FEATURE",
    affectedModules: [
      "Main Admin",
      "Reports"
    ],
    whatsNew: [
      "Main Admin workspace: open any module with your projects as tabs",
      "Departments, job titles and employee records",
      "Eleven support reports with common filters"
    ],
    improvements: [
      "Project access levels: read, write or full"
    ],
    bugFixes: []
  },
  {
    version: "0.21.0",
    title: "Support Intelligence and running jobs on every page",
    summary: "Deeper reports, and long WhatsApp jobs you can follow from anywhere.",
    releaseDate: "2026-10-05",
    releaseType: "FEATURE",
    affectedModules: [
      "Reports",
      "WhatsApp Accounts & Groups",
      "Messages",
      "Mood Detection"
    ],
    whatsNew: [
      "Groups Admin Maker: make one member an admin in every group your number administers",
      "A job indicator on every page for Add to Groups and Admin Maker",
      "Unanswered Groups and Response Time for your Support Team",
      "Support Intelligence: human response times, cases, effectiveness and customer signals",
      "Executive Support Health and Inactive Groups reports",
      "Mood Detection notices upset customers and acts only as you choose"
    ],
    improvements: [
      "WhatsApp Chat shows one number at a time with real totals, and replies go out from that number only",
      "Report times always read as hours and minutes"
    ],
    bugFixes: []
  },
  {
    version: "0.22.0",
    title: "Support Assignment, personal chats, Google Sheets and more channels",
    summary: "Assign waiting customers, answer personal chats and bring in Messenger, Instagram and Telegram.",
    releaseDate: "2026-10-11",
    releaseType: "FEATURE",
    affectedModules: [
      "Support Assignment",
      "WhatsApp Chat",
      "All Conversations",
      "Google Sheets",
      "Branding"
    ],
    whatsNew: [
      "Support Assignment: give a waiting customer to a person, follow the deadline and alert when it passes",
      "All Conversations: Messenger, Instagram DM and Telegram beside WhatsApp",
      "Personal chats in WhatsApp Chat, with replies",
      "Google Sheets work management, with time and activity per person",
      "White labeling: your own name, colours, logo and icon"
    ],
    improvements: [
      "WhatsApp Chat works properly on a phone",
      "One rule everywhere for who sent a message; our own numbers are recognised"
    ],
    bugFixes: []
  },
  {
    version: "0.23.0",
    title: "Client Management",
    summary: "Your clients, subscriptions, invoices and payments in one place.",
    releaseDate: "2026-10-17",
    releaseType: "FEATURE",
    affectedModules: [
      "Clients",
      "Email",
      "WhatsApp Chat",
      "Users & Permissions"
    ],
    whatsNew: [
      "Client database with import, export and duplicate detection",
      "Subscriptions, numbered invoices, payments and receipts",
      "Email over your own mail server",
      "Link clients to WhatsApp chats and groups",
      "Project roles and project Leads, down to single pages",
      "Chat V2: delivery and read ticks, deleted messages, polls, locations, stickers, forwarding and pins"
    ],
    improvements: [
      "Real Support Overtime in the Team Report: time beyond each person's regular duty",
      "Live messages are no longer lost one at a time",
      "Every number's group list is re-read daily, so missing groups come back"
    ],
    bugFixes: []
  },
  {
    version: "0.24.0",
    title: "Team Report for personal chats, and a colleague's history",
    summary: "Add a colleague and their earlier work follows them.",
    releaseDate: "2026-10-20",
    releaseType: "FEATURE",
    affectedModules: [
      "Reports",
      "Team"
    ],
    whatsNew: [
      "Team Report covers groups, personal chats, or both",
      "Employee ranking, daily engagement and comparison with the previous period",
      "Customer-specific replies, from evidence only",
      "See what an identity change would do before saving it"
    ],
    improvements: [
      "Adding a colleague collects their earlier work",
      "Personal messages missed during a restart are recovered",
      "A full accuracy review of every team report"
    ],
    bugFixes: []
  },
  {
    version: "0.25.0",
    title: "Get Assist as a service",
    summary: "Customers, plans, billing and their own addresses.",
    releaseDate: "2026-10-24",
    releaseType: "MAJOR",
    affectedModules: [
      "Platform",
      "Clients",
      "WhatsApp Chat",
      "All Conversations"
    ],
    whatsNew: [
      "Platform control centre: customers, plans, subscriptions, payments and domains",
      "Each customer gets a complete, separate copy of the software",
      "Connect Messenger and Instagram with one click",
      "Send photos, videos, voice notes and documents from WhatsApp Chat",
      "Smart Bulk Import: any Excel or CSV, up to 5,000 clients, in the background"
    ],
    improvements: [
      "WhatsApp profile pictures and group descriptions, with no extra requests to WhatsApp"
    ],
    bugFixes: []
  },
  {
    version: "0.26.0",
    title: "Modules, Commerce, Website Chat and Social Studio",
    summary: "Build the software each business needs.",
    releaseDate: "2026-10-30",
    releaseType: "MAJOR",
    affectedModules: [
      "Module Builder",
      "Commerce",
      "Website Chat",
      "Social Studio",
      "Inbox"
    ],
    whatsNew: [
      "Module Builder and business types",
      "Products, stock, orders and a sales pipeline",
      "Couriers, WooCommerce, Shopify, a public API and webhooks",
      "Website live chat with a widget builder, files, business hours and a WordPress plugin",
      "Social Studio: plan, approve and publish to Facebook and Instagram, with AI drafts",
      "Inbox workspace: notes, priority, tags and AI Copilot"
    ],
    improvements: [
      "AI can answer from your catalogue and a customer's own order"
    ],
    bugFixes: []
  },
  {
    version: "0.27.0",
    title: "Clients V7 and My account",
    summary: "Invoices you can send, renewal offers and your own account page.",
    releaseDate: "2026-11-02",
    releaseType: "FEATURE",
    affectedModules: [
      "Clients",
      "Account",
      "Main Admin"
    ],
    whatsNew: [
      "Invoice and receipt documents",
      "Renewal offers and client message templates",
      "Bulk email with a second person's approval",
      "Client codes per project, with client lists you control",
      "My account: profile, photo, password, two-step sign-in and your devices"
    ],
    improvements: [
      "Money is stored exactly, never rounded"
    ],
    bugFixes: []
  },
  {
    version: "0.28.0",
    title: "Safer and easier to watch",
    summary: "Backups, monitoring and failed replies you can act on.",
    releaseDate: "2026-11-05",
    releaseType: "IMPROVEMENT",
    affectedModules: [
      "Messages",
      "Platform",
      "Security"
    ],
    whatsNew: [
      "Failed Replies: see what did not go out and retry safely",
      "A timeline of each message's journey",
      "Scheduled backups with restore checks and alerts",
      "Server, speed and database figures on Platform Monitoring"
    ],
    improvements: [
      "Logs never contain customer text or phone numbers",
      "Security headers and a sign-in limit per address"
    ],
    bugFixes: []
  },
  {
    version: "0.29.0",
    title: "Inbox V3 and Premium Tide Board",
    summary: "A complete inbox and a new look across the whole product.",
    releaseDate: "2026-11-06",
    releaseType: "FEATURE",
    affectedModules: [
      "Inbox",
      "AI",
      "Design"
    ],
    whatsNew: [
      "Open, pending, snoozed and resolved conversations",
      "Search the full message history",
      "Automatic conversation routing",
      "Satisfaction surveys after a resolved conversation",
      "Follow-ups for call-backs, visits and promises",
      "AI answers a verified customer's own account question in one-to-one chats"
    ],
    improvements: [
      "Premium Tide Board: one design for Main Admin and every project",
      "The inbox fills the window and opens WhatsApp in place"
    ],
    bugFixes: []
  },
  {
    version: "0.30.0",
    title: "Instant inbox, phone app and a dedicated Website Chat",
    summary: "New messages appear at once, on your phone too.",
    releaseDate: "2026-11-07",
    releaseType: "FEATURE",
    affectedModules: [
      "Inbox",
      "Phone app",
      "Website Chat",
      "Reports",
      "Settings"
    ],
    whatsNew: [
      "Inbox updates the moment a message arrives",
      "Install Get Assist on your phone, with notifications",
      "Website Chat module: live board, visitors, chat form, and install by copy and paste",
      "Invitations, routing by page or form answer, and a form for when your team is away"
    ],
    improvements: [
      "Filters, tables, reports, settings and sign-in screens all finished to one standard"
    ],
    bugFixes: []
  },
  {
    version: "0.31.0",
    title: "Faster everywhere, and customers first",
    summary: "Pages open without loading screens, and messages go before background jobs.",
    releaseDate: "2026-11-07",
    releaseType: "IMPROVEMENT",
    affectedModules: [
      "All modules",
      "WhatsApp Accounts & Groups"
    ],
    whatsNew: [],
    improvements: [
      "Clicking between pages no longer reloads the page or shows a loading screen",
      "Pages load as you rest the pointer on a link",
      "Overview and Team Performance open at once",
      "Slow jobs such as Groups Admin Maker wait while customer messages are being handled",
      "Group sync runs in the background while you keep working"
    ],
    bugFixes: []
  },
  {
    version: "0.32.0",
    title: "A team module that runs itself",
    summary: "Every member's work is credited automatically, however late they were added.",
    releaseDate: "2026-11-07",
    releaseType: "FEATURE",
    affectedModules: [
      "Team",
      "Reports"
    ],
    whatsNew: [
      "Team members are matched to their WhatsApp messages by themselves, and their past work appears in every report",
      "Say who answers from your number on their phone, and those replies count for them",
      "Set the week once: the roster fills itself two weeks ahead",
      "The week at a glance on the Roster",
      "Sync history for any one member"
    ],
    improvements: [
      "Team Members and Teams now live in the Team module",
      "The report's data line is calm and speaks up only when something needs you"
    ],
    bugFixes: []
  },
  {
    version: "0.33.0",
    title: "Every customer completely separate",
    summary: "Each customer has its own web address and its own logins.",
    releaseDate: "2026-11-07",
    releaseType: "SECURITY",
    affectedModules: [
      "Website Chat",
      "Users & Permissions",
      "Security",
      "Platform"
    ],
    whatsNew: [
      "Each customer can use the same usernames, such as admin, without affecting any other customer",
      "Choose how long passwords must be, from 6 to 128 characters: Main Admins for the company, project Leads for their project"
    ],
    improvements: [
      "Widget code, chat links, webhook addresses and integrations now use the customer's own web address"
    ],
    bugFixes: [
      "A customer no longer sees another customer's web address in its install code and links"
    ]
  },
  {
    version: "0.34.0",
    title: "Renewal reminders, faster reports and a roomier chat",
    summary: "See who to remind today, open reports at once and read more of each conversation.",
    releaseDate: "2026-11-07",
    releaseType: "FEATURE",
    affectedModules: ["Clients", "Reports", "WhatsApp Chat", "Team", "WhatsApp", "Security"],
    whatsNew: [
      "Renewals now lists who to remind today, worked out from each end date and the last contact, with one email for everybody that another person approves first",
      "Leave adds Annual, Sick and Casual in one press and shows who is away today",
      "A running group sync now shows in the job indicator on every page",
    ],
    improvements: [
      "Reports open at once and reuse recent figures, so moving between reports for the same period does not read every message again",
      "WhatsApp Chat keeps its search and filters in the list, so the open conversation uses the full height, and tablets show one pane at a time",
      "Today and Team Performance fit a phone, and the Activity Feed shows one clear message until counting is on",
    ],
    bugFixes: [
      "A project address, an employee number or a linked Google account at one customer no longer blocks or reveals anything to another",
      "Product knowledge from the software owner's repository is available only in the original installation",
    ],
  },
  {
    version: "0.35.0",
    title: "Support tickets",
    summary: "Turn any problem into a numbered ticket with an owner and a due time.",
    releaseDate: "2026-11-08",
    releaseType: "FEATURE",
    affectedModules: ["Tickets", "WhatsApp Chat", "All Conversations", "Clients", "Settings"],
    whatsNew: [
      "A Tickets page with Mine, Unassigned, All open, Waiting on customer, Overdue and Resolved lists",
      "Open a ticket from the Tickets tab beside any conversation, and drop its number into your reply",
      "Each ticket has a number, an owner, a priority, a due time, internal notes and a full history",
      "Choose how many hours each priority gets, and your categories, in Settings",
    ],
    improvements: [
      "While a ticket waits on the customer its clock stops, and the time waited is added back",
      "A client's profile lists their tickets",
    ],
    bugFixes: [],
  },
  {
    version: "0.36.0",
    title: "All projects in one inbox",
    summary: "See and answer every project's conversations from a single list.",
    releaseDate: "2026-11-08",
    releaseType: "FEATURE",
    affectedModules: ["All Conversations"],
    whatsNew: [
      "A new All tab in All Conversations lists every project's conversations together, each marked with its project",
      "An overview shows what is open and waiting in each project, and a press narrows the list to one",
      "Open and reply to any conversation without leaving the list, and act on conversations from several projects at once",
      "Anyone with access to more than one project gets the same view, limited to what they may already read",
    ],
    improvements: [],
    bugFixes: [],
  },
  {
    version: "0.37.0",
    title: "Contacts",
    summary: "One profile for every customer you meet in a chat, kept apart from Clients and Billing, with campaigns.",
    releaseDate: "2026-11-08",
    releaseType: "FEATURE",
    affectedModules: ["Contacts", "All Conversations", "WhatsApp Chat"],
    whatsNew: [
      "A new Contacts module with a profile for each person: names, numbers, emails, social accounts, location, notes and where they came from",
      "A Contact tab beside every chat: paste what a customer sent and it is saved to their profile",
      "The same number is never saved twice, and two records of one person can be merged",
      "Import from Excel or CSV, or copy your client list in without changing it",
      "Campaigns by email, or a ready list to work through on WhatsApp, Messenger, Instagram, Telegram, SMS and calls",
      "Optional: AI collects customers' details from their messages, and new personal chats become contacts by themselves",
    ],
    improvements: [],
    bugFixes: [],
  },
  {
    version: "0.38.0",
    title: "Menu bots and automation templates",
    summary: "A numbered menu customers answer by typing a number, and ready-made replies to start from.",
    releaseDate: "2026-11-08",
    releaseType: "FEATURE",
    affectedModules: ["Menu Bots", "Automation Rules"],
    whatsNew: [
      "Menu Bots: customers type a number to get answers, go back, or reach a person, on WhatsApp, Messenger, Instagram, Telegram and website chat",
      "Build a menu on one screen and try it right there before switching it on",
      "Ready-made menus in English and Bangla for customer support, online shops and internet providers",
      "Ready-made automatic replies under Automation Rules → Templates, added as drafts for you to finish",
      "The menu stops when a person replies, and stays quiet after handing a customer to your team",
    ],
    improvements: [],
    bugFixes: [],
  },
  {
    version: "0.39.0",
    title: "Public sign-up",
    summary: "A pricing page and a sign-up form, with every new business approved by a person.",
    releaseDate: "2026-11-09",
    releaseType: "FEATURE",
    affectedModules: ["Platform"],
    whatsNew: [
      "A public pricing page that shows the plans you choose, at the prices you set",
      "A sign-up form with email confirmation and protection against fake requests",
      "A Sign-ups page on the platform: one press sets up the workspace, plan and owner invitation",
    ],
    improvements: [],
    bugFixes: [],
  },
  {
    version: "0.40.0",
    title: "Payment links",
    summary: "Ask for payment inside a chat, paid into your own SSLCOMMERZ or bKash account.",
    releaseDate: "2026-11-09",
    releaseType: "FEATURE",
    affectedModules: ["Payment Links", "All Conversations", "WhatsApp Chat"],
    whatsNew: [
      "A Payment tab beside every chat: make a link and drop it in your reply",
      "Customers pay by card, bKash, Nagad or bank on a simple page",
      "A paid link settles the invoice and records the receipt by itself",
      "Anything unusual, like a different amount or paying twice, is flagged for you to check",
    ],
    improvements: [],
    bugFixes: [],
  },
  {
    version: "0.41.0",
    title: "WhatsApp (Official API)",
    summary: "Connect a number through Meta's official WhatsApp API and answer it in All Conversations.",
    releaseDate: "2026-11-09",
    releaseType: "FEATURE",
    affectedModules: ["All Conversations", "Messaging Channels"],
    whatsNew: [
      "Connect a number from your own Meta account, beside your QR-linked numbers",
      "Its customers appear in All Conversations, with AI, routing and contacts working as on other channels",
      "Send an approved template to reach someone after the 24-hour window",
    ],
    improvements: [],
    bugFixes: ["The Send in their chat button in a contact campaign now works on Messenger, Instagram and Telegram"],
  },
  {
    version: "0.42.0",
    title: "A simpler Main Admin",
    summary: "A welcome guide for new customers, easier project creation, and one-click access for employees.",
    releaseDate: "2026-11-11",
    releaseType: "IMPROVEMENT",
    affectedModules: ["Main Admin"],
    whatsNew: [
      "A welcome screen that walks a new customer through setup, step by step",
      "Create a project by picking your business type from cards, and see what it will include",
      "Each project page has three tabs: Overview, Team & Access and Settings",
      "Give an employee a login in one click, with a generated password",
      "An archived project can be restored",
      "Organization guides you in order: departments, job titles, then employees, with common ones to add in one press",
      "Add a department or job title right from the employee form with + New",
      "Every page shows the next step until it is done",
    ],
    improvements: [],
    bugFixes: [],
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
