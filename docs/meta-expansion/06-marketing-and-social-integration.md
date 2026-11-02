# 06 — Social, marketing and leads

Status: **proposal.** Social Studio is reused; nothing is replaced, and Postiz or any external runtime stays out.

## 1. Social Studio (Release A, then C)
- **A:** live-verify the existing Facebook Page and Instagram publishing with a real app in Development mode;
  fix G1 (customer-address OAuth, see 04 §2); add OAuth start/callback tests (none exist).
- **C — comments management:** new `SocialComment` table (project-owned): account, post target (if ours), external
  comment id, parent, author name/id, text, created time, status (visible/hidden/deleted/replied), replied by.
  Sources: `page.feed` and `instagram.comments` webhooks + a bounded backfill per post. Actions: reply, hide,
  delete (Facebook), private reply (Instagram, within 7 days, one message — goes to the Instagram DM conversation
  as an outbound `ChannelMessage` only if the workspace also has messaging for that account).
  Permissions: a separate engagement consent (04 §1). Keys: `social.engage` (new).
- **C — insights:** daily Page and IG account insights + per-post insights into `SocialInsightSnapshot`; a metric
  Meta does not return is absent, never 0 (existing rule).
- Content already published is never edited without a new approval (existing approval hash).
- Social Studio stays `manualOnly` with platform `ModuleApproval`.

## 2. Messenger extras (Release C)
Quick replies and postbacks (store and route; a postback can start an automation rule only if the project's
automation allows it), persistent menu and Get Started (configured per connection, pushed with Messenger Profile API).

## 3. Meta Ads Manager (Release D) — read-only first
New feature `META_ADS` (manualOnly), keys `meta_ads.view`, `meta_ads.manage` (manage unused until the separate
approval). Tables `MetaAdAccount`, `MetaAdInsightSnapshot` (account, level, object id, date, spend in minor units +
the account's currency, impressions, clicks, reach, actions JSON). Pulls daily with bounded pagination and the
account's own timezone; never sums across currencies. Management (create/edit, budgets) is a later, separately
approved work package with confirmations and spend caps. The UI says plainly that ads are paid to Meta by the
customer's ad account; the API being free does not make ads free.

## 4. Lead Ads (Release D)
`page.leadgen` webhook → `MetaLeadEvent` (dedup on `leadgen_id`) → fetch the lead with `leads_retrieval` →
create or match a commerce `SalesLead` (and optionally a Client) by explicit field mapping per form; duplicates are
matched on email/phone with the existing duplicate rules, never merged automatically; assignment, notification
and reporting reuse the Sales pipeline. Lead history is append-only (existing trigger).

## 5. Conversions API (Release E, only after partner requirements are verified)
Optional per project: Pixel ID + token from the customer; events limited to business outcomes we already record
(order paid, lead won) with hashed email/phone and explicit consent flags; event id for dedup; never message
content; a test-event code mode; per-event delivery log.
