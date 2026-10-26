# Removing or deleting a customer (platform)

Platform → Customers → a customer → **Remove or delete this customer** (26 Oct 2026). The operator
chooses one of two outcomes. Both need:

- the customer's exact name, typed;
- the operator's own platform password.

The original installation (the founding customer) can be neither removed nor deleted. The
database refuses it as well, through `Customer_founding_never_removed`.

## Remove: keep the data

`removeCustomerData` (`apps/web/src/server/platform/customerRemoval.ts`) is one transaction. It:

- archives every workspace (`Project.status = ARCHIVED`). The worker then releases those WhatsApp
  sessions without logging them out, holds the queues and skips the scanners. This is the existing
  ARCHIVED rule.
- disables every address (`CustomerDomain.status = DISABLED`). The address then opens nothing, and
  Caddy gets no certificate for it.
- deactivates every login and revokes every session (`revokedReason = CUSTOMER_REMOVED`);
- ends open support access sessions and revokes pending invitations;
- records what it changed in `Customer.removalSnapshot`, and sets `removedAt` / `removedByUsername`.

**No row is deleted.** A removed customer:

- leaves the Customers list (it appears under **Removed**);
- leaves Monitoring;
- leaves the worker's billing loop: no recompute, no reminder emails;
- is refused by the plan, owner, address, details and support-access actions.

**Restore** (password only) puts back exactly what the snapshot recorded:

- workspaces return to their earlier status;
- addresses return to their earlier status;
- the logins that were active become active again.

Something that was already off before the removal stays off. Revoked invitations stay revoked; send
new ones. WhatsApp numbers reconnect by themselves, because the worker picks up a non-archived
project's accounts.

## Delete permanently

`purgeCustomerData`:

1. **Removes first**, as its own committed step. The worker lets go of the sessions, and nothing new
   is written.
2. **Then erases in one transaction.** It deletes every row of every table with a `"projectId"`
   column for the customer's workspaces, then the workspaces themselves. The table list comes from
   the database catalogue, so a table added later is covered.
3. **Deletes the customer's own rows:**
   - `User`, `PermissionModule`, `Department`, `JobTitle`, `Employee`;
   - `CustomerDomain`, `UserInvitation`, `SupportAccessSession`;
   - `SecuritySettings`, `PlatformBranding`, `SystemLog`.

**How the delete order is decided.** The order comes from the foreign keys (`deletionOrder`,
`packages/shared`):

- Children go before parents.
- Keys that cascade or set null are followed too. Otherwise deleting a login first would rewrite an
  immutable client payment that names it.
- A client and its current subscription point at each other. That cycle is broken through the
  non-blocking key only.
- A cycle of blocking keys refuses the whole delete, and nothing is deleted.

**Locking.** The workspaces are locked `FOR UPDATE` first. Every insert into a workspace table
needs a share lock on its project row, so nothing can arrive halfway through.

**What is kept.** The customer row stays, with `purgedAt` / `purgedByUsername` set, because the
platform's own billing for it is kept:

- `Subscription`, `SubscriptionInvoice`, `SubscriptionEvent`;
- `SubscriptionPayment`, which is append-only by trigger.

The customer page then shows only that history.

**Media files.** After the commit, `whatsapp/<projectId>/` and `outbound/<projectId>/` are removed
from the media volume. This is best effort, and a failure is reported.

**What it does not erase:** the WhatsApp session profiles on the worker's own volume. Their accounts
no longer exist, so the worker releases them (`releaseDeletedAccounts`), but their folders remain
until removed by hand.

## Records

Every outcome is a platform log entry on the Activity page:

- "removed (data kept)", with counts;
- "restored", with counts;
- "deleted permanently", with the workspace ids, rows deleted per table, and whether media was
  removed.

The customer's own System Log goes with the customer.

## Tests

- `apps/web/src/__tests__/customerRemoval.integration.test.ts` covers:
  - the confirmation (name, password, session, the original installation);
  - Remove deleting nothing;
  - Restore restoring exactly the snapshot;
  - Delete erasing every workspace row, login, address and media folder while keeping billing, and
    leaving another customer's every row and file untouched.

  Each assertion was confirmed to fail with its rule broken.
- `packages/shared/src/__tests__/deletionOrder.test.ts` covers the ordering rule.
