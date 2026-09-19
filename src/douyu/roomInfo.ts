/** 斗鱼房间礼物目录与活动奖池。普通礼物和奖励道具独立查价，接口中的分换算为元。 */

import type { GiftMetadata, GiftBannerCatalog, OfficialGiftEffect } from '../shared/types'
import { giftCatalogKey, mergeGiftMetadata } from '../shared/giftMetadata'
import { officialGiftUrl } from '../shared/giftMedia'
export { resolveGiftMetadata } from '../shared/giftMetadata'
export type DouyuGiftMeta = GiftMetadata

export interface DouyuRoomGiftCatalog {
  roomId: string
  gifts: Map<string, DouyuGiftMeta>
  banners?: GiftBannerCatalog
}

type JsonRecord = Record<string, unknown>

/** 已确认的免费礼物关键词；短名称只做精确匹配。 */
const KNOWN_FREE_GIFT_KEYWORDS = [
  '荧光棒',
  '赞',
  '鱼丸',
  '弱鸡',
  '呵呵',
  '稳',
  '充能电池',
  '陪伴印章'
] as const

export function isKnownFreeGiftName(value: unknown): boolean {
  const name = String(value ?? '').trim()
  return Boolean(name) && KNOWN_FREE_GIFT_KEYWORDS.some((keyword) =>
    keyword.length <= 2 && keyword !== '鱼丸' ? name === keyword : name.includes(keyword)
  )
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function finiteNonNegative(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function safeDouyuImage(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:/i, 'https:')
  try {
    const url = new URL(candidate)
    if (
      url.protocol === 'https:' &&
      (url.hostname === 'douyucdn.cn' || url.hostname.endsWith('.douyucdn.cn'))
    ) {
      return url.href
    }
  } catch {
    /* 忽略无效或非斗鱼图片地址 */
  }
  return ''
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: 'https://www.douyu.com/'
      }
    })
    if (!response.ok) throw new Error(`斗鱼礼物数据请求失败：HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<JsonRecord> {
  const text = await fetchText(url, timeoutMs)
  const value = JSON.parse(text) as unknown
  if (!isRecord(value)) throw new Error('斗鱼礼物接口返回值不是对象')
  return value
}

/** 解析房间别名；失败时继续使用用户输入的房间号。 */
export async function resolveDouyuRoomId(roomId: string): Promise<string> {
  try {
    const response = await fetchJson(
      `https://wxapp.douyucdn.cn/Live/Room/info/${encodeURIComponent(roomId)}`
    )
    const resolved = String(asRecord(response.data).room_id ?? '').trim()
    return resolved || roomId
  } catch {
    return roomId
  }
}

/** 按实际收到的新礼物 ID 补目录，不维护写死的礼物编号范围。 */
export function addRequestedGiftIds(preInfo: string, giftIds: readonly string[]): string {
  const ids = [...new Set(giftIds.filter(id => /^\d{1,18}$/.test(id)))].slice(-200)
  return ids.length ? preInfo.replace(/--$/, `-${ids.join('_')}-`) : preInfo
}

/** 取得 V2 礼物列表所需的前置信息。 */
async function fetchGiftPreInfo(roomId: string, giftIds: readonly string[]): Promise<string> {
  const response = await fetchJson(
    `https://gift.douyucdn.cn/japi/reward/giftv2/preInfo/pc/v2?rid=${encodeURIComponent(roomId)}&userLevel=135&version=8.6.2.2`
  )
  if (Number(response.error) !== 0) return ''
  const raw = String(asRecord(response.data).giftPreInfo ?? '')
  if (!raw) return ''

  return addRequestedGiftIds(raw, giftIds)
}

