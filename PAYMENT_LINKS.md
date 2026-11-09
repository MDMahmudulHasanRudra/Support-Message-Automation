# Payment links

Feature `PAYMENT_LINKS`, **off by default**, because it handles money. Keys: `payments.view`, `payments.create`, `payments.manage` (merchant
accounts). Pages: `/payments`, `/payments/<id>`, Settings → Payment accounts, a Payment tab beside every conversation, and the customer's page at `/pay/<token>`.

**Not verified against a real gateway.** Both adapters (`server/payments/gateways.ts`) follow the providers' published APIs and are tested against
simulated answers. Before a business takes real money: put sandbox details in Settings → Payment accounts, make a link, and pay it on each gateway's
sandbox page, then check that the link shows Paid.

## How it works

Each business enters its own SSLCOMMERZ or bKash merchant details, so the money goes straight to it; none passes through this software. A person makes a
link beside a chat, and it lands in the reply box for them to send. The customer opens `/pay/<token>`, chooses how to pay, and pays on the gateway's
own page. When a link is for an invoice, a confirmed payment settles it through `applyClientPayment`, the same code a person's payment runs.

## Rules worth not undoing

- **A gateway's redirect or callback is never believed.** Only its reference is used, and the gateway is asked directly, server to server.
  An SSLCOMMERZ validation id must name this try's own `tran_id`.
- **Exact amount or it is not a payment.** A gateway's amount is read as text into paisa, never rounded. A different or unreadable amount is MISMATCH: the link
  stays open and a person is told.
- **No answer is neither paid nor failed** (UNKNOWN). The link is flagged and "Check again" asks the gateway. A later confirmation still counts.
- **bKash executes once.** A conditional claim decides who executes; anyone else only reads the status.
- **Settling is idempotent.** Conditional updates on the attempt and on the link, in one transaction. The invoice's payment key is `paylink-<link id>`.
- **Paid twice is flagged, never hidden**, and the invoice is settled once.
- **Paid but the invoice cannot take it** (settled by hand meanwhile): the money is recorded and a person is told. Nothing is forced onto the invoice.
- **The token is the only authority on the public page**, for that one link. Only its hash is searched; the encrypted copy is so staff can copy the link again.
- **Merchant details are write-only**, encrypted, and never reach a browser. Empty boxes keep what is saved.
- **Nothing is sent to a customer automatically.** A link only fills the reply box.

Refunds are not built: they are made in the merchant's own gateway account.
