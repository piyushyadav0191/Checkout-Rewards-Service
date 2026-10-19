# DECISIONS

This document records the invariants I protected, the ambiguities I resolved, the material
design decisions behind the implementation, and what I deliberately left out.


**Stack:** Hono on Cloudflare Workers, TypeScript, Zod for input validation, OpenAPI for Documentation, Vitest for tests.
The domain store is in-memory and re-seeded on boot, as the brief permits.

---

## System invariants

These are the properties the service must never violate. Each is enforced in `src/store.ts`
unless noted.

1. **Inventory never goes negative.** Quantities are checked before the commit and decremented
   inside it. (`checkout` → `assertStock` + decrement loop.)
2. **A cart is checked out at most once.** `cart.status` flips to `checked_out` in the commit;
   later checkouts are rejected unless they replay the same idempotency key.
3. **A successful checkout creates exactly one order and decrements inventory exactly once.**
   The idempotency record is written in the same synchronous block as the order.
4. **A coupon is redeemed at most once.** Redeemed status is set inside the commit; a second
   checkout cannot observe it as available.
5. **A failed checkout consumes nothing.** All validation happens before the commit, and the
   commit contains no failure path, so a coupon cannot be "burned" by a rejected request.
6. **Money is exact.** All amounts are integer cents; totals are `subtotal - discount`.
7. **An order is a self-contained snapshot.** Lines store product name, unit price, and line
   total at checkout time, so later product changes do not rewrite history.
8. **Reporting is read-only and reconciles.** `gross - discounts = net`, and purchased
   quantities equal the sum of order lines.

---

## Ambiguities and the semantics I chose

| Ambiguity | Chosen semantics |
| --------- | ---------------- |
| When is a coupon created? | On the **admin's request**, for the next unrewarded order milestone. Reaching a milestone makes a coupon *eligible*, not automatically issued. |
| Milestone definition with n | Milestone `k` is reached at `k * n` successful orders. One coupon exists per milestone. If several milestones were reached but never generated, each admin call issues the next one. |
| Which price applies at checkout? | The **current** product price at the moment of checkout. The cart view always shows current prices too. Orders freeze that price. |
| What if stock drops after adding to cart? | Checkout re-validates and fails with `INSUFFICIENT_INVENTORY`. Nothing is partially reserved. |
| Coupon at checkout | Optional `couponCode`; its percentage is snapshotted onto the order (`discountCents`). |
| Retry without an idempotency key | Rejected with `400 IDEMPOTENCY_KEY_REQUIRED`. Retry safety is an explicit client contract, not a guess. |
| Same key, different body | `409 IDEMPOTENCY_KEY_REUSED` (protects against client bugs). |
| Coupon code format | Deterministic `REWARD-<x>-M<milestone>` — human-readable and naturally unique per milestone. Not a security token (no auth here). |
| Currency | USD; every amount is `*Cents`. |
| Rounding | Percentage discount is **floored** to whole cents and capped at the subtotal. |

---

## Decision: Represent money as integer cents

**Context:** "Calculate money without floating-point rounding errors." Prices like $24.99
cannot be represented exactly as binary floats; summing them drifts.

**Options considered:** (a) floats with a rounding helper at the edges; (b) a decimal library;
(c) integer cents.

**Choice:** All internal and API money values are integer cents (`priceCents`, `totalCents`).

**Why:** Integers are exact, trivial to test, and need no dependency. A decimal library adds a
dependency and still needs explicit rounding rules.

**Consequences:** Callers must send/read cents. Currency formatting is a presentation concern
left to clients. Percentage math still needs a rounding rule, which led to the next decision.

---

## Decision: Floor percentage discounts and cap them at the subtotal

**Context:** 10% of 2499 cents is 249.9 cents. Deterministic output is required, and a total
must never go negative.

**Options considered:** (a) round half-up; (b) floor; (c) banker's rounding; (d) store
discounts as basis points.

