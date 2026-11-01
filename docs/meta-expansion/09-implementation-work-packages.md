# 09 — Implementation work packages

**Nothing below is built yet. Each package needs the owner's go-ahead.** Each ends with: summary, files,
migration impact, tests, security review, Meta setup, remaining approvals, rollback. Incomplete integrations stay
behind flags (off).

## Release A — stabilise what exists (no new Meta product)
| WP | Scope | Migration | Needs Meta? |
|---|---|---|---|
| A1 | Visible label "WhatsApp (Legacy)" for the OpenWA channel/module (01 §6), no identifier change; regression tests that Legacy WhatsApp reports, inbox and worker are unchanged | none | no |
| A2 | Social Studio OAuth through the messaging gateway (04 §2): `MetaOAuthPurpose.SOCIAL_CONNECT`, purpose-aware callback/claim, tests for start/callback/claim incl. wrong host/user/browser/replay | 1 enum value | no (mock); live in A4 |
| A3 | Hygiene: one Graph version constant (v26.0 after A4 checks), one Page-fields constant, `META_SOCIAL_LOGIN_CONFIG_ID` in compose/.env.example, Meta routes exclude WEBCHAT explicitly, manual webhook limit 8 MB, Notification Center event on NEEDS_RECONNECT | maybe 1 enum value | no |
| A4 | **Gate B**: real Meta app in Development mode — messaging and Social Studio live tests with app-role testers (runbook 10-gate-b) | none | **yes (owner)** |
| A5 | **Gate C**: Business Verification + App Review for messaging and publishing permissions | none | **yes (owner + Meta)** |

## Release B — WhatsApp (Official API)
| WP | Scope |
|---|---|
| B1 | Provider adapter refactor (03 §3), exhaustive switches; existing channel tests unchanged |
| B2 | `ChannelType.WHATSAPP_CLOUD`, `wabaId`, template + usage tables, feature `WHATSAPP_OFFICIAL` (manualOnly), keys |
| B3 | Webhook `whatsapp_business_account`: splitter, routing by WABA + phone number id, statuses, template status, quality |
| B4 | Embedded Signup v4 (JS SDK, nonce, code exchange, verify, subscribe, register) |
| B5 | Inbox: send/receive text, media, interactive; window rules; templates (list, sync, send with cost confirmation) |
| B6 | AI on Official WhatsApp (inside window only) after policy check; human handover; reporting |
| B7 | Tech Provider onboarding, Business Verification, App Review videos; live test with an owned number; pilot |

## Release C — engagement
C1 comments (FB + IG) and private replies · C2 Page/IG insights · C3 Messenger quick replies, postbacks,
persistent menu, Get Started · C4 App Review for the engagement permissions.

## Release D — marketing
D1 Meta Ads Manager read-only · D2 Lead Ads → Sales leads · D3 Full Access request (500 calls/15 days) · D4 (separately
approved) ads management with confirmations and caps.

## Release E — other
E1 Conversions API after partner requirements are verified · E2 re-check special products yearly; nothing built
for Audience Network, Fundraisers, Jobs, Meta Pay.

## Suggested order and effort (engineering only, excluding Meta's review time)
A1 small · A2 medium · A3 small → A4/A5 owner-driven → B1 medium · B2–B5 large · B6 medium → C large → D large → E medium.

**Critical path:** the platform Meta app does not exist yet. Until the owner creates it and starts Business
Verification, everything Meta-facing can only be mock-tested.
