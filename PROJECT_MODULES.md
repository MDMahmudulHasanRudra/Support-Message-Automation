# Project types and modules

Get Assist is one application. Each project chooses a business type and a set of modules
(29 Oct 2026, Get Assist Ultimate WP1–WP4 core). Main Admin → a project → **Type & modules**.

## §1 What is built, and what is not

| Part | Status |
|---|---|
| Project types DEFAULT / ECOMMERCE / CUSTOM_MIX | Built |
| Module registry (`packages/shared/src/projectModules.ts`) | Built |
| Dependency resolver: hard, one-of, recommended, conflicts, plan, removal impact, cycles | Built, unit-tested |
| Module Builder page | Built (`/admin/projects/<id>/modules`) |
| Apply with version check, history, restore | Built |
| Commerce modules: catalogue, orders, pipeline, courier, WooCommerce, Shopify | **Not built.** Listed as "Coming soon" and cannot be selected |
| Reusable customer templates, Create-project type step, read-only archive of a switched-off module, AI tool policy per module | **Not built yet** |

## §2 Layers, and why they are separate

| Layer | Where | Decides |
|---|---|---|
| Project type | `Project.projectType` / `projectBaseType` | A label and the template it started from. It grants nothing. |
| Template | `templateModules(type)` | A proposal only. |
| Selection | `ProjectFeature` rows | What is on. These rows are the same switches that already gate the sidebar, pages, actions and worker loops. There is no second switch. |
| Plan | the customer's `Subscription` | What may be **added**. |
| Permissions | roles (unchanged) | What each person may do inside. |

A module operates only when it is selected AND every existing check still passes.

**Plan rules:**
- Choosing ECOMMERCE never grants a plan feature or a permission.
- A customer with no subscription, or with an "All Access" plan, is never held back.
- A plan never holds back a manual-only module.
- A module that is already on stays on, even if the plan would not allow adding it today. It is shown as "kept".

## §3 The registry

**Available modules.** Every available module **is** one `PROJECT_FEATURES` entry. Its name,
description, routes, permission keys and background effect are read from that entry, never written
twice. The registry adds only:
- category and benefits;
- dependencies;
- which types recommend it;
- AI capabilities;
- setup steps;
- what happens to its data when it is off.

A test fails when a feature has no registry entry.

**Planned modules** have no feature behind them and can never be selected. A planned module becomes
available only together with its feature entry and its real implementation.

## §4 Dependencies

- **HARD:** needed. It is added automatically. Removing it asks whether to switch off its dependents
  too (`removalImpact`).
- **ONE_OF:** a HARD dependency with several alternatives. At least one must stay on; when none is on,
  the first one the plan allows is added.
- **RECOMMENDED:** suggested. The admin may add it or decline it, and a declined one stops being offered.
- **OPTIONAL:** information only.
- **Conflicts:** refused, never saved.

**Determinism.** Resolution sorts its input, so the same request always gives the same result.

**Server check.** The server resolves the browser's request again before saving. A removed hard
dependency therefore simply comes back, and an invalid state cannot be stored.

**Cycles.** A test (`moduleDependencyCycles`) keeps the dependency graph free of cycles.

## §5 Applying a configuration

`applyProjectModules` (`apps/web/src/server/actions/projectModules.ts`) needs `projects.manage`. It
runs one transaction:

1. **Version check.** The project's `moduleConfigVersion` must still be the version the admin saw.
   Otherwise the change is refused: "somebody changed this project's modules".
2. **Feature rows.** Only the `ProjectFeature` rows whose value changes are written. A project with no
   rows keeps following the defaults for everything it did not change.
3. **History.** One `ProjectModuleConfigChange` row is written: before, after, auto-added, declined,
   reason and actor. The table is append-only by trigger.

**Restore** re-applies a history row's modules through the same action.

**The old single-feature switch** (`setProjectFeature`) now goes through the same action. It refuses
to remove a module that others need, and names them.

## §6 Switching off ("freeze")

A switched-off module behaves exactly as a switched-off feature always has:
- its pages and actions refuse;
- its background work stops (the worker checks `projectHasFeature`);
- its data and settings are kept, and it comes back unchanged.

Switching any module, or the type, never touches a WhatsApp session.

**Not built yet:** read-only access to a switched-off module's archive.

## §7 Tests

- `packages/shared/src/__tests__/projectModules.test.ts` (20 tests). Each core rule was confirmed to
  fail its test when broken: hard dependencies, manual-only, one-of removal, keeping already-on
  modules, declining.
- `apps/web/src/__tests__/projectModules.integration.test.ts` runs on CI's throwaway database. It covers:
  - the permission check;
  - dependencies on apply;
  - writing only changed rows;
  - history, and that it is append-only;
  - the stale version;
  - planned and unknown modules;
  - the plan;
  - Restore;
  - another customer's project.
