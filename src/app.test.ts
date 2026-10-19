import { describe, expect, it } from 'vitest'
import { createApp } from './app'

type App = ReturnType<typeof createApp>

async function api(
  app: App,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function createCart(app: App): Promise<string> {
  return (await api(app, 'POST', '/carts')).body.cart.id
}

const addItem = (app: App, cartId: string, productId: string, quantity: number) =>
  api(app, 'POST', `/carts/${cartId}/items`, { body: { productId, quantity } })

const checkout = (app: App, cartId: string, idempotencyKey: string, couponCode?: string) =>
  api(app, 'POST', `/carts/${cartId}/checkout`, {
    body: couponCode ? { couponCode } : {},
    headers: { 'Idempotency-Key': idempotencyKey },
  })

const findProduct = (body: any, id: string) => body.products.find((p: any) => p.id === id)

describe('carts', () => {
  it('rejects invalid products and quantities without mutating the cart', async () => {
    const app = createApp()
    const cart = await createCart(app)

    expect((await addItem(app, cart, 'nope', 1)).status).toBe(404)
    expect((await addItem(app, cart, 'p-mug', 0)).status).toBe(400)
    expect((await addItem(app, cart, 'p-mug', 4)).status).toBe(409) // only 3 in stock
    expect((await api(app, 'GET', '/carts/missing')).status).toBe(404)

    const view = await api(app, 'GET', `/carts/${cart}`)
    expect(view.body.cart.items).toEqual([])
    expect(view.body.cart.totalCents).toBe(0)
  })
})

describe('checkout', () => {
  it('does not oversell limited inventory when two checkouts race', async () => {
    const app = createApp()
    const carts = await Promise.all(
      [0, 1].map(async () => {
        const id = await createCart(app)
        await addItem(app, id, 'p-mug', 3) // p-mug has exactly 3 in stock
        return id
      }),
    )

    const results = await Promise.all(carts.map((id, i) => checkout(app, id, `key-${i}`)))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('INSUFFICIENT_INVENTORY')

    expect(findProduct((await api(app, 'GET', '/products')).body, 'p-mug').inventory).toBe(0)
    expect((await api(app, 'GET', '/admin/report')).body.totalOrders).toBe(1)
  })

  it('collapses retries into one order and charges inventory once', async () => {
    const app = createApp()
    const cart = await createCart(app)
    await addItem(app, cart, 'p-beans', 2)

    const first = await checkout(app, cart, 'retry-1')
    const second = await checkout(app, cart, 'retry-1')
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.order.id).toBe(first.body.order.id)
    expect(findProduct((await api(app, 'GET', '/products')).body, 'p-beans').inventory).toBe(98)

    // a different key against a checked-out cart is a conflict, not a second order
    const conflict = await checkout(app, cart, 'retry-2')
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('CART_ALREADY_CHECKED_OUT')

    // concurrent retries of the same key also collapse to one order
    const cart2 = await createCart(app)
    await addItem(app, cart2, 'p-filters', 5)
    const [a, b] = await Promise.all([checkout(app, cart2, 'retry-3'), checkout(app, cart2, 'retry-3')])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(a.body.order.id).toBe(b.body.order.id)
    expect(findProduct((await api(app, 'GET', '/products')).body, 'p-filters').inventory).toBe(195)
  })
})

describe('rewards', () => {
  const buy = async (app: App, productId: string, quantity: number, key: string, couponCode?: string) => {
    const cart = await createCart(app)
    await addItem(app, cart, productId, quantity)
    return checkout(app, cart, key, couponCode)
  }

  it('makes one coupon per milestone and lets only one racing checkout redeem it', async () => {
    const app = createApp({ rewardEveryN: 2, rewardPercentX: 10 })
    await buy(app, 'p-filters', 1, 'm-0')
    await buy(app, 'p-filters', 1, 'm-1')

    const generated = await api(app, 'POST', '/admin/coupons')
    expect(generated.status).toBe(201)
    const code = generated.body.coupon.code
    expect((await api(app, 'POST', '/admin/coupons')).status).toBe(409)

    const carts = await Promise.all(
      [0, 1].map(async () => {
        const id = await createCart(app)
        await addItem(app, id, 'p-beans', 1)
        return id
      }),
    )
    const results = await Promise.all(carts.map((id, i) => checkout(app, id, `race-${i}`, code)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('COUPON_ALREADY_REDEEMED')

    // p-beans = 2499 cents, 10% floored = 249, total 2250
    const winner = results.find((r) => r.status === 201)!.body.order
    expect(winner).toMatchObject({ subtotalCents: 2499, discountCents: 249, totalCents: 2250 })
    expect((await api(app, 'GET', '/admin/report')).body.coupons).toEqual({
      generated: 1,
      available: 0,
      redeemed: 1,
    })
  })

  it('keeps a coupon available when checkout fails and never makes a total negative', async () => {
    const app = createApp({ rewardEveryN: 1, rewardPercentX: 100 })
    await buy(app, 'p-mug', 1, 'a')
    const code = (await api(app, 'POST', '/admin/coupons')).body.coupon.code

    const failed = await checkout(app, await createCart(app), 'b', code)
    expect(failed.status).toBe(422)
    expect(failed.body.error.code).toBe('EMPTY_CART')
    expect((await api(app, 'GET', '/admin/report')).body.coupons.available).toBe(1)

    const order = (await buy(app, 'p-espresso', 1, 'c', code)).body.order
    expect(order.discountCents).toBe(24900)
    expect(order.totalCents).toBe(0)
  })
})

describe('reporting', () => {
  it('reconciles with orders and coupons and does not mutate state', async () => {
    const app = createApp({ rewardEveryN: 1, rewardPercentX: 10 })
    const cart = await createCart(app)
    await addItem(app, cart, 'p-espresso', 1)
    await addItem(app, cart, 'p-beans', 2)
    const order = (await checkout(app, cart, 'r-1')).body.order

    await api(app, 'POST', '/admin/coupons')
    const couponCart = await createCart(app)
    await addItem(app, couponCart, 'p-grinder', 1)
    const couponOrder = (await checkout(app, couponCart, 'r-2', 'REWARD-10-M1')).body.order

    const [first, second] = await Promise.all([
      api(app, 'GET', '/admin/report'),
      api(app, 'GET', '/admin/report'),
    ])
    expect(second.body).toEqual(first.body)
    expect(first.body.totalOrders).toBe(2)
    expect(first.body.grossRevenueCents).toBe(order.subtotalCents + couponOrder.subtotalCents)
    expect(first.body.totalDiscountsCents).toBe(couponOrder.discountCents)
    expect(first.body.netRevenueCents).toBe(
      first.body.grossRevenueCents - first.body.totalDiscountsCents,
    )
    expect(second.body.purchasedByProduct).toContainEqual(
      expect.objectContaining({ productId: 'p-beans', quantity: 2 }),
    )
  })
})
