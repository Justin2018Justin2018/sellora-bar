# Billing & reporting rules (single source of truth: `report()`, `kegReport()` and `snapshot()` in api/index.js)

## Booking lifecycle (operational status) — separate from payment status
reserved --check-in--> in --check-out--> out        reserved --cancel--> cancelled

| Event | Ledger effect |
|---|---|
| Reserve | none |
| Deposit / payment on a booking | `payments` row (ref_type='booking'), +amount. Held as **customer deposit** until charges exist |
| Bar/restaurant order "post to room" | `charges` row kind='sale' (unique per sale: cannot be billed twice). Revenue was recognised on the sale, NOT again at payment |
| Check-out | `charges` row kind='room' (unique per booking): nights x rate. **Lodging revenue is recognised here** |
| Void of a room-posted sale | `charges` row kind='reversal' (negative) |
| Cancel booking | deposits refunded as negative `payments` (kind='refund'); booking excluded from every total |
| Folio payment after check-out | `payments` row; reduces receivable only |

## Derived amounts (never stored, always computed)
* folio charges   = SUM(charges.amount)            (room + posted sales + reversals)
* folio paid      = SUM(payments.amount)           (payments positive, refunds negative)
* folio balance   = charges - paid
* payment status  = `unpaid` (paid<=0 and charges>0) | `partial` | `paid` (balance=0) | `credit` (paid>charges, i.e. deposit held)

## What counts as OUTSTANDING (receivable)
1. Sales with pay_mode `open` or `credit`, status `active`: total - net payments.
2. Bookings with status `in` or `out` and balance > 0: charges - paid. (In-house guests: only charges posted so far; room nights post at check-out.)
3. NOT counted: cancelled/void sales, cancelled bookings, reserved bookings (no charges), fully paid bookings, room-posted sales (they live in the folio, item 2), balances <= 0.
Deposits (paid > charges on reserved/in bookings) are reported separately as **deposits held**, never netted against receivables silently.

Check-out with an unpaid balance is refused unless a user with the `approve` permission passes `allowDebt` (the balance then stays a receivable and is audited).

## Revenue / profit definitions
* Revenue = active sales (bar+restaurant, by sale date) + room charges (by check-out date). Void/cancelled sales excluded. Payments are never revenue.
* COGS = sum(sale_items.qty x cost snapshot taken at sale time) of active sales. Lodging has no COGS.
* Gross profit = revenue - COGS.  Net profit = gross profit - expenses in the period.
* Cash received = payments by method, net of refunds. Stock valuation = sum(stock x moving-average cost).
* Business day = calendar day in TZ_OFFSET_HOURS (default +3, East Africa Time).
* Money is stored as integer cents; quantities as REAL.

## Keg / litre sales
* A keg is ONE stock item counted in litres (`unit='L'`, `pack_size` = capacity, `pack_cost_c` = keg price). Cost per litre = keg price / capacity, then a moving average when more kegs are received at other prices.
* Glass / jug are ordinary bar items with a recipe: one serving draws `ml/1000` litres from the keg. Selling price never affects the litres deducted.
* Serving cost = litres x current cost per litre, snapshotted on each sale line, so gross profit = revenue - cost of the litres actually sold. Later price or cost changes do not rewrite history.
* A serving may carry `price_opts` (e.g. jug 210 or 250): only an administrator can change its price, and only to one of the choices. Changes go to the price log.
* Stock can never go below zero (checked by the API and by a database constraint). A sale needing more litres than remain is refused as a whole.
* Void/refund returns the exact litres (ledger rows, never edits) and reverses the payment. Keg reconciliation: received - sold (net of voids) + adjustments = remaining.

## Other definitions added in the audit
* A refund is cash leaving the drawer of the person at the till (the requester), even when a manager approved it; the approver is the audited actor.
* Guest credit (deposit or reversed charge above the bill) is paid back after check-out with `POST /api/room/refund` (needs the `approve` permission).
