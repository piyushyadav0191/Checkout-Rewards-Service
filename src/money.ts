/** All money is stored and computed as integer cents, so there is no floating-point drift. */
export const sum = (amounts: number[]): number => amounts.reduce((total, amount) => total + amount, 0)

/**
 * Percentage discount rounded down to whole cents, capped at the amount.
 * Floor keeps the rule deterministic and never lets a discount exceed the subtotal.
 */
export const discountFor = (amountCents: number, percent: number): number =>
  Math.min(Math.floor((amountCents * percent) / 100), amountCents)
