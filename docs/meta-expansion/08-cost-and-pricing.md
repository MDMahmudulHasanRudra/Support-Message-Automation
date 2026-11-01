# 08 — Cost and pricing

Checked 1 Nov 2026 against Meta's docs (see 02). Figures change; the product must link to Meta's rate card
rather than hard-code prices.

| Product | API cost | Who pays what |
|---|---|---|
| Messenger, Instagram DM, comments, publishing, insights | Free [F/K] | Nothing billable |
| WhatsApp Cloud API | **Per delivered message** by category (marketing, utility, authentication templates; service; Meta Business Agent) [F] | The customer's WhatsApp Business Account pays Meta directly with its own payment method (Tech Provider model) [F] |
| Marketing API | Free [K] | Ad spend is charged to the customer's ad account |
| Lead Ads | Free [F] | Leads come from the customer's paid ads |
| Conversions API | Free [F] | — |

## WhatsApp details to show customers
- Messages from customers to the business are free; each message is charged at most once [F].
- Free-form replies only inside 24 h of the customer's last message [F].
- From 1 Oct 2026: 1,000 free service messages per business phone number per month, then charged; utility
  templates sent inside the window are now charged [F].
- A reply to a Click-to-WhatsApp ad opens a 7-day window in which messages are free [F].
- Bangladesh is its own rate-card market from 1 Oct 2026 [F].
- Messaging limits (unique users outside a window per 24 h) start at 250 per business portfolio [F].

## Controls in Get Assist
1. **Explanation at connect:** Meta bills your WhatsApp account; add a payment method in WhatsApp Manager.
2. **Per-send confirmation for templates:** category, "billed by Meta to <WABA name>".
3. **Template category validation** before submission (marketing vs utility vs authentication) with Meta's own rules.
4. **Optional monthly cap** on template sends initiated from Get Assist (we can enforce it because we send them).
   Meta-side spend limits remain the customer's in WhatsApp Manager.
5. **Usage records** from webhook pricing data — awareness only, never presented as an invoice.
6. **No billable automation by default.** AI never sends templates; bulk template sending is not built.
7. Get Assist's own subscription pricing for these modules is a business decision (platform plans), separate
   from Meta's charges.