export function giftCatalogFromList(value: unknown): Map<string, DouyuGiftMeta> {
  const catalog = new Map<string, DouyuGiftMeta>()
  if (!Array.isArray(value)) return catalog
  for (const rawItem of value) {
    const item = asRecord(rawItem)
    const id = String(item.id ?? '').trim()
    if (!id) continue
    const basicInfo = asRecord(item.basicInfo)
    const priceInfo = asRecord(item.priceInfo)
    const name = String(item.name ?? '').trim()
    const priceFen = finiteNonNegative(priceInfo.price)
    const isLottery = Number(basicInfo.giftType) === 17
    const priceYuan = isLottery || priceFen == null ? null : priceFen / 100
    const prefix = typeof item.picUrlPrefix === 'string' ? item.picUrlPrefix : undefined
    const effects: Record<string, OfficialGiftEffect> = {}
    if (Number(item.effectStatus) !== 0) for (const [effectId, rawEffect] of Object.entries(asRecord(item.effectInfo))) {
      if (!/^\d{1,18}$/.test(effectId)) continue
      const effect = asRecord(rawEffect), mp4 = asRecord(effect.mp4), banner = asRecord(effect.banner)
      const video = officialGiftUrl(mp4.mp4Src, prefix)
      const image = officialGiftUrl(banner.bannerPicDark || banner.bannerPic, prefix)
      if (video || image) effects[effectId] = { ...(video ? { video } : {}),
        ...(image ? { banner: image, bannerId: String(banner.bannerEId || '') } : {}) }
    }
    catalog.set(id, {
      id,
      name,
      image: officialGiftUrl(basicInfo.focusPic || basicInfo.giftPic, prefix) || '',
      staticImage: officialGiftUrl(basicInfo.giftPic || basicInfo.chatPic, prefix),
      ...(Object.keys(effects).length ? { effects } : {}),
      priceYuan,
      isFree: !isLottery && (priceYuan === 0 || isKnownFreeGiftName(name)),
      isLottery,
      ...(isLottery ? { lotteryPriceYuan: priceFen == null ? null : priceFen / 100 } : {})
    })
  }
  return catalog
}

export function giftBannersFromResponse(value: unknown): GiftBannerCatalog {
  const response = asRecord(value)
  if (Number(response.error) !== 0) return {}
  let data: JsonRecord
  try { data = asRecord(typeof response.data === 'string' ? JSON.parse(response.data) : response.data) }
  catch { return {} }
  const banners: GiftBannerCatalog = {}
  for (const [id, item] of Object.entries(asRecord(data.bannersNew))) {
    const banner = asRecord(item)
    const image = officialGiftUrl(banner.bannerPicDark || banner.bannerPic)
    if (/^\d{1,18}$/.test(id) && image) banners[id] = image
  }
  return banners
}

/**
 * 官方 PropDataServices 使用 /api/prop/v5/web/single?pid=...。
 * priceType=2 的 price 单位是分；奖池 ratio.award.value 是贡献值，不能当作元。
 */
export function propMetadataFromResponse(value: unknown, requestedId?: string): DouyuGiftMeta | undefined {
  const response = asRecord(value)
  if (Number(response.error) !== 0) return undefined
  let data: JsonRecord
  try {
    data = asRecord(typeof response.data === 'string' ? JSON.parse(response.data) : response.data)
  } catch { return undefined }
  const id = String(data.id ?? '').trim()
  if (!/^\d{1,18}$/.test(id) || id === '0' || (requestedId && requestedId !== id)) return undefined
  const name = String(data.name ?? '').trim()
  const priceFen = finiteNonNegative(data.price)
  const priceType = finiteNonNegative(data.priceType)
  const isFree = finiteNonNegative(data.isValuable) === 0 || priceType === 1 || priceFen === 0 || isKnownFreeGiftName(name)
  const priceYuan = isFree ? 0 : priceType === 2 && priceFen != null ? priceFen / 100 : null
  let image = ''
  for (const source of [data.focusPic, data.propPic, data.chatPic]) {
    const candidates = Array.isArray(source) ? source.map(item => asRecord(item).src) : [source]
    for (const candidate of candidates) {
      const path = String(candidate ?? '').trim()
      if (!path) continue
      image = /^(?:https?:)?\/\//i.test(path) ? safeDouyuImage(path)
        : safeDouyuImage(`${String(data.picUrlPrefix || 'https://gfs-op.douyucdn.cn/dygift').replace(/\/$/, '')}/${path.replace(/^\//, '')}`)
      if (image) break
    }
    if (image) break
  }
  return { id, catalogType: 'prop', name, image, priceYuan, isFree }
}

/** 新奖励按实际 pid 查询，限制并发并隔离单项失败，避免活动更换时维护固定价格表。 */
export async function fetchDouyuPropCatalog(propIds: readonly string[]): Promise<Map<string, DouyuGiftMeta>> {
  const ids = [...new Set(propIds.filter(id => /^\d{1,18}$/.test(id) && id !== '0'))].slice(-200).reverse()
  const catalog = new Map<string, DouyuGiftMeta>()
  // 新到的未知 ID 位于队尾，优先查询；整批共享时限，网络异常时不逐项累加等待。
  const deadline = Date.now() + 12_000
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const id = ids[next++]!
      try {
        const result = await fetchJson(`https://gift.douyucdn.cn/api/prop/v5/web/single?pid=${encodeURIComponent(id)}`, remainingMs)
        const meta = propMetadataFromResponse(result, id)
        if (meta) catalog.set(giftCatalogKey(meta.id, 'prop'), meta)
      } catch {
        // 缺价继续保留待确认，主进程会重试；一项失败不影响其他奖励。
      }
    }
  }))
  return catalog
}

