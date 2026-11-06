# Competing with REVE Chat — gap plan and status

Source: competitor research of revechat.com, 6 Nov 2026 (public site, release notes v6.5.0–v6.6.1, help center,
review sites). REVE Chat sells to the same market (bKash, 10 Minute School, LankaBangla are named customers) and
already takes bKash / SSLCOMMERZ payments inside its AI agent.

Every item is built behind its own project feature flag, **off by default**, tested on the isolated database only,
and never deployed without the owner's approval. Our strengths stay untouched: WhatsApp groups at roster scale,
AI that answers only from human-verified knowledge, Bangla / Banglish handling, team operations, client billing and
commerce, multi-project and white label, and send safety (rate limits, no automatic retry of uncertain sends).

## Status

| # | Gap (what REVE Chat has) | Our answer | Status |
|---|---|---|---|
| 1 | Message search across conversations | Full-history WhatsApp message-text search, trigram index, two phases (≤ ~225 ms measured on 3.6M messages) | **Built** (`fa8a4ad`, needs a hand-run index build before deploy) |
| 2 | "Highest wait time" sort, "last message sender" filter | Wait shown on each row, longest-waiting sort, last-sender filter | **Built** (`f955618`) |
| 3 | Post-chat CSAT rating + CSAT report | `CSAT_SURVEYS`: rating after Resolve (widget card, channels, optional WhatsApp 1:1), Bangla digits, cooldown, report per agent / channel | **Built** (`CSAT.md`) |
| 4 | Auto routing (round-robin, availability / break aware) | `AUTO_ROUTING`: round-robin or least-open, capacity, on-duty from our roster and leave, "Distribute evenly" bulk action | **Built** (`AUTO_ROUTING.md`) |
| 5 | Contact Follow-Up workspace | `FOLLOW_UPS`: Mine / Team / Overdue / Due today / Upcoming / Done, linked to conversations and clients; never messages the customer | **Built** (`FOLLOW_UPS.md`) |
| 6 | AI looks up the customer's own data and acts | AI grounded on the customer's own client record (dues, expiry, plan) — only for the verified sender number, exactly like commerce grounding | **Built for agent Copilot drafts only** (`AI_CLIENT_ANSWERS.md`). **Automatic answers need an owner decision**: automatic WhatsApp AI runs only in groups, and account details are never given in a group |
| 7 | Agent mobile app + push notifications | Installable web app (PWA) with web push for assignments, waits and mentions | Planned |
| 8 | Ownership folders (Unassigned, AI-handled, Bot) | "AI is handling" view beside Mine / Unassigned | Planned |
| 9 | Visual bot flow builder | Numbered-menu flows (works on linked-device WhatsApp), buttons on widget / Messenger / Telegram | Planned |
| 10 | Sentiment filter | Mood (already detected) as an inbox filter | Planned |
| 11 | Right panel tabs incl. Files | Files tab: every attachment in the conversation | Planned |
| 12 | Payment links in chat (bKash, SSLCOMMERZ) | Invoice → payment link → payment recorded → AI can answer "what do I owe" | **Blocked: merchant credentials** (bKash sandbox app key/secret, SSLCOMMERZ store id/password) |
| 13 | Official WhatsApp Cloud API + campaigns | Second WhatsApp mode beside linked devices, opt-in template campaigns | **Blocked: Meta Business verification and app review** |
| 14 | Email as an inbound channel | Email-to-conversation | **Blocked: a mailbox (IMAP or inbound webhook provider) to connect** |
| 15 | SMS notices | Local SMS gateway for outage / expiry notices | **Blocked: SMS gateway account** |
| 16 | Video / co-browse / voice AI | — | Not planned now (low value for our market; Bangla speech unproven) |

## Where we already lead (keep and sell)

- WhatsApp **groups** support at 1,800+ groups (REVE Chat does not claim groups).
- AI that never invents business facts; every answer traceable to a verified entry.
- Bangla / Banglish reply rules.
- Real attendance and work time from messages, roster, leave, overtime, Missed / Recall.
- Billing, subscriptions, invoices, commerce and couriers in the same product.
- Reseller layer: many workspaces, white label, platform billing.
- Trust: kill switch, rate limits, never sending twice, disconnect means stop.
