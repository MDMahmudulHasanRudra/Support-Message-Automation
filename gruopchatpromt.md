
# Implementation Prompt — WhatsApp Group Chat Module

## Objective

Build a new **WhatsApp Group Chat** module inside the existing application.

The purpose of this module is to provide a **WhatsApp Web–like group conversation interface** where an authenticated App User can:

* See all available WhatsApp groups in a left sidebar.
* Search/filter groups.
* Select a group.
* View the group's existing messages.
* See incoming messages in near real-time.
* Send messages to the selected WhatsApp group.
* See unread counts / latest message information.
* Continue using all existing automation, AI, learning, broadcast, monitoring, and support functionality exactly as before.

### Very important

This is an **additional UI/module**.

Do **NOT** replace, rewrite, duplicate, or destabilize:

* Existing WhatsApp connection
* Existing WhatsApp worker
* Existing inbound message pipeline
* Existing outbound queue
* Existing message persistence
* Automation Rules
* AI Fallback
* Conversation Learning
* Priority Support
* Group Message Sender / Broadcast
* Team Members
* Existing WhatsApp Groups management
* Existing App User authentication/session system
* Existing Permission Module system

The new module must reuse the existing architecture wherever possible.

---

# 1. First: Mandatory Architecture Audit

Before writing code, inspect the repository thoroughly.

Find and understand:

### WhatsApp connection

* WhatsApp account/session implementation
* Worker
* OpenWA/WhatsApp Web integration
* WhatsApp connection status
* Account selection logic
* Group synchronization

### Existing message pipeline

Find the complete path:

```text
WhatsApp incoming message
        ↓
Worker
        ↓
Message persistence
        ↓
Existing processing pipeline
        ↓
Database
        ↓
UI
```

Also find:

```text
UI send message
        ↓
Existing outbound queue
        ↓
Worker
        ↓
WhatsApp
```

Do NOT create another outbound messaging mechanism if one already exists.

### Existing database models

Inspect:

* WhatsAppAccount
* WhatsAppGroup
* Message
* OutboundMessage
* Group membership/message relations
* Any existing unread/read/message-status structures

Determine exactly how messages are currently stored.

### Existing UI

Inspect:

* Dashboard layout
* Sidebar
* existing WhatsApp pages
* existing message pages
* reusable Card/Badge/Button/Input/ScrollArea components
* existing loading/error/empty states

### Existing authentication

Use the application's current:

```ts
requireSession()
```

and existing permission infrastructure.

Do not introduce another authentication mechanism.

### Existing permissions

The previous App User/Permission Module implementation should be reused.

Add only the permissions necessary for this module:

```text
whatsapp_group_chat.view
whatsapp_group_chat.send
```

If the canonical permission catalogue already exists, extend it rather than creating a second permission system.

---

# 2. Architecture Principle

The module must use this architecture:

```text
                 EXISTING WHATSAPP SYSTEM
                         │
             ┌───────────┴───────────┐
             │                       │
        Incoming                  Outgoing
             │                       │
             ▼                       ▼
        WhatsApp Worker        Existing Outbound Queue
             │                       │
             ▼                       ▼
       Existing Message DB       WhatsApp Worker
             │                       │
             └───────────┬───────────┘
                         │
                         ▼
               NEW GROUP CHAT UI
                         │
              ┌──────────┴──────────┐
              │                     │
         Group Sidebar         Chat Window
```

The new UI is only another consumer of the existing messaging infrastructure.

---

# 3. New Sidebar Navigation

Add a new navigation item:

```text
WhatsApp Group Chat
```

Place it logically near the existing WhatsApp-related modules.

Use the existing Sidebar/navigation component.

Do not create a separate layout.

Route suggestion:

```text
/(dashboard)/whatsapp-group-chat
```

or follow the repository's existing route naming convention if another structure is more appropriate.

---

# 4. Main UI

The main page should behave similarly to WhatsApp Web.

Desktop layout:

