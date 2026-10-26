# 02 — Meta capability matrix

This is research from Meta's developer documentation, read on 24 Oct 2026. It is **not** a promise
of availability. Meta changes products, permissions and pricing often, and whether a feature works
can depend on the app, the business, the account type and the country. Re-check each row on
developers.facebook.com before building it.

## How to read it

**Categories (from the brief):**

- **A:** available, with no Meta API usage fee.
- **B:** no API usage fee, but needs an approval (App Review / Advanced Access, sometimes Business
  Verification).
- **C:** needs a paid Meta service or external spending.
- **D:** restricted, unavailable or unsupported.

**One important point.** For a platform app serving businesses it does not own, **almost every row
is B in practice.**

- Standard Access only covers people who hold a role on the app.
- To reach real customers' Pages, the app needs Advanced Access through App Review. Meta then asks
  for Business Verification.
- "A" therefore only describes the platform's **own** Pages and test users.

**Status column:**

- **Built:** in the code and tested against a mocked Meta.
- **Live:** verified against real Meta. Nothing here is Live yet.

## Messaging (the scope of this work)

| Capability | Use | Permissions (Facebook Login path) | Approval | Webhook | Limits / window | Meta API fee | Cat. | Status | Phase |
|---|---|---|---|---|---|---|---|---|---|
| Messenger: receive and send text | Support inbox, AI replies | `pages_messaging`, `pages_manage_metadata`, `pages_show_list` | Advanced Access + App Review for other businesses' Pages | `messages`, `message_echoes` | 24 h standard window | None found for customer-initiated service messages | B | Built (one-click and manual) | 1 (this work) |
| Messenger: delivery / read status | Ticks in the thread | same | same | `message_deliveries`, `message_reads` | — | None | B | Built | 1 |
| Messenger: `HUMAN_AGENT` tag | A **person** replying 24 h–7 days | same + the Human Agent feature (its own App Review) | Separate App Review | — | 7 days, people only. **Never AI**; enforced by `decideReplyWindow` | None | B | Built, off until approved | 1 |
| Instagram DM (Messenger Platform, linked Page) | Support inbox, AI replies | `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list` | Advanced Access + App Review | `messages` (incl. echoes), `messaging_seen` | 24 h window; 1,000-**byte** text | None found | B | Built (one-click and manual) | 1 |
| Instagram API with **Instagram Login** | IG accounts with no Page | `instagram_business_basic`, `instagram_business_manage_messages` | App Review | own webhooks | 60-day user tokens that must be refreshed | None found | B | **Not built** (a second auth path and a refresh job; the existing provider is unchanged) | Later, if asked |
| Postbacks, quick replies | Buttons in replies | `pages_messaging` | as above | `messaging_postbacks` | 30 s bot response rule | None | B | Not built | 2 |
| Get Started, persistent menu, ice breakers | Entry experience | `pages_messaging` | as above | `messaging_postbacks` | — | None | B | Not built | 2 |
| Sending attachments | Files in replies | `pages_messaging` / `instagram_manage_messages` | as above | — | Size limits per type | None | B | Not built (OMNICHANNEL.md §9) | 2 |
| User profile (name) | Name a conversation | Messenger: profile fields of the sender; IG: user profile API | as above | — | Only for people who messaged the Page | None | B | Built (best effort; worker `fetchMetaProfileName`) | 1 |
| Handover protocol / conversation routing | Share a Page with another app | `pages_messaging` | as above | `messaging_handovers`, `standby` | — | None | B | Not built. A Business Suite reply already pauses AI through echoes. | 3 |
| Customer-service message tags other than HUMAN_AGENT | Updates outside the window | `pages_messaging` | Use-case restricted | — | Strict use cases; misuse restricts sending | None | D for this product (automated use not allowed) | Not built | — |
| One-time notification / Marketing Messages / Sponsored Messages | Promotions outside the window | — | Separate products | — | — | Marketing Messages and Sponsored Messages are **paid** | C | Not built, and must not be | — |

## Comments, Pages and publishing (not built, for a decision)

| Capability | Use | Permissions | Approval | Webhook | Notes | Meta API fee | Cat. | Phase |
|---|---|---|---|---|---|---|---|---|
| Instagram comments: read and reply, hide | Answer comments in the inbox | `instagram_manage_comments`, `pages_read_engagement` | App Review | `comments`, `live_comments` | — | None found | B | 3 |
| Instagram private replies | DM someone who commented | same | App Review | `comments` | One private reply per comment, within 7 days; follow-ups only after they answer | None found | B | 3 |
| Story replies and mentions | Shown as DMs | `instagram_manage_messages` | as above | `messages` | Story media URLs expire | None | B | 2 (largely arrives as messages already) |
| Facebook Page comments and replies | Answer Page comments | `pages_read_engagement`, `pages_manage_engagement` | App Review | `feed` | — | None found | B | 3 |
| Page posts / publishing | Social publishing | `pages_manage_posts` | App Review | — | Outside a support product's scope | None | B | Not planned |
| Instagram media publishing | Social publishing | `instagram_content_publish` | App Review | — | Daily publishing cap | None | B | Not planned |
| Page and Instagram insights | Reach and engagement | `read_insights`, `instagram_manage_insights` | App Review | — | Not support data | None | B | Not planned |

