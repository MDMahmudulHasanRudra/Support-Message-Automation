# Commerce-aware AI (WP5)

The AI answers from what the project EFFECTIVELY has — its modules plus its own switches — never from
the project type's label. A project without Courier Management never hears the AI claim to track a
parcel, whatever its type. Migration `20261030090000_ai_commerce_policy` adds five `AiSettings` columns.

## Settings (AI Settings → Commerce answers)

| Switch | Default | Works only while |
|---|---|---|
| Answer product questions from the catalogue (`commerceProductAnswers`) | off | Product Catalog is on |
| Say how many are in stock (`commerceShowStockCount`) | off | product answers are on |
| Tell customers the status of their own orders (`commerceOrderAnswers`) | off | Order Management is on |
| Tell them where their delivery is (`commerceDeliveryAnswers`) | off | order answers + Courier Management are on |
| Hand requests to buy, cancel, return or change an order to a person (`commerceHandoverRequests`) | on | any commerce answer is on |

Switching a project's type or modules never rewrites these: an answer simply stops while its module is off,
and comes back unchanged when it is on again. The page shows any switch that is on but not active, and why.
A project that never opens this card answers **exactly** as before: with every switch off,
`findCommerceGrounding` returns nothing without a single query, and the prompt is byte-identical
(the worker's prompt tests pass unchanged).

## How it works (`packages/shared/src/aiCommerce.ts`, `apps/worker/src/aiFallback/commerceContext.ts`)

- **Grounding, never a reply.** Matching catalogue products ("Product: …") and the customer's own orders
  ("Your order ORD-…") become reference entries the normal prompt answers from. Every existing gate still
  applies afterwards: scope, confidence, the business-question guard, the send-time safety re-check. They
  are this team's own data, so they ground a business answer like verified knowledge does.
- **The policy is resolved per message** (`resolveAiCommercePolicy`) from the project's modules and the
  switches, and the prompt gets a COMMERCE block (`commercePromptRules`) only when one is active, saying
  exactly what is available and what is not ("Delivery tracking is not available here…").
- **Order details only for a verified customer.** On WhatsApp the sender's number must be one WhatsApp
  itself delivered (`…@c.us` on the stored message, never a LID), and an order is shown only when its
  phone normalises to exactly that number. An order number typed by somebody else unlocks nothing.
  Messenger, Instagram, Telegram, website chat and the Sandbox carry no verified number, so they get
  product answers only. The Copilot (agent drafts, never sent) gets orders only in a one-to-one WhatsApp chat.
- **Requests go to a person.** "I want to buy / cancel / return / change …" (English, Banglish and
  Bengali, first-person phrasing only — "what is your return policy?" is still a question the AI may
  answer from knowledge) hands over as `COMMERCE_REQUEST` before any AI call. The AI never creates,
  changes, cancels or refunds an order, books a delivery or reserves stock.
- **Prices are checked mechanically.** With any commerce answer on, every money amount in a reply
  (a number next to ৳ / Tk / taka / টাকা / BDT / $ …, Bengali digits included) must appear in the
  catalogue or order entries it was given; otherwise the reply is handed over as `UNGROUNDED_PRICE`.
- **All four AI paths share it**: the WhatsApp AI fallback, channel AI, the Sandbox and the Copilot.
  Evidence snapshots record commerce entries by title with no knowledge-row link.

## Settings review — the eight settings that did nothing

`screenshotResponseEnabled`, `chatLearningEnabled`, `softwareLearningEnabled`, `requirementLearningEnabled`,
`announcementAiEnabled`, `duplicateSimilarityThreshold`, `learningConfidenceThreshold` and
`autoApprovalThreshold` were saved by the form and read by nothing anywhere (verified by search across
apps and packages). The audit counted seven; `learningConfidenceThreshold` is the eighth. Decision for
each: **removed from the page and no longer written** — implementing any of them would change AI
behaviour without a test, which the plan forbids. The columns and their stored values stay; a later
cleanup migration may drop them. `humanReviewThreshold` is live and stays on the page.

## Not built (be honest)

- AI drafting an order for a person to confirm (order draft + human confirmation): not built; a buying
  request is handed over instead.
- Product recommendations beyond "products matching the words of the question".
- Per-business-type copies of every AI setting: settings are per project and survive type switches; only
  the commerce switches are new.
- A Sandbox field to test order answers as a given customer number (the Sandbox shows the unverified case).
- Verified by typecheck, lint and the existing unit tests only (worker 473, shared 1,176); no new tests,
  as requested, and no live conversation has been run through it.