**Choice:** `min(floor(subtotal * percent / 100), subtotal)`.

**Why:** Floor is simple, deterministic, and slightly favours the store, which is the common
coupon convention. Capping at the subtotal guarantees `total = subtotal - discount >= 0` even
at `x = 100`.

**Consequences:** A few sub-cent fractions are retained by the store. The rule lives in one
function (`discountFor`) and is directly unit-tested through the coupon tests.

---

## Decision: Idempotent checkout keyed by `Idempotency-Key`, backed by cart state

**Context:** Clients retry a checkout after a timeout. A retry must not create a second order
or decrement inventory twice.

**Options considered:** (a) trust cart status only — a retry returns whatever order the cart
points to; (b) require an `Idempotency-Key` and store the request→response mapping;
(c) a request hash of the body without a key.

**Choice:** Require `Idempotency-Key`. Store `key → { fingerprint(cartId, couponCode), orderId }`.
Replay with the same fingerprint returns the original order (`200`); a different fingerprint is
`409`. Without the key, checkout is `400`.

**Why:** Option (a) can't distinguish "retry of the same intent" from "a client trying a second
checkout with a different coupon", and it silently ignores a coupon mismatch. A key is the
industry-standard, explicit contract (Stripe-style). Cart status is still a second safety net.

**Consequences:** Clients must generate keys, which is a small but real API obligation. Keys are
currently global (one namespace); the fingerprint prevents cross-cart misuse. A production store
would index keys per cart/account and expire them.

---

## Decision: In-memory store with a synchronous, single-step commit

**Context:** The brief allows in-memory persistence only if the design still shows how
invariants hold when requests overlap. Node/Workers run one JS thread per isolate, so code
without `await` cannot interleave.

**Options considered:** (a) in-memory `Map`s plus an async mutex/queue; (b) Durable Object as a
serialized actor; (c) in-memory with all mutations expressed as one synchronous critical section.

**Choice:** (c). Every mutating store method is fully synchronous — validate, then commit with
no `await`. The commit block (inventory decrement, order write, coupon redemption, idempotency
write, cart status) runs to completion before any other request can run.

**Why:** Within an isolate this gives real atomicity with no lock code, no dependency, and no
risk of deadlock. An explicit mutex would only matter for work that must `await` mid-operation
(e.g. a database), which this version doesn't do.

**Consequences:** This is atomic **per isolate**. Cloudflare can run several isolates, and a
restart loses state. That is the documented limitation, and it is why the next section matters.
Concurrent-request tests (`Promise.all`) exercise the guarantee.

---

## Decision: Coupons are admin-generated, one per milestone, single-use

**Context:** The rules say a coupon becomes available every n orders, an admin can request
generation, only one coupon per milestone, and redemption must be exactly once.

**Options considered:** (a) auto-issue a coupon the instant an order crosses a milestone;
(b) admin-triggered generation; (c) a batch job.

**Choice:** (b). `POST /admin/coupons` computes `eligibleMilestone = floor(totalOrders / n)` and
`generatedMilestone = max(existing coupon milestones, 0)`. If `generated < eligible` it issues
`REWARD-<x>-M<generated+1>`; otherwise `409 NO_ELIGIBLE_MILESTONE`.

**Why:** The brief explicitly separates "milestone reached" from "coupon generated" and gives the
admin a generation endpoint, implying issuance is an operator action. The max-milestone check
makes generation idempotent per milestone without a separate ledger.

**Consequences:** A coupon does not appear automatically; an operator must call the endpoint. A
milestone's coupon is derived, so its code is predictable. With concurrent admin calls, the
synchronous commit ensures only one coupon per milestone exists.

---

## Decision: Successful checkout *is* payment success

**Context:** The brief says no real payment integration is required, or a fake abstraction may
be used if it helps.

**Options considered:** (a) introduce a payment port with a fake provider; (b) treat checkout
success as paid; (c) call an external sandbox.