```text
┌──────────────────────┬───────────────────────────────────────────┐
│ WhatsApp Groups      │ Technical Support                         │
│                      │ 👥 42 members                             │
│ 🔍 Search groups     │───────────────────────────────────────────│
│                      │                                           │
│ 🟢 Customer Support  │ Customer: Internet not working            │
│    Last message...   │ 10:41 AM                                  │
│    3                 │                                           │
│                      │              Support: Please send         │
│ 🟢 Technical Support │              router screenshot            │
│    Checking now...   │              10:42 AM                      │
│                      │                                           │
│ 🟢 Billing           │ Customer: Sending now...                   │
│    Payment issue...  │ 10:43 AM                                  │
│                      │                                           │
│ 🟢 Network Issues    │───────────────────────────────────────────│
│    Yesterday         │ Type a message...                 [Send]  │
└──────────────────────┴───────────────────────────────────────────┘
```

---

# 5. Left Group Sidebar

Display existing WhatsApp groups.

Each group item should contain:

* Group name
* Group avatar/initial if available
* Latest message preview
* Latest message timestamp
* Unread count
* Selected state

Example:

```text
Customer Support
Internet not working...
10:42 AM
3
```

### Search

Add:

```text
Search groups...
```

Search should operate against existing group data.

Do not load every historical message just to perform group search.

---

# 6. Group Selection

When the user clicks a group:

```text
selectedGroupId
```

must identify the currently opened group.

The URL should ideally preserve the selected group, for example:

```text
/whatsapp-group-chat?group=<groupId>
```

This makes the page refreshable/shareable and avoids losing the selected conversation after a refresh.

Validate that the group exists and is accessible before loading its messages.

---

# 7. Chat Header

When a group is selected, show:

* Group name
* Group avatar
* Member count if available
* WhatsApp connection/account status
* Optional group information button

Example:

```text
Technical Support
42 members
● Connected
```

If the WhatsApp account is disconnected:

```text
Technical Support

WhatsApp connection unavailable
```

Do not allow sending while the connection is unavailable.

---

# 8. Message History

Load messages from the existing `Message` table/model.

Do NOT create another chat-message table unless the existing schema genuinely cannot support this feature.

Display:

* Sender name/phone
* Message text
* Timestamp
* Incoming/outgoing distinction
* Team-member distinction if already available
* Message status if available
* Media placeholder if the current system supports media

Example:

```text
Rudra
Internet is not working

10:41 AM
```

For outgoing:

```text
Support
Please restart the router.

10:42 AM   ✓
```

Use the existing message metadata rather than inventing new fields.

---

# 9. Message Pagination

Do NOT load the entire conversation at once.

Implement cursor-based or equivalent pagination using the existing Prisma/message-query conventions.

Initial load should fetch a reasonable number of recent messages, for example:

```text
50–100 messages
```

depending on the existing architecture.

Support loading older messages when the user scrolls upward.

Avoid an unbounded query.

---

# 10. Auto Scroll

When opening a conversation:

```text
scroll → latest message
```

When a new message arrives:

* If the user is already near the bottom → automatically scroll.
* If the user has scrolled upward → do NOT force-scroll.
* Show something like:

```text
↓ 3 new messages
```

Clicking it should return to the latest messages.

This is important for a real chat experience.

---

# 11. Sending Messages

If the user has:

```text
whatsapp_group_chat.send
```

permission:

show:

```text
Type a message...
                         [Send]
```

Sending must go through the application's **existing outbound messaging/queue architecture**.

Do NOT directly call WhatsApp from the web page.

Correct:

```text
Browser
   ↓
Server Action/API
   ↓
Existing OutboundMessage
   ↓
Existing Queue
   ↓
Worker
   ↓
WhatsApp
```

Do not bypass:

* outbound queue
* existing retry logic
* existing account/session handling
* existing logging
* existing rate/safety controls

---

# 12. Message Send Validation

Before creating an outbound message:

Validate:

* authenticated session
* `whatsapp_group_chat.send` permission
* target group exists
* target group is active/valid
* WhatsApp account exists
* WhatsApp connection is available where the existing architecture supports such a check
* message is not empty
* message length is within the existing WhatsApp/application limits

Trim whitespace.

Reject:

```text
""
"   "
```

Do not trust client-side validation.

Server-side validation is mandatory.

---

# 13. Prevent Duplicate Sends

The send operation should be idempotent where the existing outbound architecture supports an idempotency key.

Do not accidentally create duplicate outbound messages if the user:

