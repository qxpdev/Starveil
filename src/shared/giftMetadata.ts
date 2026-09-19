import type { GiftCatalogType, GiftMetadata } from './types'

export interface GiftReference {
  giftId?: string
  fallbackGiftId?: string
  giftCatalogType?: GiftCatalogType
}

/** 保持旧礼物键兼容；道具使用独立命名空间，避免同号礼物互相覆盖。 */
export function giftCatalogKey(id: string, type?: GiftCatalogType): string {
  return type === 'prop' ? `prop:${id}` : id
}

/** 合并官方来源时保留投入价格与奖池关系，奖励计价字段仍保持为空。 */
export function mergeGiftMetadata(previous: GiftMetadata | undefined, item: GiftMetadata): GiftMetadata {
  const isLottery = item.isLottery === true || previous?.isLottery === true
  const priceYuan = isLottery ? null : item.priceYuan ?? previous?.priceYuan ?? null
  return {
    ...previous, ...item,
    name: item.name || previous?.name || '',
    image: item.image || previous?.image || '',
    staticImage: item.staticImage || previous?.staticImage,
    effects: item.effects ?? previous?.effects,
    priceYuan,
    isFree: !isLottery && (priceYuan === 0 || item.isFree),
    isLottery,
    ...(isLottery ? {
      lotteryPriceYuan: item.lotteryPriceYuan ?? (item.isLottery ? null : item.priceYuan) ??
        previous?.lotteryPriceYuan ?? (previous?.isLottery ? null : previous?.priceYuan) ?? null,
      lotteryRewardIds: item.lotteryRewardIds ?? previous?.lotteryRewardIds
    } : {})
  }
}

export function resolveGiftMetadata(
  gift: GiftReference,
  catalog: ReadonlyMap<string, GiftMetadata>
): GiftMetadata | undefined {
  const primary = gift.giftId ? catalog.get(giftCatalogKey(gift.giftId, gift.giftCatalogType)) : undefined
  // 已提供 gpf 的广播遵循官方网页的取价规则，不跨礼物/道具目录回退。
  if (gift.giftCatalogType) return primary
  const fallback = gift.fallbackGiftId ? catalog.get(gift.fallbackGiftId) : undefined
  const priced = [primary, fallback].filter(item => item && (item.priceYuan != null || item.isFree || item.isLottery))
  return priced.find(item => item?.priceSource !== 'manual') || priced[0] || primary || fallback
}
