import { assertConfig, type Config } from './config'
import { ApiError } from './errors'
import { discountFor, sum } from './money'

export type Product = { id: string; name: string; priceCents: number; inventory: number }
export type CartItem = { productId: string; quantity: number }
export type Cart = {
  id: string
  status: 'open' | 'checked_out'
  items: CartItem[]
  orderId?: string
  createdAt: string
}
export type CartLine = {
  productId: string
  name: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
  availableInventory: number
}
export type CartView = {
  id: string
  status: Cart['status']
  orderId?: string
  createdAt: string
  items: CartLine[]
  subtotalCents: number
  totalCents: number
}
export type OrderLine = {
  productId: string
  name: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
}
export type Order = {
  id: string
  cartId: string
  lines: OrderLine[]
  subtotalCents: number
  discountCents: number
  totalCents: number
  couponCode: string | null
  createdAt: string
}
export type Coupon = {
  code: string
  percentOff: number
  milestone: number
  status: 'available' | 'redeemed'
  orderId?: string
  createdAt: string
}
export type Report = {
  currency: 'USD'
  purchasedByProduct: Array<{ productId: string; name: string; quantity: number; grossRevenueCents: number }>
  grossRevenueCents: number
  totalDiscountsCents: number
  netRevenueCents: number
  coupons: { generated: number; available: number; redeemed: number }
  totalOrders: number
}

export const seedProducts: Product[] = [
  { id: 'p-espresso', name: 'Espresso Machine', priceCents: 24900, inventory: 10 },
  { id: 'p-grinder', name: 'Burr Grinder', priceCents: 8950, inventory: 25 },
  { id: 'p-beans', name: 'Coffee Beans 1kg', priceCents: 2499, inventory: 100 },
  { id: 'p-mug', name: 'Ceramic Mug', priceCents: 1200, inventory: 3 },
  { id: 'p-filters', name: 'Filter Papers', priceCents: 549, inventory: 200 },
]

const now = () => new Date().toISOString()

/**
 * In-memory domain store. Every mutating method is synchronous and has no `await`,
 * so in a single JS runtime a method runs to completion without interleaving.
 * That is what makes checkout, inventory and coupon updates atomic here.
 */
export class Store {
  readonly products = new Map<string, Product>()
  readonly carts = new Map<string, Cart>()
  readonly orders = new Map<string, Order>()
  readonly coupons = new Map<string, Coupon>()
  private readonly idempotency = new Map<string, { fingerprint: string; orderId: string }>()

  constructor(readonly config: Config) {
    assertConfig(config)
    for (const product of seedProducts) this.products.set(product.id, { ...product })
  }

  listProducts(): Product[] {
    return [...this.products.values()]
  }

  createCart(): Cart {
    const cart: Cart = { id: crypto.randomUUID(), status: 'open', items: [], createdAt: now() }
    this.carts.set(cart.id, cart)
    return cart
  }

  getCartView(cartId: string): CartView {
    const cart = this.requireCart(cartId)
    const items: CartLine[] = cart.items.map((item) => {
      const product = this.requireProduct(item.productId)
      return {
        productId: product.id,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: item.quantity,
        lineTotalCents: product.priceCents * item.quantity,
        availableInventory: product.inventory,
      }
    })
    const subtotalCents = sum(items.map((item) => item.lineTotalCents))
    return { ...cart, items, subtotalCents, totalCents: subtotalCents }
  }

  addItem(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.requireOpenCart(cartId)
    const product = this.requireProduct(productId)
    const existing = cart.items.find((item) => item.productId === productId)
    const nextQuantity = (existing?.quantity ?? 0) + quantity
    this.assertStock(product, nextQuantity)
    if (existing) existing.quantity = nextQuantity
    else cart.items.push({ productId, quantity })
    return this.getCartView(cartId)
  }