* double-clicks Send
* presses Enter twice
* experiences a network retry

Reuse the existing duplicate/idempotency mechanism if one exists.

Do not invent a second competing mechanism without first checking the existing queue.

---

# 14. Enter Key Behavior

Implement:

```text
Enter → Send
Shift + Enter → New line
```

unless the existing application design has another established convention.

Disable Send while the message is being submitted.

After successful queueing:

* clear the input
* keep the user in the current group
* optimistically update the UI only if the existing architecture supports this safely

Do not fabricate a successful WhatsApp delivery status.

Important distinction:

```text
Queued
Sent
Delivered
Failed
```

Only display statuses that the backend actually knows.

---

# 15. Real-Time / Near Real-Time Updates

First inspect whether the application already has:

* WebSocket
* SSE
* polling
* worker events
* Redis pub/sub
* realtime subscriptions

### If an existing realtime mechanism exists

Reuse it.

### If no realtime mechanism exists

Do NOT introduce a huge new infrastructure just for this module.

Use a lightweight polling strategy initially, for example:

```text
every 2–5 seconds
```

but make the interval configurable in code and avoid aggressive polling.

Only request messages newer than the latest known message.

Example:

```text
GET messages where createdAt > lastMessageTimestamp
```

or preferably by message ID/cursor if the existing schema supports it.

---

# 16. Unread Count

Implement unread behavior using the existing database architecture if possible.

Do NOT mark a message as read globally just because one App User viewed it.

This is critical.

Unread state is **per App User**, not global.

If the existing database does not have a per-user read state, introduce a minimal model such as:

```prisma
model WhatsAppGroupChatReadState {
  id              String   @id @default(cuid())
  userId          String
  groupId         String
  lastReadMessageId String?
  lastReadAt      DateTime?

  @@unique([userId, groupId])
}
```

Only introduce this if required after auditing the existing schema.

When the user opens a group:

```text
lastReadMessageId = latest visible message
```

Then calculate unread messages after that point.

Do not add a separate unread counter table unless necessary.

---

# 17. Multiple WhatsApp Accounts

The existing system supports or may support multiple WhatsApp accounts.

Audit this carefully.

Do NOT assume:

```text
one global WhatsApp account
```

If a group belongs to a specific WhatsApp account, the chat UI must preserve that relationship.

Example:

```text
WhatsApp Account A
 ├── Group 1
 ├── Group 2

WhatsApp Account B
 ├── Group 3
 ├── Group 4
```

Messages must always be sent through the correct account.

Never allow:

```text
Group A → accidentally sent through Account B
```

---

# 18. App User Permission Integration

Add:

```text
whatsapp_group_chat.view
whatsapp_group_chat.send
```

to the canonical permission catalogue.

Permission behavior:

### No `view`

User cannot access the module.

Direct URL access must also be denied.

Do not rely only on hiding the Sidebar item.

### Has `view`, no `send`

User can:

* see groups
* read messages
* search
* view history

but cannot:

* send messages

The composer should either be hidden or disabled with a clear message.

### Has both

Full chat functionality.

---

# 19. Existing Automation Must Continue Working

This module must NOT disable or bypass existing automation.

For example, if a customer sends:

```text
Internet not working
```

and an existing Automation Rule responds automatically, the new Group Chat should simply display that message when it appears.

Likewise:

```text
AI Fallback
Conversation Learning
Priority Support
```

must continue operating normally.

A message manually sent through the new UI should also flow through the existing outbound architecture.

Do not create a second "manual message" pipeline.

---

# 20. Security

Follow the newly implemented App User/session system.

Every page/server action must:

```ts
const session = await requireSession();
await requirePermission(session, "whatsapp_group_chat.view");
```

For sending:

```ts
const session = await requireSession();
await requirePermission(session, "whatsapp_group_chat.send");
```

Never trust:

```text
userId
groupId
permission
```

from the browser.

The server must derive the authenticated user from the session.

Never expose:

* WhatsApp credentials
* session secrets
* API keys
* worker credentials
* internal queue credentials

to the browser.

---

# 21. Authorization Must Be Server-Side

This is mandatory.

This must fail:

```text
User without permission
→ manually opens /whatsapp-group-chat
→ API call
→ receives messages
```

