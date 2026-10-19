import { z } from 'zod'
import { addItemSchema, checkoutSchema, setQuantitySchema } from './schemas'

/**
 * OpenAPI 3.1 document. Response schemas are declared with Zod and converted to
 * JSON Schema, so the document stays close to the domain types in src/store.ts.
 */

const jsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

const cents = z.number().int()

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: cents,
  inventory: z.number().int(),
})

export const cartSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'checked_out']),
  orderId: z.string().optional(),
  createdAt: z.string(),
  items: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      unitPriceCents: cents,
      quantity: z.number().int(),
      lineTotalCents: cents,
      availableInventory: z.number().int(),
    }),
  ),
  subtotalCents: cents,
  totalCents: cents,
})

export const orderSchema = z.object({
  id: z.string(),
  cartId: z.string(),
  lines: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      unitPriceCents: cents,
      quantity: z.number().int(),
      lineTotalCents: cents,
    }),
  ),
  subtotalCents: cents,
  discountCents: cents,
  totalCents: cents,
  couponCode: z.string().nullable(),
  createdAt: z.string(),
})

export const couponSchema = z.object({
  code: z.string(),
  percentOff: z.number().int(),
  milestone: z.number().int(),
  status: z.enum(['available', 'redeemed']),
  orderId: z.string().optional(),
  createdAt: z.string(),
})

export const reportSchema = z.object({
  currency: z.literal('USD'),
  purchasedByProduct: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      grossRevenueCents: cents,
    }),
  ),
  grossRevenueCents: cents,
  totalDiscountsCents: cents,
  netRevenueCents: cents,
  coupons: z.object({
    generated: z.number().int(),
    available: z.number().int(),
    redeemed: z.number().int(),
  }),
  totalOrders: z.number().int(),
})

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Record<string, unknown>) => ({ content: { 'application/json': { schema } } })
const ok = (name: string, description: string) => ({ description, ...json(ref(name)) })
const inline = (description: string, schema: Record<string, unknown>) => ({ description, ...json(schema) })
const failure = (description: string) => ({ description, ...json(ref('Error')) })
const pathParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
})
const body = (name: string) => ({ required: true, ...json(ref(name)) })
const commonErrors = {
  400: failure('Validation error or missing Idempotency-Key'),
  404: failure('Resource not found'),
  409: failure('Conflict (inventory, cart, coupon, or milestone)'),
}

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Checkout & Rewards API',
    version: '1.0.0',
    description:
      'Carts, idempotent checkout, inventory, milestone coupons and reporting. All money is integer cents (USD).',
  },
  tags: [
    { name: 'catalog' },
    { name: 'carts' },
    { name: 'orders' },
    { name: 'admin', description: 'Administrative operations (no auth in this exercise).' },
  ],
  components: {
    schemas: {
      Product: jsonSchema(productSchema),
      Cart: jsonSchema(cartSchema),
      Order: jsonSchema(orderSchema),
      Coupon: jsonSchema(couponSchema),
      Report: jsonSchema(reportSchema),
      Error: jsonSchema(errorSchema),
      AddItem: jsonSchema(addItemSchema),
      SetQuantity: jsonSchema(setQuantitySchema),
      Checkout: jsonSchema(checkoutSchema),
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['catalog'],
        summary: 'Health check',
        responses: {
          200: inline('Service is up', {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          }),
        },
      },
    },
    '/products': {
      get: {
        tags: ['catalog'],
        summary: 'List products with current price and inventory',
        responses: {
          200: inline('Product list', {
            type: 'object',
            properties: { products: { type: 'array', items: ref('Product') } },
          }),
        },
      },
    },
    '/carts': {
      post: {
        tags: ['carts'],
        summary: 'Create an empty cart',
        responses: { 201: ok('Cart', 'Cart created') },
      },
    },
    '/carts/{cartId}': {
      get: {
        tags: ['carts'],
        summary: 'View a cart with current prices and totals',
        parameters: [pathParam('cartId')],
        responses: { 200: ok('Cart', 'Cart'), 404: commonErrors[404] },
      },
    },
    '/carts/{cartId}/items': {
      post: {
        tags: ['carts'],
        summary: 'Add an item (or increase its quantity)',
        parameters: [pathParam('cartId')],
        requestBody: body('AddItem'),
        responses: { 200: ok('Cart', 'Updated cart'), ...commonErrors },
      },
    },
    '/carts/{cartId}/items/{productId}': {
      patch: {
        tags: ['carts'],
        summary: 'Set the absolute quantity of an item',
        parameters: [pathParam('cartId'), pathParam('productId')],
        requestBody: body('SetQuantity'),
        responses: { 200: ok('Cart', 'Updated cart'), ...commonErrors },
      },
      delete: {
        tags: ['carts'],
        summary: 'Remove an item',
        parameters: [pathParam('cartId'), pathParam('productId')],
        responses: { 200: ok('Cart', 'Updated cart'), 404: commonErrors[404], 409: commonErrors[409] },
      },
    },
    '/carts/{cartId}/checkout': {
      post: {
        tags: ['orders'],
        summary: 'Check out a cart (idempotent, optional coupon)',
        description:
          'Requires an Idempotency-Key header. A retry with the same key and body returns the original order with status 200.',
        parameters: [
          pathParam('cartId'),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: body('Checkout'),
        responses: {
          201: ok('Order', 'Order created'),
          200: ok('Order', 'Idempotent replay: the original order'),
          422: failure('Empty cart'),
          ...commonErrors,
        },
      },
    },
    '/orders/{orderId}': {
      get: {
        tags: ['orders'],
        summary: 'Retrieve an order snapshot',
        parameters: [pathParam('orderId')],
        responses: { 200: ok('Order', 'Order'), 404: commonErrors[404] },
      },
    },
    '/admin/coupons': {
      post: {
        tags: ['admin'],
        summary: 'Generate a coupon for the next unrewarded milestone',
        responses: {
          201: ok('Coupon', 'Coupon generated'),
          409: commonErrors[409],
        },
      },
    },
    '/admin/report': {
      get: {
        tags: ['admin'],
        summary: 'Read-only summary of sales and coupons',
        responses: { 200: ok('Report', 'Report') },
      },
    },
  },
}