**Choice:** (b). The order is created only after all validation passes; there is no separate
"authorize then capture" window.

**Why:** A fake payment step would add a failure mode (`await` mid-transaction) and buy nothing
in this exercise. Keeping checkout synchronous is precisely what makes the commit atomic.

**Consequences:** The implementation doesn't model refunds, partial captures, or gateway
timeouts. If a real gateway were added, payment would move *before* the commit (reserve, then
commit) — see the production evolution below.

---

## Decision: One error envelope with stable codes

**Context:** "Return errors that are distinguishable and useful to an API client."

**Options considered:** (a) plain status codes with text; (b) RFC 7807 problem+json;
(c) `{ error: { code, message, details } }` with a domain `ApiError` class.

**Choice:** (c). Every failure throws `ApiError(status, code, message, details?)`; a single
`app.onError` serializes it. Validation failures and unexpected errors follow the same shape.

**Why:** A machine-readable `code` lets clients branch without parsing messages, and `details`
carries actionable context (`available`, `ordersRequiredForNextCoupon`). It is lighter than full
problem+json while keeping the same idea.

**Consequences:** Codes are effectively API contract and must stay stable. `INTERNAL_ERROR`
hides internals (logged server-side) rather than leaking stack traces.

---

## What I implemented vs intentionally deferred

**Implemented**

- Seeded products (one with limited inventory) and product listing.
- Cart create/get/add/update/remove with stock-aware validation and price/total output.
- Checkout with idempotency, cart single-use, oversell protection, exact money.
- Immutable order snapshots and order retrieval.
- Milestone coupons: admin generation, single redemption, safe on failure.
- Admin report (quantities, gross, discounts, net, coupon counts, order count).
- OpenAPI 3.1 document (`/openapi.json`) and Swagger UI (`/docs`), generated from the shared
  Zod schemas, with a test that fails if a route is undocumented.
- Focused tests including competing/repeated operations.
- Consistent typed error model, CORS, request logging in dev.

**Deferred (with reasons)**

- **Real persistence** — in-memory only, so state resets on restart and is per-isolate.
- **Multi-instance correctness** — requires D1/Durable Object/Postgres transactions (below).
- **Auth/authz** — `/admin/*` is documented as administrative but not protected.
- **Product/price admin endpoints** — prices are seed data; not needed to demonstrate the rules.
- **Cart expiry, quantity limits beyond stock, rate limiting, pagination.**
- **Coupon expiry, per-customer limits, partial/full refunds.**
- **Observability beyond dev logging** (no metrics/tracing).

---

## How this evolves for multiple instances and production scale

The in-memory store is the only piece that is not production-shaped. Everything else (API,
idempotency contract, error model, money rules) stays.

1. **Single serialized writer per aggregate.** Put the store in a **Durable Object** (one per
   store, or sharded by product/region). A DO gives the same single-threaded, no-interleave
   guarantee the in-memory store relies on, but with durable storage and cross-instance routing.
2. **Relational alternative.** In Postgres, wrap checkout in one transaction:
   `SELECT ... FOR UPDATE` on the ordered products, verify stock, insert the order and lines,
   update `coupons SET status='redeemed' WHERE code=$1 AND status='available'` (check row count),
   insert the idempotency row with a unique constraint on the key. Exactly the same invariants,
   enforced by the database instead of by a single JS thread.
3. **Idempotency store.** Store keys with the response body, scoped to the caller/cart, with a
   TTL. A unique index on the key makes replays safe even across instances.
4. **Inventory model.** For high contention, add a reservation/ledger (append-only stock
   movements) instead of a mutable counter, and reconcile reservations with timeouts.
5. **Payments.** Introduce an `await`ed authorize step *before* the commit; the commit then only
   writes durable state, so a gateway timeout never half-applies an order.
6. **Ops.** Metrics for failed checkouts by code, coupon redemption rate, and inventory alerts;
   structured logs with request and idempotency keys.

---
