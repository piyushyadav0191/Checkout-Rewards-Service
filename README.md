# Checkout & Rewards Service

A small, reliable ecommerce backend built with **Hono** on **Cloudflare Workers**.
It handles carts, checkout with idempotent retries, inventory that cannot oversell,
one-time discount coupons earned every *n* orders, and an admin report.

Money is stored as **integer cents** everywhere.

## Run it

```bash
bun install          # or npm install
bun run dev          # wrangler dev -> http://localhost:8787
bun run test         # vitest (includes concurrent-request tests)
bun run type-check   # tsc --noEmit
```

No database or credentials are required: the service uses an in-memory store that is
re-seeded on every start.

## Configuration

Reward rules live in `src/config.ts`:

```ts
export const defaultConfig = { rewardEveryN: 5, rewardPercentX: 10 }
```

`rewardEveryN = 5` means every 5th successfully placed order makes one 10% coupon
available. Tests create apps with custom values (e.g. `createApp({ rewardEveryN: 2, rewardPercentX: 10 })`).

## Seed products

| id            | name              | price  | inventory |
| ------------- | ----------------- | ------ | --------- |
| `p-espresso`  | Espresso Machine  | $249.00 | 10       |
| `p-grinder`   | Burr Grinder      | $89.50  | 25       |
| `p-beans`     | Coffee Beans 1kg  | $24.99  | 100      |
| `p-mug`       | Ceramic Mug       | $12.00  | **3** (limited) |
| `p-filters`   | Filter Papers     | $5.49   | 200      |

## API

All bodies are JSON. Errors use this shape:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "...", "details": { } } }
```

| Method | Path | Admin | Success | Notes |
| ------ | ---- | ----- | ------- | ----- |
| `GET`    | `/health` | no | `200 { ok: true }` | |
| `GET`    | `/products` | no | `200 { products }` | current price and inventory |
| `POST`   | `/carts` | no | `201 { cart }` | create an empty cart |
| `GET`    | `/carts/:cartId` | no | `200 { cart }` | prices + `subtotalCents` / `totalCents` |
| `POST`   | `/carts/:cartId/items` | no | `200 { cart }` | body `{ productId, quantity }`, adds or increments |
| `PATCH`  | `/carts/:cartId/items/:productId` | no | `200 { cart }` | body `{ quantity }`, sets absolute quantity |
| `DELETE` | `/carts/:cartId/items/:productId` | no | `200 { cart }` | |
| `POST`   | `/carts/:cartId/checkout` | no | `201 { order }` | body `{ couponCode? }`, **requires `Idempotency-Key`** header |
| `GET`    | `/orders/:orderId` | no | `200 { order }` | immutable snapshot of the purchase |
| `POST`   | `/admin/coupons` | **yes** | `201 { coupon }` | generate a coupon for the next unrewarded milestone |
| `GET`    | `/admin/report` | **yes** | `200 { report }` | read-only totals |

Administrative operations are anything under `/admin`. Authentication is intentionally
out of scope for this exercise (see `DECISIONS.md`).

### Error codes

| Code | Status | Meaning |
| ---- | ------ | ------- |
| `VALIDATION_ERROR` | 400 | body failed schema validation (`details` lists fields) |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | checkout called without the header |
| `CART_NOT_FOUND` / `PRODUCT_NOT_FOUND` / `ORDER_NOT_FOUND` / `COUPON_NOT_FOUND` | 404 | unknown id |
| `ITEM_NOT_IN_CART` | 404 | item not present when updating/removing |
| `INSUFFICIENT_INVENTORY` | 409 | requested quantity exceeds stock (`details.available`) |
| `CART_ALREADY_CHECKED_OUT` | 409 | cart submitted again with a different idempotency key |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key sent with a different payload |
| `COUPON_ALREADY_REDEEMED` | 409 | coupon was already used |
| `NO_ELIGIBLE_MILESTONE` | 409 | no unrewarded milestone reached (`details.ordersRequiredForNextCoupon`) |
| `EMPTY_CART` | 422 | checkout attempted on a cart with no items |
| `INTERNAL_ERROR` | 500 | unexpected failure |

### Example flow

```bash
# 1. create a cart and add items
CART=$(curl -s -X POST localhost:8787/carts | jq -r .cart.id)
curl -s -X POST localhost:8787/carts/$CART/items \
  -H 'content-type: application/json' -d '{"productId":"p-beans","quantity":2}'

# 2. checkout (safe to retry with the same key)
curl -s -X POST localhost:8787/carts/$CART/checkout \
  -H 'content-type: application/json' -H 'Idempotency-Key: order-123' -d '{}'

# 3. after enough orders, generate a coupon and use it
curl -s -X POST localhost:8787/admin/coupons
curl -s -X POST localhost:8787/carts/$CART2/checkout \
  -H 'content-type: application/json' -H 'Idempotency-Key: order-124' \
  -d '{"couponCode":"REWARD-10-M1"}'

# 4. report
curl -s localhost:8787/admin/report
```

## How reliability is handled (short version)

- **Idempotent checkout** — `Idempotency-Key` + cart state mean a retry returns the original
  order instead of creating a second one.
- **No oversell** — inventory is validated before a synchronous commit block; two racing
  checkouts for the last unit produce one `201` and one `409`.
- **Coupon safety** — coupons are validated before the commit and marked redeemed inside it,
  so a failed checkout leaves the coupon available and two checkouts cannot both redeem it.
- **Payment** — a successful checkout *is* payment success; no gateway is called.

Full reasoning, trade-offs and deferred work are in [`DECISIONS.md`](./DECISIONS.md).

## Tests

`src/app.test.ts` covers validation, concurrent oversell, retry idempotency (sequential and
concurrent), coupon milestone generation, concurrent coupon redemption, failed-checkout
coupon safety, rounding, and report reconciliation/read-only behavior.
