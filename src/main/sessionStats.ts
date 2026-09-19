import type { ChatMessage, GiftMessage } from '../douyu/client'
import { createHash } from 'node:crypto'
import { isKnownFreeGiftName, resolveGiftMetadata, type DouyuGiftMeta } from '../douyu/roomInfo'
import type { GiftCatalogType, OverlayStatsPayload } from '../shared/types'
import { emptyChatExclusions, type ChatExclusions, type ChatExclusionReason } from '../shared/chatPolicy'
import { giftCatalogKey } from '../shared/giftMetadata'

export interface GiftBucket {
  giftId?: string
  fallbackGiftId?: string
  giftCatalogType?: GiftCatalogType
  name: string
  count: number
  userId?: string
  nick?: string
  sourceGiftId?: string
}

export interface ChatUserDetail { userId: string; nick: string; count: number }

export interface StatisticsState {
  scope: string
  startedAt: number
  danmakuCount: number
  unidentifiedChatCount: number
  users: string[]
  seen: string[]
  exclusions: ChatExclusions
  gifts: GiftBucket[]
  catalog: [string, DouyuGiftMeta][]
  userDetails?: ChatUserDetail[]
}

function digest(value: string): string { return createHash('sha256').update(value).digest('base64url') }

/** 在来源过滤后记账，独立于展示队列、动画以及连接重试。 */
export class SessionStats {
  constructor(private readonly eventLimit = 100_000) {}
  private scope = ''
  private startedAt = Date.now()
  private noble: number | null = null
  private danmakuCount = 0
  private unidentifiedChatCount = 0
  private users = new Set<string>()
  private seen = new Set<string>()
  private gifts = new Map<string, GiftBucket>()
  private catalog = new Map<string, DouyuGiftMeta>()
  private exclusions = emptyChatExclusions()
  private userDetails = new Map<string, ChatUserDetail>()

  begin(scope: string): boolean {
    if (this.scope === scope) return false
    this.scope = scope
    this.startedAt = Date.now()
    this.noble = null
    this.danmakuCount = 0
    this.unidentifiedChatCount = 0
    this.users.clear()
    this.seen.clear()
    this.gifts.clear()
    this.catalog.clear()
    this.exclusions = emptyChatExclusions()
    this.userDetails.clear()
    return true
  }

  private accept(kind: string, id?: string): boolean {
    if (!id) return true // 无可靠事件 ID 时不凭相同文字/数量猜测重复。
    const key = digest(`${kind}:${id}`)
    if (this.seen.has(key)) return false
    this.seen.add(key)
    if (this.seen.size > this.eventLimit) this.seen.delete(this.seen.values().next().value!)
    return true
  }

  recordChat(message: Pick<ChatMessage, 'messageId' | 'userId'> & Partial<Pick<ChatMessage, 'nick'>>): boolean {
    if (!this.accept('chat', message.messageId)) return false
    this.danmakuCount += 1
    const uid = String(message.userId || '').trim()
    if (uid && uid !== '0') this.users.add(digest(`user:${uid}`))
    else this.unidentifiedChatCount += 1
    const key = uid && uid !== '0' ? uid : ''
    const previous = this.userDetails.get(key)
    this.userDetails.set(key, { userId: key, nick: message.nick || previous?.nick || '未知用户', count: (previous?.count || 0) + 1 })
    return true
  }

  recordGift(gift: GiftMessage): boolean {
    if (gift.type !== 'dgb') return false
    const rawCount = gift.giftCount ?? 1
    if (!Number.isSafeInteger(rawCount) || rawCount <= 0 || !this.accept('gift', gift.messageId)) return false
    const count = Math.floor(rawCount)
    const uid = gift.userId && gift.userId !== '0' ? gift.userId : ''
    const key = JSON.stringify([uid, gift.giftCatalogType, gift.giftId, gift.fallbackGiftId, gift.giftName, gift.sourceGiftId])
    const previous = this.gifts.get(key)
    this.gifts.set(key, {
      giftId: gift.giftId,
      fallbackGiftId: gift.fallbackGiftId,
      giftCatalogType: gift.giftCatalogType,
      name: gift.giftName,
      count: (previous?.count ?? 0) + count,
      userId: uid, nick: gift.nick || previous?.nick || '未知用户', sourceGiftId: gift.sourceGiftId
    })
    return true
  }

  getGiftBuckets(): GiftBucket[] {
    return [...this.gifts.values()].map(gift => ({ ...gift }))
  }

  getChatUsers(): ChatUserDetail[] { return [...this.userDetails.values()].map(user => ({ ...user })) }

  recordExcluded(message: Pick<ChatMessage, 'messageId'>, reason: ChatExclusionReason): boolean {
    if (!this.accept('chat', message.messageId)) return false
    this.exclusions[reason] += 1
    return true
  }

  getExclusions(): ChatExclusions { return { ...this.exclusions } }
  hasRecorded(kind: 'chat' | 'gift', id: string): boolean { return this.seen.has(digest(`${kind}:${id}`)) }

  getCatalog(): Map<string, DouyuGiftMeta> { return new Map(this.catalog) }

