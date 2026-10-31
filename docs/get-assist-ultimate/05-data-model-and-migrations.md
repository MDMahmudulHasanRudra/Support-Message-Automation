# 05 — Data model proposal and migration rules

**Status:** proposal. No migration has been written. Exact columns are fixed in each phase's work package after
re-reading the models it touches.

## 1. Rules every new model follows

1. `projectId String` with the scoped client; composite `(projectId, …)` uniques; never a default project.
2. Every relation between two project-owned tables gets a `<Child>_<column>_same_project` trigger in the same
   migration (`projectIntegrity.integration.test.ts` fails until it exists).
3. Money is `BigInt` minor units + an explicit currency; never summed across currencies; never `Float`.
4. History is append-only where it is evidence (events, payments, executions); corrections are new rows.
5. Expand → migrate → contract. A first release never drops or renames a column. FKs on large tables are added
   `NOT VALID` and validated in a separate migration.
6. Migration names are dated after the newest existing one (`20261026090000_customer_removal`).
7. A model that duplicates an existing source of truth is not added (see `00` §4).

## 2. Extensions to existing models (Phases 2, 5)

| Model | Change | Why |
|---|---|---|
| `ChannelConversationStatus` | add `PENDING`, `WAITING_CUSTOMER`, `SNOOZED`, `RESOLVED` (keep `OPEN`, `CLOSED`) | lifecycle without a second status system |
| `ChannelConversation` | `priority`, `snoozedUntil`, `resolvedAt`, `resolutionReason`, `assignedTeamId` | V3 list filters |
| new `ConversationNote` | `projectId`, a typed reference to either a WhatsApp conversation (account + chat id) or a `ChannelConversation`, `body`, `authorUserId`, `createdAt`, `deletedAt` | internal notes; stored apart from every message table so no send path can ever read one |
| new `ConversationEvent` | append-only audit of status / assignment / priority changes for both conversation kinds | the timeline and assignment history |
| `SupportEscalationCase` / `SupportAssignment` | Phase 5 decides between extending these and a `Ticket` model that references them; **not** a parallel ownership system | prompt §4.2, §12 |

WhatsApp conversations stay derived (no table), exactly as today; notes and events reference them by
`(accountId, chatId)`.

## 3. New domains (later phases, names provisional)

| Phase | Models |
|---|---|
| 3 AI Copilot | `AiDraft` (conversation ref, text, sources, accepted/edited/discarded, tokens, cost), `AiUsage` (per call: job, provider, model, tokens in/out, cost minor units, project) |
| 4 Website chat | `WebChatWidget`, `WebVisitor` (unverified by default), reuse `ChannelConnection`/`ChannelConversation`/`ChannelMessage` with a new `ChannelType.WEBCHAT` |
| 5 CRM | `Lead`, `Opportunity`, `PipelineStage`, `SalesTask`; `ChannelIdentity` linking a channel sender to a `Client` with `verificationStatus` + `linkedByUserId` |
| 7 Commerce | `StoreConnection`, `CatalogProduct`, `ProductVariant`, `InventoryLevel`, `CommerceOrder`, `CommerceOrderItem`, `OrderEvent`, `CommercePayment` — separate from `ClientDue`/`ClientPayment` and SaaS billing |
| 8 Delivery | `CourierConnection`, `Shipment` (unique per order + provider idempotency key), `ShipmentTrackingEvent` (raw provider status kept) |
| 9 Workflow | `WorkflowDefinition`, `WorkflowVersion` (immutable once published), `WorkflowExecution`, `WorkflowStepExecution` |
| 10 Integrations | `ApiKey` (hashed, scoped), `OutboundWebhook`, `WebhookDelivery`, `DomainEvent` (transactional outbox) |

## 4. Credentials

Five integrations already store secrets five ways (`ChannelConnection`, `GoogleIntegrationAccount`,
`GoogleIntegrationConfig`, `AiProvider`, `EmailSettings`), all through `encryptSecret`. New integrations use the same
helper; a shared `IntegrationCredential` table is only worth introducing in Phase 10 if it replaces rather than
adds to these.
