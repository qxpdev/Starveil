import type { DanmakuPayload } from './types'

export type GiftValueTier = 'pending' | 'free' | 'small' | 'medium' | 'large' | 'premium'

/** 使用本卡实际礼物/奖励总价值分级，抽奖投入金额不决定奖励背景。 */
export function giftValueTier(payload: DanmakuPayload): GiftValueTier {
  let value: number
  if (payload.lotterySummary) {
    const summary = payload.lotterySummary
    if (summary.rewardCount <= summary.unpricedRewardCount) return 'pending'
    value = summary.rewardValue
  } else {
    if (payload.giftIsFree || payload.giftPrice === 0) return 'free'
    if (payload.giftIsLottery || payload.giftPrice == null || !Number.isFinite(payload.giftPrice)) return 'pending'
    value = payload.giftPrice * (payload.giftCount ?? 1)
  }
  return value <= 0 ? 'free' : value < 10 ? 'small' : value < 100 ? 'medium' : value < 1000 ? 'large' : 'premium'
}
