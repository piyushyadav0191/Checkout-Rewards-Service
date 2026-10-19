import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { swaggerUI } from '@hono/swagger-ui'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { defaultConfig, type Config } from './config'
import { ApiError } from './errors'
import { openapi } from './openapi'
import { addItemSchema, checkoutSchema, setQuantitySchema } from './schemas'
import { Store } from './store'

/** Validates a JSON body with zod and throws a typed ApiError on failure. */
const json = <T extends z.ZodType>(schema: T) =>
  validator('json', (value): z.infer<T> => {
    const parsed = schema.safeParse(value ?? {})
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Invalid request body',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      )
    }
    return parsed.data
  })

export function createApp(config: Config = defaultConfig, options: { log?: boolean } = {}) {
  const store = new Store(config)
  const app = new Hono()

  app.use('*', cors())
  if (options.log) app.use('*', logger())

  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/products', (c) => c.json({ products: store.listProducts() }))

  // API documentation: raw spec + interactive Swagger UI.
  app.get('/openapi.json', (c) => c.json(openapi))
  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  app.post('/carts', (c) => {
    const cart = store.createCart()
    return c.json({ cart: store.getCartView(cart.id) }, 201)
  })
  app.get('/carts/:cartId', (c) => c.json({ cart: store.getCartView(c.req.param('cartId')) }))

  app.post('/carts/:cartId/items', json(addItemSchema), (c) => {
    const { productId, quantity } = c.req.valid('json')
    return c.json({ cart: store.addItem(c.req.param('cartId'), productId, quantity) })
  })

  app.patch('/carts/:cartId/items/:productId', json(setQuantitySchema), (c) => {
    const { quantity } = c.req.valid('json')
    return c.json({ cart: store.setItemQuantity(c.req.param('cartId'), c.req.param('productId'), quantity) })
  })

  app.delete('/carts/:cartId/items/:productId', (c) =>
    c.json({ cart: store.removeItem(c.req.param('cartId'), c.req.param('productId')) }),
  )

  app.post('/carts/:cartId/checkout', json(checkoutSchema), (c) => {
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
    if (!idempotencyKey) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for checkout')
    }
    const { couponCode } = c.req.valid('json')
    const { order, replayed } = store.checkout(c.req.param('cartId'), { couponCode, idempotencyKey })
    c.header('Idempotent-Replay', String(replayed))
    return c.json({ order }, replayed ? 200 : 201)
  })

  app.get('/orders/:orderId', (c) => c.json({ order: store.getOrder(c.req.param('orderId')) }))

  // Administrative operations (no auth in this exercise).
  app.post('/admin/coupons', (c) => c.json({ coupon: store.generateCoupon() }, 201))
  app.get('/admin/report', (c) => c.json(store.report()))

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} not found` } }, 404),
  )

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status)
    }
    console.error(err)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } }, 500)
  })

  return app
}