async function fetchRoomGiftV2(preInfo: string): Promise<Map<string, DouyuGiftMeta>> {
  if (!preInfo) return new Map()
  const response = await fetchJson(
    `https://gift.douyucdn.cn/japi/reward/giftv2/list/details/pc/v2?giftPreInfo=${encodeURIComponent(preInfo)}&userLevel=150`
  )
  return giftCatalogFromList(asRecord(response.data).giftList)
}

async function fetchRoomGiftLegacy(roomId: string): Promise<Map<string, DouyuGiftMeta>> {
  const response = await fetchJson(
    `https://gift.douyucdn.cn/api/gift/v2/web/list?rid=${encodeURIComponent(roomId)}`
  )
  return giftCatalogFromList(asRecord(response.data).giftList)
}

/** 读取背包礼物 JSONP；失败不影响其他礼物目录。 */
async function fetchBagGiftCatalog(): Promise<Map<string, DouyuGiftMeta>> {
  const raw = await fetchText(
    'http://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json'
  )
  const prefix = 'DYConfigCallback('
  const start = raw.indexOf(prefix)
  const end = raw.lastIndexOf(')')
  if (start < 0 || end <= start) return new Map()
  const parsed = JSON.parse(raw.slice(start + prefix.length, end)) as unknown
  const data = asRecord(asRecord(parsed).data)
  const catalog = new Map<string, DouyuGiftMeta>()
  for (const [id, rawItem] of Object.entries(data)) {
    const item = asRecord(rawItem)
    const name = String(item.name ?? '').trim()
    const priceFen = finiteNonNegative(item.pc)
    const priceYuan = priceFen == null ? null : priceFen / 100
    catalog.set(id, {
      id,
      name,
      image: safeDouyuImage(item.himg),
      priceYuan,
      // 该清单也包含超级火箭等付费礼物，不能仅凭“来自背包目录”判免费。
      isFree: priceYuan === 0 || isKnownFreeGiftName(name)
    })
  }
  return catalog
}

/** 读取本月活动礼物目录。 */
async function fetchActivityGiftCatalog(): Promise<Map<string, DouyuGiftMeta>> {
  const now = new Date()
  const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const raw = await fetchText(
    `https://webconf.douyucdn.cn/resource/common/activity/actqzs${month}_w.json`
  )
  const prefix = 'DYConfigCallback('
  const start = raw.indexOf(prefix)
  const end = raw.lastIndexOf(')')
  if (start < 0 || end <= start) return new Map()
  const parsed = JSON.parse(raw.slice(start + prefix.length, end)) as unknown
  const exchangeList = asRecord(asRecord(parsed).data).exchangeList
  const catalog = new Map<string, DouyuGiftMeta>()
  if (!Array.isArray(exchangeList)) return catalog
  for (const rawEntry of exchangeList) {
    const award = asRecord(asRecord(rawEntry).awardInfo)
    const awardType = Number(award.awardType)
    if (!Object.keys(award).length || awardType === 96 || awardType === 103) continue
    const id = String(award.cardId ?? '').trim()
    if (!id) continue
    const name = String(award.name ?? '').trim()
    catalog.set(id, {
      id,
      name,
      image: safeDouyuImage(award.pic),
      // 此接口没有真实价格，展示占位值不能当作金额入账。
      priceYuan: null,
      isFree: isKnownFreeGiftName(name)
    })
  }
  return catalog
}

export function mergeSettledCatalogs(
  results: PromiseSettledResult<Map<string, DouyuGiftMeta>>[]
): Map<string, DouyuGiftMeta> {
  const merged = new Map<string, DouyuGiftMeta>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const [id, item] of result.value) {
      merged.set(id, mergeGiftMetadata(merged.get(id), item))
    }
  }
  return merged
}

