# Support tickets

Feature `TICKETS`, **on by default**, because it sends nothing and changes nothing about how a conversation behaves. Switch it
off per project in the Module Builder. Pages: `/tickets`, `/tickets/<id>`, `/settings/tickets`, a Tickets tab beside every
conversation, and a Tickets card on the client profile.

## Why a new record

`SupportAssignment` and `SupportEscalationCase` each follow one customer wait and close when it is answered. A ticket is a
problem being worked on: it can outlast many waits, and one conversation can hold several. So it is its own record that
**links to** a conversation and a client. The conversation's own assignee and status are untouched by a ticket.

## What it does

- A number per project (`T-0012`), subject, details, status, priority, category, a person and/or Team, a due time.
- Lists: Mine, Unassigned, All open, Waiting on customer, Overdue, Resolved, with search by number or subject.
- Opened from the Tickets page, a conversation's side panel (linked to it, and to its client when the conversation has one), or a client.
- Internal notes and a full history on each ticket.

## Rules worth not undoing

- **It never sends anything to a customer.** "Put the number in my reply" only fills the reply box; sending stays the person's own press.
- **Permissions, no key of its own**, as follow-ups: reading needs `messages.view`; changing one needs the reply key of its conversation
  (`messages.reply` / `conversations.reply`), or either when it has none.
- **Every change is a conditional update with its `TicketEvent` in the same transaction.** A status move is conditional on the status read;
  an edit on the row's `updatedAt`. Two people at once give one change and one history line, and the other is told.
- **The history is append-only** (trigger). Event values are the words at that moment, so a renamed person or Team never rewrites it.
- **Links are checked in code and at the database** (`<Child>_<column>_same_project` triggers).
- **The number and the ticket are one transaction**, from an atomic counter on `TicketSettings`. Never derived from a count.
- **Waiting on the customer stops the clock:** the time waited is added to the due time when work resumes, and such a ticket is never overdue.
  Reopening starts a new target. A new priority brings its target with it, unless the ticket is paused or a due time is set in the same edit.
- **A ticket outlives what it points at.** Removing an account, conversation or client clears the link and keeps the ticket.

## Not built

Business hours and holidays (targets count around the clock), a separate first-response target, telling the assignee by message or push,
bulk actions, reports, and customer-facing ticket status.