## Leads (not built, for a decision)

| Capability | Use | Permissions | Approval | Notes | Meta API fee | Cat. |
|---|---|---|---|---|---|---|
| Lead Ads webhook + lead retrieval | Leads into Clients | `leads_retrieval`, `pages_manage_ads`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`; the token from someone who can ADVERTISE on the Page | App Review, then Business Verification | The webhook carries only a `leadgen_id`; the lead is fetched with a second call. **The ads that produce leads are paid advertising.** | API: none found. Ads: paid | B for the API; C for the ads that produce the leads |
| Click-to-Messenger / Click-to-Instagram-Direct entry | Conversations from ads | `pages_messaging` | as messaging | Opens a window of up to 7 days after the first message; `messaging_referrals` webhook | API none; **the ad is paid** | C |
| m.me / ig.me links | Free entry points | none extra | — | Plain links a business can publish | None | A |

## Pricing notes

- No Meta source was found that charges for Messenger or Instagram customer-service messages
  inside the 24-hour window. Meta's pricing pages found cover **WhatsApp** (per-message since 1 Jul
  2025) and paid Marketing Messages.
- WhatsApp Cloud API pricing does not apply to this product's WhatsApp: it uses OpenWA, which is not
  Meta's API. WhatsApp is **not** in scope here.
- Advertising (Lead Ads, click-to-message ads, Sponsored Messages) is paid, even though its API is
  free to call.

## Policy notes that affect the existing AI

- **Automated replies must disclose automation where the law requires it** (Meta names California
  and Germany). They must disclose it at the start of a conversation, after a long gap, and when a
  person hands back to automation. Meta requires it only where the law does and gives no number for
  the "lapse of time". **Built as a Messenger / Instagram per-connection setting, off by default**
  (`08-ai-disclosure.md`, branch `feat/ai-disclosure`).
- **Bots must answer within 30 seconds.** The channel AI answers within its own pipeline, usually a
  few seconds after the worker picks the message up. Under load or with a slow model it could take
  longer. Live testing must measure this.
- **`HUMAN_AGENT` is for people only.** It is enforced in code (`decideReplyWindow`); AI never uses
  it.

## Priority order (decided 25 Oct 2026)

**Nothing below is built until the current one-click integration has passed real Meta testing**
(`META_DEVELOPER_SETUP.md` §8), by the owner's decision.

Ranked by value to a support team, cost, and how much new approval each needs:

| # | Capability | Why this rank | New approval | Meta fee |
|---|---|---|---|---|
| 1 | **Live verification of what is built** (Messenger + Instagram DM, receipts, echoes, Human Agent) | Everything else rests on it | App Review for the five messaging permissions, Business Verification | None |
| 2 | **Sending attachments** (images, files) in replies | The most-asked inbox gap; no new permission | None beyond #1 | None |
| 3 | **Quick replies and postbacks** (buttons in replies) | Faster answers, with the same permissions; AI and rules can offer choices | None beyond #1 | None |
| 4 | **Instagram story replies and mentions**, shown properly | They already arrive as messages; this is display only | None beyond #1 | None |
| 5 | **Instagram comments + private replies** | Comments are where many customers ask first; a private reply moves the question to DM | `instagram_manage_comments`, `pages_read_engagement` (App Review) | None |
| 6 | **Facebook Page comments and replies** | The same for Pages | `pages_read_engagement`, `pages_manage_engagement` (App Review) | None |
| 7 | **Get Started, persistent menu, ice breakers** | A better first contact; set once per Page | None beyond #1 | None |
| 8 | **Lead Ads → Clients** | Valuable for sales, but leads come only from **paid ads**, and it needs the most approval | `leads_retrieval`, `pages_manage_ads`, ads permissions + Business Verification | API none; ads paid |
| — | Instagram Login (accounts without a Page) | Only if customers ask; adds a second token type and a refresh job | Its own App Review | None |
| ✕ | Marketing Messages, Sponsored Messages, other message tags for automation | Paid, or not allowed for automated use | — | Paid |

Items 2–4 and 7 need no new App Review once #1 is approved, so they are the cheapest next steps.
Items 5–6 need one more review round, and item 8 the most.

## Sources

- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)
- [Long-lived access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived)
- [Messenger webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks)
- [Messenger messaging policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview)
- [Webhooks getting started (batching, retries)](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)
- [Data deletion callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback)
- [Instagram Messaging webhooks](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks)
- [Instagram private replies](https://developers.facebook.com/docs/instagram-platform/private-replies/)
- [Lead Ads webhooks integration](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/quickstart/webhooks-integration/)
- [WhatsApp pricing (for contrast)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
