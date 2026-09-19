import type { DanmakuPayload, GiftMetadata, GiftBannerCatalog, LotteryGiftSummary } from './types'
import { giftCatalogKey, resolveGiftMetadata } from './giftMetadata'
import { resolveOfficialGiftMedia } from './giftMedia'

export const LOTTERY_JOIN_MS = 6_000
/** 游戏开奖可能经过多站或动画；仅凭已确认的来源/奖池延长等待，不改变投入分组。 */
export const LOTTERY_REWARD_WAIT_MS = 180_000
const LOTTERY_MAX_SPAN_MS = 30_000
const GIFT_JOIN_MS = 1_000

interface ReceivedGift {
  id: number
  at: number
  payload: DanmakuPayload
}

export interface PresentedGift {
  key: string
  payload: DanmakuPayload
  createdAt: number
  updatedAt: number
  sourceIds: number[]
}

export function giftQuantity(payload: DanmakuPayload): number {
  const count = Number(payload.giftCount)
  if (Number.isFinite(count) && count >= 0) return Math.min(1_000_000_000, Math.floor(count))
  return payload.giftKind && payload.giftKind !== 'gift' && payload.giftKind !== 'unknown' ? 0 : 1
}

function unitFen(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null
  const fen = Math.round(value * 100)
  return Number.isSafeInteger(fen) ? fen : null
}

function pricedPayload(payload: DanmakuPayload, catalog: ReadonlyMap<string, GiftMetadata>, banners: GiftBannerCatalog): DanmakuPayload {
  const meta = resolveGiftMetadata(payload, catalog)
  const { giftPrice: oldPrice, giftPriceSource: oldSource, giftIsFree: oldFree, ...unpriced } = payload
  const media = resolveOfficialGiftMedia(payload, meta, banners)
  if (!meta) return { ...(oldSource === 'manual' ? { ...unpriced, giftKind: 'unknown' as const } : payload), ...media }
  const price = meta.isFree ? 0 : meta.priceYuan
  return {
    ...unpriced, ...media, giftId: meta.id, giftName: meta.name || payload.giftName,
    giftImage: meta.image || payload.giftImage, giftIsFree: meta.isFree, giftIsLottery: meta.isLottery,
    ...(price != null ? { giftPrice: price, giftPriceSource: meta.priceSource } : {}),
    giftKind: !payload.giftKind || payload.giftKind === 'gift' || payload.giftKind === 'unknown'
      ? price != null ? 'gift' : 'unknown' : payload.giftKind
  }
}

interface GiftGroup extends PresentedGift {
  source?: GiftMetadata
  rewards: Map<string, { name: string; count: number; valueFen: number | null }>
}

/**
 * 仅负责展示。保留原始分项以便目录晚到、补价、清除补价时重新计算。
 * 不以奖励数量反推投入，不把缺失的 UID、cid 或昵称当作可靠批次关系。
 */
export class GiftPresentationStore {
  private sequence = 0
  private records: ReceivedGift[] = []
  private catalog = new Map<string, GiftMetadata>()
  private banners: GiftBannerCatalog = {}
  private rewardSources = new Map<string, GiftMetadata[]>()
  private retired = new Set<number>()

  add(payload: DanmakuPayload, at = Date.now()): void {
    this.records = this.records.filter(record => {
      if (!this.retired.has(record.id) || at - record.at <= LOTTERY_REWARD_WAIT_MS) return true
      this.retired.delete(record.id)
      return false
    })
    this.records.push({ id: ++this.sequence, at, payload: { ...payload } })
  }

  updateCatalog(catalog: ReadonlyMap<string, GiftMetadata>, banners: GiftBannerCatalog = {}): void {
    this.catalog = new Map(catalog)
    this.banners = banners
    this.rewardSources.clear()
    for (const meta of catalog.values()) {
      if (!meta.isLottery || meta.catalogType === 'prop') continue
      for (const pid of meta.lotteryRewardIds || []) {
        const sources = this.rewardSources.get(pid) || []
        sources.push(meta)
        this.rewardSources.set(pid, sources)
      }
    }
  }

  discard(sourceIds: readonly number[]): void {
    const ids = new Set(sourceIds)
    this.records = this.records.filter(record => !ids.has(record.id))
    for (const id of ids) this.retired.delete(id)
  }

  /** 撤下卡片但短时保留原始投入；晚到奖励仍能核对已经显示过的礼包。 */
  retire(sourceIds: readonly number[]): void { for (const id of sourceIds) this.retired.add(id) }

  clear(): void { this.records = []; this.retired.clear() }

  get size(): number { return this.records.length }

