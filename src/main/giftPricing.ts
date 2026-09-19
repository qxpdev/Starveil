import type { GiftMetadata, GiftPricingItem } from '../shared/types'
import type { ManualGiftPrices } from '../shared/manualGiftPrices'
import type { GiftBucket } from './sessionStats'
import { resolveGiftMetadata, isKnownFreeGiftName } from '../douyu/roomInfo'
import { giftCatalogKey } from '../shared/giftMetadata'

export function withManualGiftPrices(platform: ReadonlyMap<string, GiftMetadata>, manual: ManualGiftPrices): Map<string, GiftMetadata> {
  const result = new Map(platform)
  for (const [key, price] of Object.entries(manual)) {
    const catalogType = key.startsWith('prop:') ? 'prop' : 'gift'
    const id = catalogType === 'prop' ? key.slice(5) : key
    const known = platform.get(key)
    if (known?.isFree || known?.isLottery || known?.priceYuan != null) continue
    const name = known?.name || price.name || `礼物 ${id}`
    result.set(key, { id, catalogType, name, image: known?.image || '', priceYuan: price.priceYuan,
      isFree: price.priceYuan === 0 || isKnownFreeGiftName(name), priceSource: 'manual' })
  }
  return result
}

export function listGiftPricing(
  catalog: ReadonlyMap<string, GiftMetadata>, manual: ManualGiftPrices, gifts: readonly GiftBucket[]
): GiftPricingItem[] {
  const items = new Map<string, GiftPricingItem>()
  for (const gift of gifts) {
    const id = gift.giftId || gift.fallbackGiftId || ''
    const meta = resolveGiftMetadata(gift, catalog)
    if (meta?.isLottery) continue
    const key = id ? giftCatalogKey(id, gift.giftCatalogType) : `missing:${gift.name}`
    if ((meta?.isFree || isKnownFreeGiftName(gift.name) || meta?.priceYuan != null) && !manual[key]) continue
    const previous = items.get(key)
    items.set(key, { id, catalogType: gift.giftCatalogType, name: meta?.name || gift.name || (id ? `礼物 ${id}` : '未知礼物'),
      count: (previous?.count || 0) + gift.count,
      priceYuan: meta?.isFree ? 0 : meta?.priceYuan ?? null,
      source: meta?.priceYuan != null || meta?.isFree ? meta.priceSource || 'platform' : 'unknown' })
  }
  for (const [key, price] of Object.entries(manual)) {
    if (items.has(key)) continue
    const catalogType = key.startsWith('prop:') ? 'prop' : 'gift'
    const id = catalogType === 'prop' ? key.slice(5) : key
    const meta = catalog.get(key)
    if (meta?.isLottery) continue
    items.set(key, { id, catalogType, name: meta?.name || price.name || `礼物 ${id}`, count: 0,
      priceYuan: meta?.isFree ? 0 : meta?.priceYuan ?? price.priceYuan,
      source: meta?.priceSource || 'platform' })
  }
  return [...items.values()].sort((a, b) => Number(a.source !== 'unknown') - Number(b.source !== 'unknown') || b.count - a.count || a.id.localeCompare(b.id))
}
