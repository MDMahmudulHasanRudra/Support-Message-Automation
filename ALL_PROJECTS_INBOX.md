# All projects inbox

`/conversations/all-projects`, under the Inbox module. In the Main Admin Workspace it is the **All** tab beside the project tabs; for
anybody else with more than one project it is the **All projects** switch at the top of All Conversations.

## What it does

- One list of every conversation the person can read, newest first, each row marked with its project.
- An overview before a conversation is opened: open, waiting, unread and assigned to you, in total and per project.
- Project chips narrow the list; channel, view, search and filters work across every project.
- A conversation opens beside the list and is answered from there. Bulk actions work across projects.

## Rules worth not undoing

- **It adds no authority.** For each project the viewer may enter, `universalInboxProjects` runs the ordinary `checkPermission("messages.view", …)`
  inside that project (role, access level, project-role pages, the module being on), and `loadUniversalInbox` calls the ordinary `loadInbox` there.
- **A row opens under its own project's address.** The conversation page, its Server Actions and every reply run in that project, with its checks.
- **The projects come from the session**, in every action and in the live connection, never from the request.
- **One project failing does not empty the list.** It is named and comes back on the next refresh.
- **Bounded.** At most 3 projects are read at once, each person's reading is reused for 2 seconds, and the merged list is cut at 600 rows.

## Not offered here

Saved views and mentions (each belongs to one project), assigning across several projects at once (a person and a Team belong to one project; choose one
project and they appear), and message-text "more matches" paging.
