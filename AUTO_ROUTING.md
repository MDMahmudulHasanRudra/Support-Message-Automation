# Automatic conversation routing

Feature `AUTO_ROUTING`, **off by default** and in no plan. It needs `UNIFIED_INBOX_V3`, and it does nothing until its own
settings are switched on under Settings → Automatic routing.

Status: built and tested on an isolated database only. Not deployed, and not tried with real agents or a real roster.

## What it does

A customer's new message gives an OPEN, unassigned conversation to one person from a chosen pool:

- **Method:** round robin, or least busy (fewest OPEN + PENDING conversations; ties take turns).
- **Pool:** chosen Teams (who is in them at that moment) and chosen logins.
- **Limit:** the most open conversations per person (default 15).
- **Optional:** only people on duty now, and only people seen in the dashboard recently.

It runs in three places, through one function (`routeConversation`, packages/db):

- the message hooks (channel inbound and WhatsApp `persistIncomingMessage`);
- a 60 s sweep (`auto-routing` loop) for anything still unassigned, for example when nobody was eligible earlier;
- "Distribute evenly" in the All Conversations bulk bar, with the person who pressed it as the actor.

Settings → Automatic routing also shows, read-only, who could take a conversation now and why the others could not.

## Rules worth not undoing

- **Never replaces an assignee.** A person always wins. The transaction re-reads the conversation and then updates it
  conditionally on "still unassigned".
- **The project lock is required, and it is measured.** `pg_advisory_xact_lock` covers the read of the pointer, the open counts,
  the pick, the write and the event. Without it, two callers pick the same next person and capacity is overrun. The worker
  test fails when the lock is removed. It is held in Postgres because worker processes and the web share no memory.
- **Nobody eligible means unassigned.** Routing never falls back to someone who failed a check. The reason is recorded on the
  settings row as counts, never as names.
- **One permission resolver.** `loadRoutingPool` uses `resolveRoleKeys`, `levelAllows` and the page selection, as
  `server/permissions.ts` does. A person needs the reply key of that kind of conversation.
- **Leave always excludes a linked team member.** The roster applies only with "only on duty" on. It reads the plan (roster,
  approved leave, a manager's absence), not attendance: silence is not absence, and someone must be able to get the first
  conversation of the day.
- **Groups are off unless switched on separately.** A group with an owner (`assignedTeamMemberId`, on any of our numbers' copies)
  is never routed. A group two of our numbers are in is one conversation: once one copy has a person, the other is not routed.
- **`enabledAt` stops a backlog being handed out.** The sweep looks back 24 hours and never before routing was switched on.
  Saving again does not move that date.
- **Held projects are skipped** (SUSPENDED, ARCHIVED, billing hold).
- **An assignment is an ordinary `ASSIGNEE` event** with `{ reason: "AUTO_ROUTING", method, via }` in its context, in the same
  transaction. The event-kind CHECK does not change. The conversation's history shows it as "Automatic routing" with an Auto label.
- **A state row is created only when someone is assigned.** This widens the Inbox V3 rule that a WhatsApp state row exists only
  when a person acts: routing acts for a person. A chat routing leaves alone still has no row.
- **Manual reassignment works as before.**

## Not built

- Telling the assignee. An assignment appears in their inbox, and push notifications are a separate planned item.
- Rebalancing when someone goes off duty. Routing assigns once and never moves a conversation.

"Seen recently" reads the session's last use, which the dashboard refreshes at most every five minutes, so the shortest window
allowed is ten minutes.
