# Follow-ups

Feature `FOLLOW_UPS`, **off by default** and in no plan. An internal to-do list for call-backs, technician visits and promised
replies, at `/follow-ups` under Support. It also appears as a section in the conversation side panel (WhatsApp Chat and All
Conversations) and on the client profile.

Status: built and tested on an isolated database only. Not deployed.

## What it does

- A follow-up has a title, a note, a due time, a priority, a person and/or Team, and optionally a conversation and/or a client.
- Tabs: Mine, Team, Overdue, Due today, Upcoming, Done, Discarded, filtered by assignee, Team and priority.
- The top bar shows my overdue + due-today count. It polls once a minute while the tab is visible and shows nothing at zero.
- "Mine" is what is assigned to me, what is assigned to one of my Teams with no person yet, and what I wrote for myself with no owner.

## Rules worth not undoing

- **It never sends anything to a customer.** Reminders are in-app only. There is no Notification Center event: nothing here raises
  a message, so there is nothing to mute or route.
- **Permissions, no key of its own.** Reading needs `messages.view`. Changing one needs the reply key of the conversation it is
  about (`messages.reply` for WhatsApp, `conversations.reply` for a channel), or either when it is about no conversation. Each key
  keeps its own module's feature check.
- **Links are checked, in code and at the database.** A conversation, client, person or Team must be this project's, and
  `<Child>_<column>_same_project` triggers back that up. Linking a client also needs `clients.view` and Client Management on.
- **Every change is a conditional update on the state it read, with its `FollowUpEvent` in the same transaction.** A double click,
  or two people at once, give one change and one event; the other person is told it changed.
- **The history is append-only** (trigger). Deletion stays possible, because a removed customer's data is emptied table by table.
- **Buckets use Dhaka days through plain instants** (`followUpBucketRange`, `getDhakaDayRange`), with no SQL day arithmetic. A 10:00
  call-back is overdue at 15:00 the same day.
- **The badge reader refuses as zero**, never a redirect, because it is polled from every page.
- **`datetime-local` values are read as Dhaka wall clock.** The browser sends no zone, and the team works in Dhaka.

## Not built

Notifying the assignee by message or push, and repeating follow-ups. Push notifications are a separate planned item.