  snapshot(foldOrdinaryGifts = true): PresentedGift[] {
    const records = this.records.map(record => ({ ...record, payload: pricedPayload(record.payload, this.catalog, this.banners) }))
    const inputs = new Map<string, { at: number; source: GiftMetadata }[]>()
    const inputSource = (payload: DanmakuPayload): GiftMetadata | undefined => {
      if (payload.giftCatalogType === 'prop') return undefined
      const meta = resolveGiftMetadata(payload, this.catalog)
      if (meta?.isLottery) return meta
      if (payload.giftIsLottery && payload.giftId) return {
        id: payload.giftId, name: payload.giftName || '抽奖礼物', image: payload.giftImage || '',
        priceYuan: null, isFree: false, isLottery: true
      }
      return undefined
    }
    for (const record of records) {
      const uid = record.payload.userId
      const source = inputSource(record.payload)
      if (uid && uid !== '0' && source) {
        const list = inputs.get(uid) || []
        list.push({ at: record.at, source })
        inputs.set(uid, list)
      }
    }

    const groups: GiftGroup[] = []
    const recent = new Map<string, GiftGroup>()
    for (const record of records) {
      const { payload, at, id } = record
      const uid = payload.userId && payload.userId !== '0' ? payload.userId : `missing:${id}`
      let source = inputSource(payload)
      const isInput = Boolean(source)
      if (!source && payload.giftCatalogType === 'prop') {
        // 原始 gfid 只有被官方确认为投入道具后才有来源含义。
        const explicit = payload.sourceGiftId ? this.catalog.get(payload.sourceGiftId) : undefined
        if (explicit?.isLottery) source = explicit
        else if (payload.giftId) {
          // 同一个奖品可属于多个奖池；只关联窗口内唯一匹配的真实投入。
          const sources = new Set((this.rewardSources.get(payload.giftId) || []).map(meta => meta.id))
          const candidates = new Map((inputs.get(uid) || [])
            .filter(input => Math.abs(input.at - at) <= LOTTERY_REWARD_WAIT_MS && sources.has(input.source.id))
            .map(input => [input.source.id, input.source]))
          if (candidates.size === 1) source = candidates.values().next().value
        }
      }
      const identity = source ? `lottery:${uid}:${source.id}` :
        `gift:${uid}:${payload.giftKind || 'gift'}:${giftCatalogKey(payload.giftId || payload.giftName || '', payload.giftCatalogType)}`
      const previous = recent.get(identity)
      const delayedReward = Boolean(source && !isInput)
      const windowMs = source ? delayedReward ? LOTTERY_REWARD_WAIT_MS : LOTTERY_JOIN_MS : foldOrdinaryGifts ? GIFT_JOIN_MS : 0
      const canJoin = windowMs > 0 && previous && at >= previous.updatedAt && at - previous.updatedAt <= windowMs &&
        at - previous.createdAt <= (delayedReward ? LOTTERY_REWARD_WAIT_MS : LOTTERY_MAX_SPAN_MS)
      const group: GiftGroup = canJoin ? previous : {
        key: `gift:${id}`, payload: { ...payload }, createdAt: at, updatedAt: at, sourceIds: [],
        source, rewards: new Map()
      }
      if (!canJoin) {
        groups.push(group)
        recent.set(identity, group)
        if (source) {
          const summary: LotteryGiftSummary = {
            inputCount: 0, inputValue: null, rewardCount: 0, rewardValue: 0, unpricedRewardCount: 0, rewards: []
          }
          group.payload = {
            ...payload, kind: 'gift', giftKind: 'gift', giftId: source.id, giftCatalogType: 'gift',
            giftName: source.name || '抽奖礼物', giftImage: source.image || undefined,
            giftStaticImage: source.staticImage,
            // 奖励先到时不能在投入礼包上播放奖励本身的特效。
            ...(!isInput ? { giftEffectId: undefined, giftVideo: undefined, giftBanner: undefined, giftBannerId: undefined } : {}),
            text: source.name || '抽奖礼物', giftCount: 0, giftIsLottery: true, lotterySummary: summary
          }
          delete group.payload.giftPrice
          delete group.payload.giftPriceSource
          delete group.payload.giftIsFree
          delete group.payload.fallbackGiftId
          delete group.payload.sourceGiftId
        }
      }
      group.sourceIds.push(id)
      group.updatedAt = at
      if (!source) {
        if (canJoin) group.payload = { ...group.payload, ...payload,
          giftCount: giftQuantity(group.payload) + giftQuantity(payload),
          giftHits: Math.max(group.payload.giftHits || 0, payload.giftHits || 0) }
        if (payload.giftCatalogType === 'prop' && payload.giftId && this.rewardSources.has(payload.giftId)) group.payload.lotteryUnmatched = true
        continue
      }

      const summary = group.payload.lotterySummary!
      const count = giftQuantity(payload)
      if (isInput) {
        summary.inputCount += count
        const priceFen = unitFen(source.lotteryPriceYuan)
        summary.inputValue = priceFen == null ? null : summary.inputCount * priceFen / 100
        group.payload.giftCount = summary.inputCount
      } else {
        const priceFen = payload.giftIsFree ? 0 : unitFen(payload.giftPrice)
        const key = giftCatalogKey(payload.giftId || payload.giftName || '', payload.giftCatalogType)
        const reward = group.rewards.get(key)
        group.rewards.set(key, {
          name: payload.giftName || '未知奖励', count: (reward?.count || 0) + count,
          valueFen: priceFen == null || reward?.valueFen === null ? null : (reward?.valueFen || 0) + priceFen * count
        })
        summary.rewardCount += count
        if (priceFen == null) summary.unpricedRewardCount += count
        else summary.rewardValue += priceFen * count
      }
    }

    for (const group of groups) {
      const summary = group.payload.lotterySummary
      if (!summary) continue
      summary.rewards = [...group.rewards.values()].map(item => ({ name: item.name, count: item.count,
        value: item.valueFen == null ? null : item.valueFen / 100 }))
      summary.rewardValue /= 100
    }
    // 容量裁剪按整组进行，不能丢掉半组后仍把剩余金额当作这组总额。
    let size = this.records.length
    const discarded = new Set<number>()
    while (groups.length > 1 && (groups.length > 160 || size > 5_000)) {
      const oldest = groups.shift()!
      for (const id of oldest.sourceIds) discarded.add(id)
      size -= oldest.sourceIds.length
    }
    if (discarded.size) this.discard([...discarded])
    return groups.filter(group => group.sourceIds.some(id => !this.retired.has(id)))
      .map(({ source: _source, rewards: _rewards, ...group }) => group)
  }
}
