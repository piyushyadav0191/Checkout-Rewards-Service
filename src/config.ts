/** Reward rules: every `rewardEveryN` successful orders makes one coupon for `rewardPercentX`% off. */
export type Config = {
  rewardEveryN: number
  rewardPercentX: number
}

export const defaultConfig: Config = { rewardEveryN: 5, rewardPercentX: 10 }

export function assertConfig(config: Config): Config {
  const { rewardEveryN, rewardPercentX } = config
  if (!Number.isInteger(rewardEveryN) || rewardEveryN < 1) {
    throw new Error('rewardEveryN must be a positive integer')
  }
  if (!Number.isInteger(rewardPercentX) || rewardPercentX < 1 || rewardPercentX > 100) {
    throw new Error('rewardPercentX must be an integer between 1 and 100')
  }
  return config
}