Server must reject it.

Likewise:

```text
User without send permission
→ manually calls send-message endpoint
→ message gets queued
```

must be rejected.

UI hiding is not security.

---

# 22. Audit Logging

Use the application's existing:

```ts
logSystemEvent()
```

mechanism.

Log important actions such as:

```text
WHATSAPP_GROUP_CHAT_MESSAGE_QUEUED
WHATSAPP_GROUP_CHAT_SEND_FAILED
WHATSAPP_GROUP_CHAT_ACCESS_DENIED
```

Do not log message contents unnecessarily.

Never log:

* session secrets
* API keys
* WhatsApp authentication credentials

For audit metadata prefer:

```json
{
  "userId": "...",
  "groupId": "...",
  "messageId": "...",
  "outboundMessageId": "..."
}
```

rather than full message content.

---

# 23. UI/UX Requirements

Use the existing application design system.

Do NOT make the page look like a completely separate application.

Use existing:

* Button
* Input
* Badge
* Card
* Avatar
* Dialog
* ScrollArea
* Dropdown
* Tooltip
* Skeleton
* Empty state

where available.

Responsive behavior:

### Desktop

Two-column layout:

```text
Groups | Chat
```

### Tablet/mobile

Use a WhatsApp-like navigation:

```text
Groups screen
      ↓
Selected group
      ↓
Chat screen
```

A back button should return to the group list.

---

# 24. Loading States

Do not show blank screens.

Implement:

```text
Loading groups...
Loading messages...
Sending...
```

Use existing Skeleton/loading components.

---

# 25. Empty States

No groups:

```text
No WhatsApp groups available.

Connect/sync a WhatsApp account to see your groups.
```

No messages:

```text
No messages yet.

Start the conversation.
```

No search results:

```text
No groups found.
```

---

# 26. Error Handling

Examples:

```text
WhatsApp connection unavailable
Unable to load messages
Unable to send message
Group no longer exists
You don't have permission to send messages
```

Never expose raw Prisma errors or internal stack traces to the user.

Log unexpected server errors using the existing logging mechanism.

---

# 27. Do Not Overbuild

This first version should focus on:

### MUST HAVE

* WhatsApp Group Chat navigation
* group list
* group search
* group selection
* message history
* message pagination
* send text message
* unread count/read state
* near-real-time incoming message updates
* permissions
* session security
* correct WhatsApp account routing
* existing outbound queue reuse

### NOT REQUIRED NOW

Do not add unless the existing architecture already supports them naturally:

* voice calls
* video calls
* stickers
* reactions
* typing indicators
* message editing
* message deletion
* WhatsApp status
* contact management
* end-to-end encryption implementation
* media upload infrastructure
* new WhatsApp connection system

These can be future phases.

---

# 28. Database Changes

Before adding any migration, prove that the existing schema cannot support the feature.

Prefer reusing:

```text
WhatsAppGroup
Message
OutboundMessage
WhatsAppAccount
User
```

Only add schema when genuinely required.

Potentially required:

```text
WhatsAppGroupChatReadState
```

for per-user unread/read state.

If added:

* use proper foreign keys
* unique constraint on `(userId, groupId)`
* indexes for lookup
* appropriate `onDelete`
* migration only against isolated test DB

Do NOT modify unrelated models.

---

# 29. API / Server Action Design

Follow the repository's existing conventions.

Potential operations:

```text
getChatGroups()
getGroupMessages(groupId, cursor)
getNewGroupMessages(groupId, afterMessageId)
sendGroupMessage(groupId, body)
markGroupAsRead(groupId, messageId)
```

These names are suggestions only.

Reuse existing server action/API conventions after auditing the repository.

Do not create unnecessary REST endpoints if Server Actions are the established architecture.

---

# 30. Testing

Add tests where the existing infrastructure allows it.

At minimum verify:

### Authorization

* user with `view` can access
* user without `view` cannot access
* user with `view` but without `send` cannot send
* user with both can send

### Message loading

* correct group messages returned
* messages from another group never appear
* pagination works
* latest messages load correctly

### Sending

* valid message queues correctly
* blank message rejected
* invalid group rejected
* wrong WhatsApp account cannot be selected accidentally
* duplicate submission does not create duplicate outbound jobs where existing idempotency supports it

