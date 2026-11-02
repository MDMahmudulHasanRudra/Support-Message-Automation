# 10 — Testing and release gates

## 1. Baseline (before any change on this branch)
Taken from the last full run on the same code (1 Nov 2026, isolated PostgreSQL 16): shared 1,293 · engine 79 ·
forge-client 51 · ai-client 31 · media-storage 14 · web isolated 1,218 passed / 17 skipped · worker isolated
1,419 passed / 6 skipped · typecheck clean · lint 0 errors (8 pre-existing warnings) · web production build OK ·
browser E2E 14/14 (Client CRM V7). Re-run at the start of the first implementation package.

## 2. Gates per release
| Gate | Meaning |
|---|---|
| A — local | all suites, typecheck, lint, builds green; new tests confirmed to FAIL without the code they protect |
| B — live dev | real Meta app in Development mode with app-role testers; every connect/send/receive/publish path exercised; results recorded |
| C — approval | Business Verification done; App Review approved for exactly the permissions the release uses |
| D — pilot | one real customer, limited scope, with rollback rehearsed |

No feature is shown to customers as available before C and D.

## 3. Tests to add
- **Legacy WhatsApp regression:** label change touches no identifier; inbox lists, Team Report, group sync, outbound queue, personal chats unchanged (existing suites + a snapshot of nav/module keys).
- **OAuth:** every flow — wrong browser, wrong user, replayed state, expired state, replayed claim, customer host A started / host B claimed, allowlist off, permission missing.
- **Webhooks:** signature failure; unknown object; cross-tenant WABA/phone number; same Page different capabilities in different projects; duplicates; 1,000-entry batch; revoked asset.
- **WhatsApp Official vs Legacy isolation:** an Official message never creates a `Message`/`OutboundMessage` row; Legacy reports unchanged.
- **Billing:** template send requires confirmation and the permission; cap blocks; AI never sends a template.
- **Meta API errors:** auth (190/102) → NEEDS_RECONNECT; rate limit → backoff; ambiguous → UNKNOWN never resent.
- **Module approval / revocation** for every new manualOnly feature.

## 4. Rollback
Every package: code rollback is safe while its flag is off; migrations are additive (enum values cannot be
removed in place — harmless while unused); each migration carries its own pre-use rollback statements.