/** 梦想巴士的投入礼物在普通目录中是 giftType=0；以官方玩法配置确认其用途。 */
export function dreamBusGiftReferences(value: unknown): { input: DouyuGiftMeta | null; propIds: string[] } {
  const data = asRecord(asRecord(value).data)
  const id = String(data.gift_id ?? '').trim()
  const rewards = Array.isArray(data.propList) ? data.propList : []
  const propIds = [...new Set(rewards.map(item => String(asRecord(item).awardId ?? '').trim())
    .filter(id => /^\d{1,18}$/.test(id) && id !== '0'))]
  // 不依据名称猜测礼包；只有完整的官方投入/奖励配置才建立关联。
  if (!/^\d{1,18}$/.test(id) || id === '0' || !propIds.length || !Array.isArray(data.stations) || !data.stations.length) return { input: null, propIds: [] }
  return { input: { id, catalogType: 'gift', name: String(data.gift_name || '').trim(), image: safeDouyuImage(data.gift_pic),
    priceYuan: null, isFree: false, isLottery: true, lotteryRewardIds: propIds,
    lotteryPriceYuan: finiteNonNegative(data.gift_price) == null ? null : Number(data.gift_price) / 100 }, propIds }
}

/** 通用变幻礼物配置，活动换名、投入 ID 或奖励 ID 更新时无需改源码。 */
export function lotteryCatalogFromResponse(value: unknown): Map<string, DouyuGiftMeta> {
  const response = asRecord(value)
  const catalog = new Map<string, DouyuGiftMeta>()
  if (Number(response.error) !== 0) return catalog
  let data: JsonRecord
  try { data = asRecord(typeof response.data === 'string' ? JSON.parse(response.data) : response.data) }
  catch { return catalog }
  for (const [id, raw] of Object.entries(data)) {
    const item = asRecord(raw)
    const rewards = [...new Set(Object.values(asRecord(item.ratio)).flatMap(rawTier => {
      const awards = asRecord(rawTier).award
      return Array.isArray(awards) ? awards.map(award => String(asRecord(award).pid ?? '').trim()) : []
    }).filter(pid => /^\d{1,18}$/.test(pid) && pid !== '0'))]
    const priceFen = finiteNonNegative(item.giftPrice)
    if (!/^\d{1,18}$/.test(id) || id === '0' || !rewards.length) continue
    catalog.set(id, { id, catalogType: 'gift', name: String(item.giftName || '').trim(),
      image: safeDouyuImage(item.giftPic), priceYuan: null, isFree: false, isLottery: true,
      lotteryPriceYuan: priceFen == null ? null : priceFen / 100, lotteryRewardIds: rewards })
  }
  return catalog
}

async function fetchLotteryGiftCatalog(roomId: string): Promise<Map<string, DouyuGiftMeta>> {
  return lotteryCatalogFromResponse(await fetchJson(
    `https://www.douyu.com/japi/interact/comm/pandora/config?rid=${encodeURIComponent(roomId)}`
  ))
}

async function fetchDreamBusGiftCatalog(): Promise<Map<string, DouyuGiftMeta>> {
  // 入口来自斗鱼 ActivityDreamBus 的配置地址；礼包与奖励 ID、价格都不写死。
  const raw = await fetchText('https://webconf.douyucdn.cn/resource/common/dream_bus_w.json')
  const prefix = 'DYConfigCallback('
  const start = raw.indexOf(prefix), end = raw.lastIndexOf(')')
  if (start < 0 || end <= start) return new Map()
  const references = dreamBusGiftReferences(JSON.parse(raw.slice(start + prefix.length, end)))
  if (!references.input) return new Map()
  // 活动表里的展示贡献值不作单价，奖励仍查询统一的官方道具接口。
  const catalog = await fetchDouyuPropCatalog(references.propIds)
  catalog.set(references.input.id, references.input)
  return catalog
}

/**
 * 合并普通礼物的四个官方来源；奖励道具独立查询，不能用主礼物价格代替。
 */
export async function fetchDouyuGiftCatalog(roomId: string, resolvedRoomId?: string, giftIds: readonly string[] = [], propIds: readonly string[] = []): Promise<DouyuRoomGiftCatalog> {
  const realRoomId = resolvedRoomId || await resolveDouyuRoomId(roomId)
  const [results, banners] = await Promise.all([Promise.allSettled([
    fetchBagGiftCatalog(),
    fetchActivityGiftCatalog(),
    fetchRoomGiftLegacy(realRoomId),
    fetchGiftPreInfo(realRoomId, giftIds).then(fetchRoomGiftV2),
    fetchDouyuPropCatalog(propIds),
    fetchDreamBusGiftCatalog(),
    fetchLotteryGiftCatalog(realRoomId),
  ]), fetchJson('https://gift.douyucdn.cn/api/gift/v1/web/commonConfig')
    .then(giftBannersFromResponse).catch(() => undefined)])
  return { roomId: realRoomId, gifts: mergeSettledCatalogs(results), banners }
}
