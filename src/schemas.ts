import { z } from 'zod'

/**
 * Request body schemas shared by validation (src/app.ts) and the OpenAPI document
 * (src/openapi.ts), so the docs and the runtime cannot drift apart.
 */

export const addItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive().max(1000),
})

export const setQuantitySchema = z.object({
  quantity: z.number().int().positive().max(1000),
})

export const checkoutSchema = z.object({
  couponCode: z.string().min(1).optional(),
})
