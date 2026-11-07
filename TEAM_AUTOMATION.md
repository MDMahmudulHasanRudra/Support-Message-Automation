# Team automation

The team module sets itself up as far as it can. Everything is on by default, with a switch on Team Members and on the Roster.

## Past work is never lost

Reports decide who sent a message when they are read, so a member added today has their earlier work at once, as long as their identifier matches.

WhatsApp mostly shows people in groups by a private ID (a LID), not their number, so a member typed in by phone number matched nothing. `matchTeamMembersToWhatsApp` (packages/db) connects them, strongest evidence first:

1. **WhatsApp paired them** (`AUTO_PHONE`). `WhatsAppIdentityEvidence` holds LID and phone pairs read from a message's own sender details and from WhatsApp Web's local contact list and group members (`readContactIdentities`). Nothing is asked of WhatsApp's servers. Not yet confirmed which WhatsApp Web versions carry these fields; a field that is absent finds nothing.
2. **Their name** (`AUTO_NAME`). The WhatsApp name equals exactly one active member's, exactly one sender has it, they write in at least 3 groups in 120 days, and the sender has never sent as one of our numbers.

Anything weaker stays a suggestion on the Identity check. A match is written to `whatsappId`, logged in System Logs, and queues an `IdentityReattribution`. **Undo** clears it and sets `autoLinkOff`, as does a person clearing the ID on the edit form. A wrong match matters: the pipeline treats that sender as staff and does not auto-reply to them, which is why the name rule is strict.

Runs every 10 minutes in the worker (`teamManagement/teamAutomation.ts`, a slow job that stands back for customer messages), and on **Match now**. **Sync history** on a member queues their re-attribution by hand.

## Replies from our own number's phone

Someone answering from the business number on their own phone produces an OUTGOING message under the number itself: nothing in it says who typed it. `WhatsAppNumberOperator` is the admin saying who uses the number. `pickNumberOperator` is the one rule:

- One person on the number at that moment gets the reply.
- Several are told apart by who was on duty then.
- Otherwise nobody is credited, and it counts as the business number as before.

Never the AI, a rule, a broadcast or a dashboard reply, which each echo an `OutboundMessage`. Periods are history: a number's first operators start "since before this was recorded", so earlier replies count; somebody joining later counts from that day; somebody leaving keeps what they did. With no operators the classifier is unchanged. Duty History follows the same rule by day (`numbersOperatedBy`).

## Roster

`fillRosterFromPattern` writes today and the next 14 days from `WeeklyScheduleEntry`, hourly in the worker and straight after a pattern changes. It only fills blanks, so a manager's change and leave always stand. A pattern change rewrites future rows still marked `WEEKLY_SCHEDULE`. **Set the week** on the Roster applies one shift and weekly days off to many people at once.

## Data health

`verifiedFrom` defaults to the day pause recording began (7 Oct 2026); an admin's date still wins. The strip is one quiet line, and a box only when a number is not collecting right now. No figure changed.

## Release notes

`prisma/seedReleaseNotes.ts` runs after migrations on every deploy. It is add-only by version.