  /** 保存用户归属和已出现礼物的价格；正文由独立的可选日志保存。 */
  exportState(): StatisticsState {
    const keys = new Set<string>()
    for (const gift of this.gifts.values()) {
      if (gift.giftId) keys.add(giftCatalogKey(gift.giftId, gift.giftCatalogType))
      if (gift.fallbackGiftId && !gift.giftCatalogType) keys.add(gift.fallbackGiftId)
      if (gift.sourceGiftId) keys.add(gift.sourceGiftId)
    }
    return { scope: this.scope, startedAt: this.startedAt, danmakuCount: this.danmakuCount,
      unidentifiedChatCount: this.unidentifiedChatCount, users: [...this.users], seen: [...this.seen],
      exclusions: this.getExclusions(), gifts: this.getGiftBuckets(), userDetails: this.getChatUsers(),
      catalog: [...this.catalog].filter(([id]) => keys.has(id)).map(([id, meta]) => [id, { ...meta, image: '' }]) }
  }

  static restore(value: unknown, eventLimit = 100_000): SessionStats {
    const state = value as StatisticsState | undefined
    const validCount = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0
    const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^[\w-]{43}$/.test(id))
    if (!state || typeof state.scope !== 'string' || !validCount(state.startedAt) ||
      !validCount(state.danmakuCount) || !validCount(state.unidentifiedChatCount) ||
      !validIds(state.users) || !validIds(state.seen) || !Array.isArray(state.gifts) || !Array.isArray(state.catalog) ||
      !state.exclusions || !Object.keys(emptyChatExclusions()).every(key => validCount(state.exclusions[key as ChatExclusionReason]))) {
      throw new Error('统计记录结构损坏')
    }
    const result = new SessionStats(eventLimit)
    result.scope = state.scope
    result.startedAt = state.startedAt
    result.danmakuCount = state.danmakuCount
    result.unidentifiedChatCount = state.unidentifiedChatCount
    result.users = new Set(state.users)
    result.seen = new Set(Number.isFinite(eventLimit) ? state.seen.slice(-eventLimit) : state.seen)
    result.exclusions = { ...state.exclusions }
    if (state.userDetails !== undefined) {
      if (!Array.isArray(state.userDetails)) throw new Error('用户统计记录损坏')
      for (const user of state.userDetails) {
        if (!user || typeof user.userId !== 'string' || typeof user.nick !== 'string' || !validCount(user.count)) throw new Error('用户统计记录损坏')
        result.userDetails.set(user.userId, { ...user })
      }
    }
    for (const gift of state.gifts) {
      if (!gift || typeof gift.name !== 'string' || !validCount(gift.count) || gift.count < 1 ||
        (gift.giftId != null && typeof gift.giftId !== 'string') ||
        (gift.fallbackGiftId != null && typeof gift.fallbackGiftId !== 'string') ||
        (gift.giftCatalogType != null && gift.giftCatalogType !== 'gift' && gift.giftCatalogType !== 'prop') ||
        (gift.userId != null && typeof gift.userId !== 'string') || (gift.nick != null && typeof gift.nick !== 'string') ||
        (gift.sourceGiftId != null && typeof gift.sourceGiftId !== 'string')) throw new Error('礼物数量记录损坏')
      result.gifts.set(JSON.stringify([gift.userId, gift.giftCatalogType, gift.giftId, gift.fallbackGiftId, gift.name, gift.sourceGiftId]), { ...gift })
    }
    for (const entry of state.catalog) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('礼物价格记录损坏')
      const [key, meta] = entry
      if (typeof key !== 'string' || !meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' ||
        typeof meta.isFree !== 'boolean' || (meta.priceYuan !== null && (typeof meta.priceYuan !== 'number' || !Number.isFinite(meta.priceYuan) || meta.priceYuan < 0))) throw new Error('礼物价格记录损坏')
      result.catalog.set(key, { ...meta, image: '' })
    }
    if (result.users.size > result.danmakuCount || result.unidentifiedChatCount > result.danmakuCount) throw new Error('弹幕人数记录损坏')
    return result
  }

  updateCatalog(catalog: ReadonlyMap<string, DouyuGiftMeta>, replace = false): void {
    if (replace) this.catalog.clear()
    for (const [id, meta] of catalog) {
      const previous = this.catalog.get(id)
      // 刷新失败或临时缺价不能抹掉之前已确认的价格。
      if (meta.priceYuan == null && !meta.isFree && !meta.isLottery && previous?.priceYuan != null) continue
      this.catalog.set(id, meta)
    }
  }

  setNoble(value: number): void {
    if (Number.isFinite(value) && value >= 0) this.noble = Math.floor(value)
  }

  snapshot(): OverlayStatsPayload {
    let giftCount = 0
    let valueFen = 0
    let unknownGiftCount = 0
    for (const gift of this.gifts.values()) {
      const meta = resolveGiftMetadata(gift, this.catalog)
      // 抽奖投入和开出的奖励可能分别广播；只把实际奖励计为收到的礼物。
      if (meta?.isLottery) continue
      giftCount += gift.count
      if (meta?.isFree || isKnownFreeGiftName(gift.name)) continue
      if (meta?.priceYuan == null) unknownGiftCount += gift.count
      else valueFen += gift.count * Math.round(meta.priceYuan * 100)
    }
    return {
      noble: this.noble,
      danmakuUsers: this.users.size,
      danmakuCount: this.danmakuCount,
      giftCount,
      giftValue: valueFen / 100,
      unknownGiftCount,
      unidentifiedChatCount: this.unidentifiedChatCount,
      startedAt: this.startedAt,
      source: this.scope === 'simulate' ? 'simulate' : 'live'
    }
  }
}