  setItemQuantity(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.requireOpenCart(cartId)
    const item = cart.items.find((entry) => entry.productId === productId)
    if (!item) throw new ApiError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in cart ${cartId}`)
    this.assertStock(this.requireProduct(productId), quantity)
    item.quantity = quantity
    return this.getCartView(cartId)
  }

  removeItem(cartId: string, productId: string): CartView {
    const cart = this.requireOpenCart(cartId)
    const next = cart.items.filter((item) => item.productId !== productId)
    if (next.length === cart.items.length) {
      throw new ApiError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in cart ${cartId}`)
    }
    cart.items = next
    return this.getCartView(cartId)
  }

  getOrder(orderId: string): Order {
    const order = this.orders.get(orderId)
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`)
    return order
  }

  /**
   * Validates, then commits inventory + order + coupon in one synchronous block.
   * A failure before the commit changes nothing; the commit itself cannot fail.
   */
  checkout(
    cartId: string,
    input: { couponCode?: string; idempotencyKey: string },
  ): { order: Order; replayed: boolean } {
    const cart = this.requireCart(cartId)
    const fingerprint = JSON.stringify({ cartId, couponCode: input.couponCode ?? null })

    const previous = this.idempotency.get(input.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request')
      }
      return { order: this.getOrder(previous.orderId), replayed: true }
    }

    this.requireOpenCart(cartId)
    if (cart.items.length === 0) throw new ApiError(422, 'EMPTY_CART', 'Cart has no items to check out')

    const lines: OrderLine[] = cart.items.map((item) => {
      const product = this.requireProduct(item.productId)
      this.assertStock(product, item.quantity)
      return {
        productId: product.id,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: item.quantity,
        lineTotalCents: product.priceCents * item.quantity,
      }
    })

    const coupon = input.couponCode ? this.requireAvailableCoupon(input.couponCode) : null

    const subtotalCents = sum(lines.map((line) => line.lineTotalCents))
    const discountCents = coupon ? discountFor(subtotalCents, coupon.percentOff) : 0
    const totalCents = subtotalCents - discountCents

    // Commit (no awaits below this point).
    for (const line of lines) {
      const product = this.products.get(line.productId)!
      product.inventory -= line.quantity
    }
    const order: Order = {
      id: crypto.randomUUID(),
      cartId,
      lines,
      subtotalCents,
      discountCents,
      totalCents,
      couponCode: coupon?.code ?? null,
      createdAt: now(),
    }
    this.orders.set(order.id, order)
    cart.status = 'checked_out'
    cart.orderId = order.id
    if (coupon) {
      coupon.status = 'redeemed'
      coupon.orderId = order.id
    }
    this.idempotency.set(input.idempotencyKey, { fingerprint, orderId: order.id })
    return { order, replayed: false }
  }

  /** Creates a coupon for the next unrewarded order milestone, if one is reached. */
  generateCoupon(): Coupon {
    const eligibleMilestone = Math.floor(this.orders.size / this.config.rewardEveryN)
    const generatedMilestone = Math.max(0, ...[...this.coupons.values()].map((coupon) => coupon.milestone))
    if (generatedMilestone >= eligibleMilestone) {
      throw new ApiError(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached', {
        totalOrders: this.orders.size,
        ordersRequiredForNextCoupon: (generatedMilestone + 1) * this.config.rewardEveryN,
      })
    }
    const milestone = generatedMilestone + 1
    const coupon: Coupon = {
      code: `REWARD-${this.config.rewardPercentX}-M${milestone}`,
      percentOff: this.config.rewardPercentX,
      milestone,
      status: 'available',
      createdAt: now(),
    }
    this.coupons.set(coupon.code, coupon)
    return coupon
  }

  /** Read-only. Repeated calls always return the same values until the domain changes. */
  report(): Report {
    const byProduct = new Map<string, Report['purchasedByProduct'][number]>()
    let grossRevenueCents = 0
    let totalDiscountsCents = 0
    let netRevenueCents = 0

    for (const order of this.orders.values()) {
      grossRevenueCents += order.subtotalCents
      totalDiscountsCents += order.discountCents
      netRevenueCents += order.totalCents
      for (const line of order.lines) {
        const row = byProduct.get(line.productId) ?? {
          productId: line.productId,
          name: line.name,
          quantity: 0,
          grossRevenueCents: 0,
        }
        row.quantity += line.quantity
        row.grossRevenueCents += line.lineTotalCents
        byProduct.set(line.productId, row)
      }
    }

    const coupons = [...this.coupons.values()]
    return {
      currency: 'USD',
      purchasedByProduct: [...byProduct.values()],
      grossRevenueCents,
      totalDiscountsCents,
      netRevenueCents,
      coupons: {
        generated: coupons.length,
        available: coupons.filter((coupon) => coupon.status === 'available').length,
        redeemed: coupons.filter((coupon) => coupon.status === 'redeemed').length,
      },
      totalOrders: this.orders.size,
    }
  }

  private requireProduct(productId: string): Product {
    const product = this.products.get(productId)
    if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`)
    return product
  }

  private requireCart(cartId: string): Cart {
    const cart = this.carts.get(cartId)
    if (!cart) throw new ApiError(404, 'CART_NOT_FOUND', `Cart ${cartId} not found`)
    return cart
  }

  private requireOpenCart(cartId: string): Cart {
    const cart = this.requireCart(cartId)
    if (cart.status !== 'open') {
      throw new ApiError(409, 'CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out', {
        orderId: cart.orderId,
      })
    }
    return cart
  }

  private requireAvailableCoupon(code: string): Coupon {
    const coupon = this.coupons.get(code)
    if (!coupon) throw new ApiError(404, 'COUPON_NOT_FOUND', `Coupon ${code} not found`)
    if (coupon.status === 'redeemed') {
      throw new ApiError(409, 'COUPON_ALREADY_REDEEMED', `Coupon ${code} has already been redeemed`)
    }
    return coupon
  }

  private assertStock(product: Product, quantity: number): void {
    if (quantity > product.inventory) {
      throw new ApiError(409, 'INSUFFICIENT_INVENTORY', `Only ${product.inventory} of ${product.name} available`, {
        productId: product.id,
        requested: quantity,
        available: product.inventory,
      })
    }
  }
}
