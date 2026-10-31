# Commerce — products, stock, orders and the sales pipeline

Work package WP8 of the modular platform (`PROJECT_MODULES.md`). Three project features, each **off by
default** and on in the E-commerce business type and its template:

| Feature | Pages | Keys |
|---|---|---|
| `PRODUCT_CATALOG` | `/commerce/products` (list, new, `[id]`) | `commerce.view`, `commerce.manage` |
| `ORDERS` (needs `PRODUCT_CATALOG`; Client Management recommended) | `/commerce/orders` (list, new, `[id]`, `[id]/edit`) | `orders.view`, `orders.manage` |
| `SALES_PIPELINE` (Client Management recommended) | `/sales` (board, new, `[id]`) | `sales.view`, `sales.manage` |

Sidebar: **Commerce** (Orders, Products, Sales Pipeline). Commerce is the CUSTOMER'S own selling — it has
nothing to do with the platform's SaaS billing, and it never sends a message to anybody.

## Data (migration `20261029150000_commerce_core`)

Nine project-owned tables, every one with `projectId DEFAULT project_id_required()`, the
`_projectId_immutable` trigger and a `_same_project` trigger per relation (14, including `Client`):
`ProductCategory`, `Product`, `ProductVariant`, `InventoryMovement`, `CommerceOrder`, `CommerceOrderItem`,
`CommerceOrderEvent`, `SalesLead`, `SalesLeadEvent`. Additive only; nothing existing changes.

- **Money is BigInt minor units** (`toMinor` / `formatMinor`), never a float, and **an order has ONE
  currency** — a product in another currency is refused on the order. CHECK constraints refuse negative
  prices, totals, payments and stock, and a discount above the items' total.
- **Order numbers** come from the `commerce_order_seq` sequence (`ORD-000042`), unique per project.
- **A SKU is unique within a project when given** (partial unique index).
- **`CommerceOrderEvent` and `SalesLeadEvent` are append-only** (a trigger refuses UPDATE). They are the
  order's and the lead's history: every status move, payment, refund mark, edit, stage move and note.
- `externalSource` / `externalId` on products and orders are for the WooCommerce / Shopify connectors
  (planned, not built).

## Rules worth not undoing (`packages/shared/src/commerce.ts`, `apps/web/src/server/actions/commerce.ts`)

- **Status moves are one table** (`ORDER_TRANSITIONS`): Draft → Confirmed / Cancelled; Confirmed →
  Processing / Shipped / Cancelled; Processing → Shipped / Cancelled; Shipped → Delivered / Returned;
  Delivered → Returned. Cancelled and Returned are final. Every move is a conditional update on the
  status the person saw, so it happens once.
- **Stock moves only through `orderStockEffect`**: confirming DEDUCTS tracked items, cancelling a
  confirmed/processing order or any return RESTORES them; a draft never touches stock. Deducting is a
  conditional `updateMany … stockQuantity >= qty` inside the same transaction as the status move, so two
  people confirming the last item cannot both take it, and a short item refuses the whole confirmation
  with nothing changed. **Every stock change writes an `InventoryMovement` with its `balanceAfter`** —
  the stock figure is always explained by its movements. Products with "Track stock" off are never counted.
- **Items and prices are editable only on a draft** (`orderItemsEditable`). The server re-prices every line
  from the catalogue (or the typed unit price) and computes the totals itself (`computeOrderTotals`); the
  form's total is a preview only. Item rows snapshot name, SKU and price, so editing a product later never
  changes an old order.
- **Payments only add up to the total** (refused above what is due), conditional on the `paidMinor` that
  was read; `paymentStatus` is derived (`orderPaymentStatus`). "Refunded" is an explicit mark with a reason;
  the money itself is returned outside the app.
- **A lead becomes an order through "Create order"** (`/commerce/orders/new?lead=<id>`): creating the order
  closes the lead as WON with `wonOrderId`, in the same transaction. Lost needs a reason. A lead with an
  order cannot be deleted.
- Follow-up times are typed as Dhaka wall-clock time and stored as instants.
- Create / edit pages open only with the manage key (`requireAccess`); list and detail pages use
  `pageAccess(view, manage)` and are read-only without it.

## Not built yet (be honest about it)

- Courier booking and shop sync are built since (COMMERCE_INTEGRATIONS.md), but not verified with a live provider.
- AI commerce tools (product lookup, order status for a customer) — not built; the AI does not read these
  tables.
- No new automated tests were written for this package (by request). The pure rules in `commerce.ts`
  follow the patterns of `clientPayments`; the actions were typechecked and linted, not run against a
  database.
