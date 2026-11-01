# Approval-only modules: platform approval

Three modules never come with a plan. These are the features marked `manualOnly`:

- **WhatsApp profile pictures** (`WHATSAPP_AVATARS`)
- **Clients — Smart Bulk Import** (`CLIENT_SMART_IMPORT`)
- **Social Studio** (`SOCIAL_STUDIO`)

Their rule (decided 1 Nov 2026): **a platform operator approves them, per customer or per workspace. After that, the customer's Main Admin may switch them on and off.** Nobody on the customer's side can approve them.

## Three separate things

| Record | Decides | Who changes it |
|---|---|---|
| The plan (`Subscription.features`) | What the customer pays for. It never includes these three. | Platform (billing) |
| The approval (`ModuleApproval`) | Whether the module **may** be switched on | Platform operator, with their password re-entered |
| The switch (`ProjectFeature.enabled`) | Whether it **is** on | Customer's Main Admin (Module Builder, `projects.manage`) |

## Rules worth not undoing

- **Approving switches nothing on.** The approval scope is either every workspace of the customer (including workspaces created later) or one workspace.
- **The check is in the resolver.** `moduleEntitled` grants an approval-only module only when it is in `ModuleEntitlement.approvedFeatures`, whatever the plan says. `approvedFeatures` is a required field, so a caller that forgets it does not compile.
- **Adding needs approval; removing never does.** A module that is already on is kept by the resolver, like any grandfathered module.
- **One lock order everywhere: the customer's approval lock, then the `Project` row, then its `ProjectFeature` rows.** `applyModuleSelection` takes `module-approval:<customer>` as the FIRST statement of its transaction, before the version update — exactly like approve/revoke. Taking the Project row first and the lock second deadlocked against a revocation in flight (PostgreSQL `40P01`, reproduced by `moduleApprovals.integration.test.ts` › concurrency, which fails with the old order).
- **Checked again inside the write.** `applyModuleSelection` re-checks every approval-only module it adds, inside its own transaction and under the customer's advisory lock (`module-approval:<customer>`). The approve and revoke actions take the same lock. A revocation also moves the project's module version on, so a Module Builder page opened before the revocation is refused as stale.
- **Revoking switches the module off, in the same transaction.** It goes off in every workspace that no other approval still covers, together with anything that needs it (`modulesToWithdraw`). The change is recorded as an ordinary module change, `platform:<operator>`, with the reason.
  - Every existing gate reads that switch: pages, actions, the worker's `projectHasFeature`, and the app's background processors.
  - So new work stops: Social Studio publishes nothing (scheduled posts wait), new smart imports are refused, and pictures are no longer recorded.
  - An import already running finishes, as it always has when the switch goes off.
  - Nothing is deleted.
- **Never across customers.**
  - Rows are always read filtered by the project's owning customer. The founding customer owns the original installation's projects.
  - A database trigger refuses an approval that names a workspace of another customer.
- **Audit trail.**
  - Rows are never rewritten. A trigger (`module_approval_history_only`, tightened by `20261101120000_module_approval_audit_strict`) allows exactly one change: a COMPLETE revocation of an active approval — `revokedAt`, `revokedByOperatorId`, `revokedByUsername` and `revokeReason` together, a non-blank operator and reason, a time not before the approval and not in the future — with every approval field untouched. Revocation fields can never be filled in on their own, and a revoked row never changes again. A CHECK constraint (`ModuleApproval_revocation_complete_check`) holds the same all-or-nothing rule.
  - Rows cannot be deleted directly (`ModuleApproval_no_direct_delete`); they go only with their customer or workspace (FK cascade, `pg_trigger_depth() > 1`).
  - Each row keeps who approved it, when and why, and who revoked it, when and why.
  - The platform's Activity log records both approval and revocation.
  - The workspace's module history records what a revocation switched off.
- **The rows are platform data.** The column is `targetProjectId`, never `projectId`. A `projectId` column would make the table project-owned, with project-isolation triggers it must not have.

## Migrations

`20261101120000_module_approval_audit_strict` is a follow-up, not an edit of `20261101110000_module_approvals` (which may already be applied somewhere): it replaces the trigger function, adds the CHECK and the delete guard.

`20261101110000_module_approvals` keeps everything that works today. For every approval-only module that is switched on, it records one workspace approval, by `migration`.

A project whose owner cannot be named (no customer and no founding customer) gets no row. Its module stays on, but it cannot be switched on again until an operator approves it. The original installation must therefore be adopted as a customer for its approvals to be managed.

## Where

| Part | Path |
|---|---|
| Rules | `packages/shared/src/moduleApprovals.ts`, `projectModules.ts` (`moduleEntitled`, `NEEDS_APPROVAL`) |
| Database side | `apps/web/src/server/moduleApprovals.ts` |
| Platform actions | `server/platform/actions/moduleApprovals.ts` |
| Operator UI | Platform → Customers → a customer → **Approval-only modules** |
| Tests: pure rules | `packages/shared` `moduleApprovals.test.ts`, `projectModules.test.ts` |
| Tests: database | `apps/web` `moduleApprovals.integration.test.ts` (run with `test:isolated`) |