### Read state

* read state is per user
* reading one group does not mark another group read
* one user's read state does not modify another user's unread count

### Existing functionality

Run the existing worker test suite and existing application checks.

Do not modify existing automation-engine tests just to make the new feature pass.

---

# 31. Manual Verification

After implementation, run the application locally.

Verify using two App User sessions, preferably:

```text
Browser A
Browser B / Incognito
```

Test:

### User A

* login
* open WhatsApp Group Chat
* see groups
* open group
* read messages
* send message

### User B

* open same group
* receive User A's message
* unread count updates
* open group
* unread state clears

### Permission

Create:

```text
Read Only User
```

Verify:

```text
Can view chat: YES
Can send: NO
```

Create/assign a user with:

```text
whatsapp_group_chat.send
```

Verify:

```text
Can view: YES
Can send: YES
```

### Existing automation

Send a customer message that triggers an existing automation rule.

Verify:

```text
Automation still executes normally.
```

Verify the new UI displays the resulting messages.

---

# 32. Critical Regression Checks

Before declaring completion:

Confirm:

* Existing WhatsApp worker still starts.
* Existing WhatsApp connection still works.
* Existing group synchronization still works.
* Existing inbound pipeline still works.
* Existing outbound queue still works.
* Automation Rules still work.
* AI fallback still works.
* Conversation Learning still works.
* Priority Support still works.
* Group Broadcast still works.
* App User authentication still works.
* Permission Modules still work.
* Existing pages compile.
* No existing functionality was replaced.

---

# 33. Verification Commands

Use the repository's actual commands after auditing them.

At minimum:

```bash
pnpm typecheck
pnpm build
```

Run the relevant isolated database tests.

If a migration is required:

```text
postgres-test only
```

Never apply a new migration to the live/shared production database without explicit approval.

Run:

```bash
git status
git diff --stat
```

and inspect the final diff.

---

# 34. Final Report

At completion provide a structured report containing:

### 1. Architecture audit

What existing WhatsApp/message infrastructure was reused.

### 2. Features implemented

Complete list.

### 3. Files changed

Modified + newly created files.

### 4. Database changes

Exact migration/model changes, or:

```text
No migration required.
```

### 5. Message flow

Show:

```text
Incoming:
WhatsApp → Worker → Message DB → Group Chat UI

Outgoing:
Group Chat UI → Server Action → Outbound Queue → Worker → WhatsApp
```

### 6. Permission model

Explain:

```text
whatsapp_group_chat.view
whatsapp_group_chat.send
```

### 7. Security

Explain server-side authorization, session validation, credential protection, etc.

### 8. Tests

Exact results.

### 9. Typecheck/build

Exact results.

### 10. Manual verification

Clearly separate:

```text
Automated verification
Manual verification
```

Do not claim browser verification unless it was actually performed.

### 11. Known limitations

List honestly.

### 12. Commit

Do **not** create a commit unless explicitly instructed.

---

# Most Important Constraints

1. **Do not rewrite the existing WhatsApp engine.**
2. **Do not create a second WhatsApp connection.**
3. **Do not create a second outbound messaging system.**
4. **Reuse the existing Message and OutboundMessage architecture.**
5. **Do not break existing automation.**
6. **Do not expose WhatsApp credentials to the browser.**
7. **Permission checks must happen server-side.**
8. **Do not trust client-provided user identity.**
9. **Do not add unnecessary database tables.**
10. **Do not change unrelated modules.**
11. **Do not deploy migrations to production.**
12. **Do not fabricate message delivery/read status that the backend does not actually know.**
13. **Do not claim tests or browser verification that were not actually performed.**
14. **Before coding, audit the existing implementation and adapt this plan to the repository's actual architecture.**
15. **The final goal is a WhatsApp Web–style group chat experience inside the existing application, while all existing functionality remains untouched.**

### Definition of Done

The feature is considered complete only when an App User can open:

**WhatsApp Group Chat → select a WhatsApp group → see its existing conversation → receive new messages → send a text message through the existing outbound queue → see the result in the conversation**, while authentication, permissions, existing WhatsApp automation, worker processing, and all existing modules continue working normally.
