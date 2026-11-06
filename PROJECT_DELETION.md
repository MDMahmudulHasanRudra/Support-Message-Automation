# Deleting a project permanently (Main Admin portal)

Main Admin → Projects → a project → **Delete this project** (2 Nov 2026). The section appears only
for an ARCHIVED project and only to someone with `projects.manage`.

## Who and how

`deleteProject` (`apps/web/src/server/actions/projects.ts`) needs:

- `projects.manage`, and a project in the person's own customer (looked up through the
  customer-scoped client, so another customer's project "no longer exists");
- the project's exact name, typed;
- the person's own password. A wrong one counts toward the login lockout, as on My account.

A support session is refused: erasing a customer's workspace is the customer's own decision.

## The rules

- **Archive first.** Archiving is the existing, separately confirmed step: the worker releases the
  WhatsApp sessions (without logging them out) and holds every queue and scanner. Only then is
  anything erased, so nothing is still writing into the project.
- **Never a customer's last project.** Its people would have nowhere to sign in to.

## What is erased

`deleteProjectData` (`apps/web/src/server/projectDeletion.ts`) runs one transaction under a
`FOR UPDATE` lock on the project row. It deletes every row of every table with a `"projectId"`
column for this project, then the project itself. The tables and their order come from the
database catalogue (`workspacePurgePlan`, shared with CUSTOMER_REMOVAL.md), so a table added later
is covered. `ModuleApproval` rows for the project go by their cascade.

After the commit, the project's media folders are removed (best effort): `whatsapp/`, `outbound/`,
`webchat/`, `webchat-brand/` and `social/`, each under `<projectId>/`.

**Not touched:** the customer's logins, roles, departments, addresses, other projects and the
platform's billing.

**Not erased:** the WhatsApp session profiles on the worker's volume. As with customer deletion,
their folders remain until removed by hand.

The project's own System Log goes with it. The deletion is recorded as a portal entry ("Project …
deleted permanently") with the rows deleted per table.

## Tests

`apps/web/src/__tests__/projectDeletion.integration.test.ts` (isolated database only) covers:

- refusing a project that is not archived;
- erasing an archived project's every row and file while the sibling project, the login and the
  customer stay unchanged;
- refusing a customer's last project.
