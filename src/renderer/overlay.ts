import type { AppConfig, OverlayStatusMetric } from '../shared/config'
import { danmakuColorForCol } from '../shared/danmakuColor'
import { EmoticonRenderer } from './emoticons'
import type { DanmakuPayload, OverlayStatsPayload, GiftMetadata } from '../shared/types'
import { giftCatalogKey } from '../shared/giftMetadata'
import { GiftPresentationStore, giftQuantity, type PresentedGift } from '../shared/giftPresentation'
import { giftValueTier } from '../shared/giftAppearance'
import { advanceFlowMotion, retargetFlowMotion, incomingBatchSize, motionSpeedScale, type MotionState } from '../shared/motion'
import { EDGE_EXIT_MS, EDGE_EXIT_EASING, edgeReadComplete } from '../shared/edgeMotion'
import { EdgeStage } from './edgeStage'
import { OfficialGiftEffects } from './giftEffects'
import {
  DIAMOND_ICON_URL,
  NOBLE_ICON_URLS,
  ROOM_ADMIN_ICON_URL,
  nativeFansMedalBackgroundUrl,
  nativeUserLevelUrl,
  normalizeNativeFansLevel,
  normalizeNativeLevel
} from './douyuNative'

interface PendingMessage {
  key: string
  payload: DanmakuPayload
  count: number
  queuedAt: number
  lastMergeAt: number
}

interface MessageRowParts {
  element: HTMLLIElement
  messageText: HTMLSpanElement | null
  repeat: HTMLSpanElement | null
}

interface CommonEntry extends PendingMessage {
  shownAt: number
  expiresAt: number
  parts: MessageRowParts
}

interface HighlightEntry extends PresentedGift {
  shownAt: number
  expiresAt: number
  element: HTMLLIElement
  signature: string
}

interface MovingEntry extends PendingMessage {
  createdAt: number
  x: number
  y: number
  width: number
  height: number
  lane: number
  parts: MessageRowParts
}

const NORMAL_INCOMING_INTERVAL_MS = 300
const MOVING_GAP_PX = 12
const STATUS_ROTATION_MS = 15_000
const EXIT_FADE_MS = 220
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const exitAnimations = new Map<HTMLElement, Animation>()
const completedExits = new Map<HTMLElement, () => void>()
const inboundPayloads: DanmakuPayload[] = []

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`缺少悬浮层节点 #${id}`)
  return element as T
}

const root = requiredElement<HTMLDivElement>('overlayRoot')
const messagePane = requiredElement<HTMLElement>('messagePane')
const messageList = requiredElement<HTMLOListElement>('messageList')
const highlightPane = requiredElement<HTMLElement>('highlightPane')
const highlightList = requiredElement<HTMLOListElement>('highlightList')
const statusBar = requiredElement<HTMLElement>('statusBar')
const statusPrimary = requiredElement<HTMLElement>('statusPrimary')
const statusPrimaryLabel = requiredElement<HTMLElement>('statusPrimaryLabel')
const statusPrimaryValue = requiredElement<HTMLElement>('statusPrimaryValue')
const statusPrimaryChange = requiredElement<HTMLElement>('statusPrimaryChange')
const statusRotating = requiredElement<HTMLElement>('statusRotating')
const statusRotatingLabel = requiredElement<HTMLElement>('statusRotatingLabel')
const statusRotatingValue = requiredElement<HTMLElement>('statusRotatingValue')
const statusRotatingChange = requiredElement<HTMLElement>('statusRotatingChange')
const unlockIndicator = requiredElement<HTMLButtonElement>('unlockIndicator')
const movingLayer = requiredElement<HTMLDivElement>('movingLayer')
const edgeLayer = requiredElement<HTMLOListElement>('edgeLayer')
const edgeScene = requiredElement<HTMLElement>('edgeScene')
const edgeStage = new EdgeStage(edgeLayer, fitEntryToHeight, replaceEdgeElement)

function edgeStageOf(element: HTMLElement): EdgeStage | undefined {
  return edgeStage.has(element) ? edgeStage : undefined
}

function configureEdgeStages(cfg: AppConfig): void {
  edgeStage.configure(cfg, motionAllowed())
}

const giftPresentation = new GiftPresentationStore()
const giftEffects = new OfficialGiftEffects()
let giftRenderDirty = false
let nextGiftSyncAt = 0
interface FlowLayout {
  state: MotionState
  positions: Map<HTMLElement, { top: number; width: number; height: number }>
}
const listFlows = new Map<HTMLElement, FlowLayout>([messageList, highlightList].map(list => [list, {
  state: { offset: 0, velocity: 0, acceleration: 0 }, positions: new Map()
}]))

const pendingMessages: PendingMessage[] = []
let lastDisplayEventAt = 0
const commonEntries: CommonEntry[] = []
const highlightEntries: HighlightEntry[] = []
const movingEntries: MovingEntry[] = []

let config: AppConfig | null = null
let stats: OverlayStatsPayload = {
  noble: null,
  danmakuUsers: 0,
  danmakuCount: 0,
  giftCount: 0,
  giftValue: 0
}
const statDiffs = new Map<OverlayStatusMetric, number>()
let statusRotationIndex = 0
let lastAnimationTs = 0
let nextIncomingAt = 0
let layoutFrame = 0
const emoticons = new EmoticonRenderer(scheduleLayout)
let contentVisible = false
const fittedLayouts = new WeakMap<HTMLElement, string>()

function isEdgeMode(): boolean { return config?.danmakuScrollDirection === 'edge' }
function motionAllowed(): boolean { return config?.motionEnabled !== false && !reducedMotion.matches }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function safeColor(value: string | undefined, fallback: string): string {
  const color = String(value ?? '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback
}

function colorWithOpacity(hexColor: string | undefined, opacity: number, fallback: string): string {
  const hex = safeColor(hexColor, fallback).slice(1)
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${clamp(Number(opacity) || 0, 0, 1)})`
}

function appendSpan(parent: HTMLElement, className: string, text = ''): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  parent.appendChild(span)
  return span
}

function appendImage(
  parent: HTMLElement,
  className: string,
  src: string,
  alt = ''
): HTMLImageElement {
  const image = document.createElement('img')
  image.className = className
  image.src = src
  image.alt = alt
  image.loading = 'eager'
  image.decoding = 'async'
  image.referrerPolicy = 'no-referrer'
  parent.appendChild(image)
  return image
}

function isGift(payload: DanmakuPayload): boolean {
  if (payload.kind === 'fans' || payload.giftKind === 'fans') return false
  return payload.kind === 'gift' || Boolean(String(payload.giftName ?? '').trim())
}

function isWelcome(payload: DanmakuPayload): boolean {
  return payload.kind === 'welcome'
}

function hasChatModule(cfg: AppConfig, module: AppConfig['chatModules'][number]): boolean {
  return cfg.chatModules.includes(module)
}

function hasWidgetModule(cfg: AppConfig, module: AppConfig['widgetModules'][number]): boolean {
  return cfg.widgetModules.includes(module)
}

function normalizedText(payload: DanmakuPayload): string {
  const source = isGift(payload)
    ? String(payload.giftName ?? payload.text ?? '')
    : String(payload.text ?? '')
  return source.trim() || source
}

function messageKey(payload: DanmakuPayload): string {
  const text = normalizedText(payload)
  if (payload.kind === 'fans' || payload.giftKind === 'fans') return 'fans:' + (payload.userId || payload.nick) + ':' + text
  if (payload.isHighEnergy) return 'high-energy:' + (payload.userId || payload.nick) + ':' + text
  if (!isGift(payload)) return `danmaku:${text}`
  const giftIdentity = String(payload.giftId ?? '').trim() || text
  // 礼物只能合并同一个用户的同一种礼物，避免把不同观众的数量算到一起。
  return `gift:${String(payload.userId || payload.nick || '').trim()}\u0000${giftCatalogKey(giftIdentity, payload.giftCatalogType)}`
}

function safeDouyuImageUrl(value: string | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^data:image\//i.test(raw)) return raw
  try {
    const normalized = /^\/\//.test(raw)
      ? `https:${raw}`
      : /^http:\/\//i.test(raw)
        ? raw.replace(/^http:/i, 'https:')
        : raw
    const parsed = new URL(normalized, window.location.href)
    if (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'douyucdn.cn' || parsed.hostname.endsWith('.douyucdn.cn'))
    ) {
      return parsed.href
    }
  } catch {
    // 无效或非斗鱼图片地址交给本地兜底。
  }
  return null
}

function avatarUrl(value: string | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^data:image\//i.test(raw)) return raw
  if (/^\/\//.test(raw)) return safeDouyuImageUrl(`https:${raw}`)
  if (/^https?:\/\//i.test(raw)) return safeDouyuImageUrl(raw)

  // chatmsg/dgb 的 ic 常为无扩展名头像标识。
  const safePath = raw.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_./-]/g, '')
  if (!safePath || safePath.includes('..')) return null
  const suffix = /\.(?:jpe?g|png|gif|webp)$/i.test(safePath) ? '' : '_small.jpg'
  return `https://apic.douyucdn.cn/upload/${safePath}${suffix}`
}

function avatarInitial(nick: string): string {
  return Array.from(String(nick ?? '').trim())[0] ?? '观'
}

function createAvatar(payload: DanmakuPayload, extraClass = ''): HTMLSpanElement {
  const avatar = document.createElement('span')
  avatar.className = `avatar${extraClass ? ` ${extraClass}` : ''}`
  const imageUrl = avatarUrl(payload.avatar)
  if (imageUrl) {
    const image = appendImage(avatar, '', imageUrl, '')
    image.addEventListener(
      'error',
      () => {
        image.hidden = true
      },
      { once: true }
    )
  }
  appendSpan(avatar, 'avatar__fallback', avatarInitial(payload.nick))
  avatar.title = payload.nick || '观众'
  return avatar
}

function displayFansLevel(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(999, parsed) : null
}

function createFansMedal(payload: DanmakuPayload): HTMLSpanElement | null {
  const name = String(payload.fansName ?? '').trim()
  const level = displayFansLevel(payload.fansLevel)
  if (!name || level == null || level < 1) return null

  const nativeLevel = normalizeNativeFansLevel(payload.fansLevel)
  const medal = document.createElement('span')
  medal.className = 'item fans-medal'
  medal.title = `粉丝牌：${name} · ${level}级`
  medal.setAttribute('aria-label', medal.title)
  const badge = appendSpan(medal, 'fans-medal__badge')
  badge.style.backgroundImage = `url(${nativeFansMedalBackgroundUrl(nativeLevel)})`
  appendSpan(badge, 'fans-medal__level', String(level))
  appendSpan(badge, 'fans-medal__name', name)
  if (payload.isDiamond) {
    const diamond = appendImage(medal, 'fans-medal__diamond', DIAMOND_ICON_URL, '钻粉')
    diamond.addEventListener('error', () => diamond.remove(), { once: true })
  }
  return medal
}

function createUserLevel(rawLevel: string | undefined): HTMLSpanElement | null {
  const level = normalizeNativeLevel(rawLevel)
  if (level == null || level < 1) return null
  const badge = document.createElement('span')
  badge.className = 'item user-level'
  badge.style.backgroundImage = `url(${nativeUserLevelUrl(level)})`
  badge.title = `用户等级 ${level}`
  badge.setAttribute('aria-label', badge.title)
  return badge
}

function appendIdentity(info: HTMLElement, payload: DanmakuPayload, cfg: AppConfig): void {
  if (hasChatModule(cfg, 'moderator') && payload.isRoomAdmin) {
    const moderator = appendSpan(info, 'item moderator')
    moderator.style.backgroundImage = `url(${ROOM_ADMIN_ICON_URL})`
    moderator.title = '房管'
  }

  const nobleLevel = clamp(Math.round(Number(payload.nobleLevel) || 0), 0, 9)
  const nobleUrl = nobleLevel > 0 ? NOBLE_ICON_URLS[nobleLevel] : undefined
  if (hasChatModule(cfg, 'noble') && nobleUrl) {
    const noble = appendImage(info, 'item noble-icon', nobleUrl, '贵族')
    noble.title = `贵族等级 ${nobleLevel}`
    noble.addEventListener('error', () => noble.remove(), { once: true })
  } else if (hasChatModule(cfg, 'noble') && payload.isNoble) {
    const noble = appendSpan(info, 'item noble-fallback', '贵')
    noble.title = '贵族'
  }

  if (hasChatModule(cfg, 'medal')) {
    const medal = createFansMedal(payload)
    if (medal) info.appendChild(medal)
  }

  if (hasChatModule(cfg, 'level')) {
    const userLevel = createUserLevel(payload.level)
    if (userLevel) info.appendChild(userLevel)
  }
}

function giftCount(payload: DanmakuPayload): number {
  return giftQuantity(payload)
}

function createGiftImage(payload: DanmakuPayload, className = 'item gift-image'): HTMLElement {
  const imageUrl = safeDouyuImageUrl(!motionAllowed() ? payload.giftStaticImage || payload.giftImage : payload.giftImage)
  if (!imageUrl) {
    const element = document.createElement('span')
    element.className = `${className} gift-image--fallback`
    element.textContent = '礼'
    element.title = payload.giftName || '礼物'
    return element
  }

  const image = document.createElement('img')
  image.className = className
  image.src = imageUrl
  image.alt = payload.giftName || '礼物'
  image.loading = 'eager'
  image.decoding = 'async'
  image.referrerPolicy = 'no-referrer'
  image.addEventListener(
    'error',
    () => {
      const element = document.createElement('span')
      element.className = `${className} gift-image--fallback`
      element.textContent = '礼'
      element.title = payload.giftName || '礼物'
      image.replaceWith(element)
    },
    { once: true }
  )
  return image
}

function resolvedMessageColor(cfg: AppConfig, payload: DanmakuPayload): string {
  if (cfg.showDanmakuColor) {
    const nativeColor = danmakuColorForCol(payload.col)
    if (nativeColor) return nativeColor
  }
  return safeColor(cfg.commonTextColor, '#ffffff')
}

function createMessageRow(
  payload: DanmakuPayload,
  repeatCount: number,
  cfg: AppConfig
): MessageRowParts {
  const gift = isGift(payload)
  const row = document.createElement('li')
  row.className = `message-row${gift ? ' is-gift' : ''}`
  row.dataset.kind = gift ? 'gift' : payload.kind || 'danmaku'
  row.dataset.nick = payload.nick || '观众'
  row.title = gift
    ? `${payload.nick || '观众'} 送出 ${payload.giftName || '礼物'} ×${giftCount(payload)}`
    : `${payload.nick || '观众'}：${payload.text || ''}`

  if (hasChatModule(cfg, 'avatar')) row.appendChild(createAvatar(payload))
  const info = document.createElement('span')
  info.className = 'info-box'
  row.appendChild(info)

  appendIdentity(info, payload, cfg)
  if (payload.isHighEnergy) appendSpan(info, 'item high-energy-label', '高能')
  const username = appendSpan(
    info,
    `item username${payload.isSuper ? ' is-super' : ''}`,
    payload.nick || '观众'
  )
  username.title = payload.nick || '观众'
  username.style.color = safeColor(cfg.usernameTextColor, '#56e3f9')

  let messageText: HTMLSpanElement | null = null
  let repeat: HTMLSpanElement | null = null
  if (!gift) {
    messageText = appendSpan(info, 'item content')
    emoticons.render(messageText, String(payload.text ?? ''), cfg.showDouyuEmoticons && !isWelcome(payload))
    messageText.style.color = isWelcome(payload)
      ? safeColor(cfg.minorTextColor, '#bcbcbc')
      : resolvedMessageColor(cfg, payload)
    messageText.title = String(payload.text ?? '')
    repeat = appendSpan(info, 'item repeat-count', `x${repeatCount}`)
    repeat.hidden = repeatCount <= 1
  } else {
    const isOrdinaryGift = payload.giftKind === 'gift' || payload.giftKind === 'unknown' || !payload.giftKind
    if (isOrdinaryGift) {
      const action = appendSpan(info, 'item content gift-action', '送出')
      action.style.color = safeColor(cfg.minorTextColor, '#bcbcbc')
      if (hasChatModule(cfg, 'gifticon')) info.appendChild(createGiftImage(payload))
      const name = appendSpan(info, 'item gift-name', String(payload.giftName ?? '').trim() || '礼物')
      name.style.color = safeColor(cfg.giftTextColor, '#f7b500')
      name.title = name.textContent || '礼物'
      const count = giftCount(payload)
      if (count > 0) appendSpan(info, 'item gift-count', `×${count}`)
    } else {
      const action = appendSpan(
        info,
        'item content gift-action',
        String(payload.giftName ?? payload.text ?? '').trim() || '礼物消息'
      )
      action.style.color = safeColor(cfg.minorTextColor, '#bcbcbc')
    }
  }

  return { element: row, messageText, repeat }
}

function giftTotalPrice(payload: DanmakuPayload): number {
  if (payload.lotterySummary) return payload.lotterySummary.rewardValue
  if (payload.giftIsLottery) return 0
  if (payload.giftIsFree === true) return 0
  const unit = Number(payload.giftPrice)
  if (!Number.isFinite(unit) || unit <= 0) return 0
  return unit * giftCount(payload)
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function shouldHighlight(payload: DanmakuPayload, cfg: AppConfig): boolean {
  if (!isGift(payload)) return false
  if (!cfg.showFreeGifts && (payload.giftIsFree === true || payload.giftPrice === 0)) return false
  if (
    payload.giftKind === 'noble' ||
    payload.giftKind === 'diamond'
  ) {
    return true
  }
  const totalPrice = giftTotalPrice(payload)
  if (totalPrice > 0) return totalPrice >= cfg.markedFilterYuan
  // 阈值为 0 时允许显示已启用的免费礼物，以及目录尚未收录的新礼物；
  // 免费礼物不会显示金额，也不会计入礼物价值。
  return cfg.markedFilterYuan <= 0
}

function createHighlightRow(payload: DanmakuPayload, cfg: AppConfig): HTMLLIElement {
  const row = document.createElement('li')
  const summary = payload.lotterySummary
  row.className = `highlight-row${summary ? ' is-lottery' : cfg.giftLayout === 'inline' ? ' is-inline-gift' : ''}`
  row.dataset.valueTier = cfg.giftValueColors ? giftValueTier(payload) : 'neutral'
  row.title = `${payload.nick || '观众'} 送出 ${payload.giftName || '礼物'} ×${giftCount(payload)}`
  const bannerSlot = appendSpan(row, 'gift-banner-slot')
  const bannerUrl = cfg.giftOfficialBanner && safeDouyuImageUrl(payload.giftBanner)
  if (bannerUrl) {
    row.classList.add('has-official-banner')
    const banner = appendImage(bannerSlot, 'official-gift-banner', bannerUrl)
    banner.addEventListener('error', () => { banner.hidden = true; row.classList.remove('has-official-banner') }, { once: true })
  }
  if (summary) row.title += '\n投入与已收到的奖励金额分别累计；同一观众、同一活动的连续开奖合并。' +
    '\n金额随实际广播累计，不代表平台已完成结算。' +
    summary.rewards.map(reward => `\n${reward.name} ×${reward.count}：${reward.value == null ? '价格待确认' : `¥${formatMoney(reward.value) || '0'}`}`).join('')

  const top = document.createElement('div')
  top.className = 'highlight-row__top'
  row.appendChild(top)
  top.appendChild(createAvatar(payload, 'highlight-row__avatar'))

  const right = document.createElement('div')
  right.className = 'highlight-row__right'
  top.appendChild(right)

  const user = document.createElement('div')
  user.className = 'highlight-row__user'
  right.appendChild(user)
  const username = appendSpan(user, `username${payload.isSuper ? ' is-super' : ''}`, payload.nick || '观众')
  username.title = payload.nick || '观众'
  username.style.color = safeColor(cfg.usernameTextColor, '#56e3f9')
  const totalPrice = giftTotalPrice(payload)
  if (summary) {
    const knownReward = summary.rewardCount > summary.unpricedRewardCount
    const price = appendSpan(user, `highlight-row__price${!knownReward ? ' is-pending' : ''}`)
    appendSpan(price, 'gift-value-label', summary.rewardCount ? '已开' : '奖励')
    appendSpan(price, 'gift-amount', summary.rewardCount === 0 ? '待开奖' : !knownReward ? '待补价' :
      `¥${formatMoney(summary.rewardValue) || '0'}${summary.unpricedRewardCount ? '+' : ''}`)
    price.title = `已收到 ${summary.rewardCount} 件奖励${summary.unpricedRewardCount ? `，其中 ${summary.unpricedRewardCount} 件待补价` : ''}`
  }
  else if (totalPrice > 0) {
    const price = appendSpan(user, 'highlight-row__price')
    appendSpan(price, 'gift-amount', `¥${formatMoney(totalPrice)}`)
    price.title = payload.giftPriceSource === 'manual' ? '按手动补价计算' : '按斗鱼目录价格计算'
  }
  else if (payload.giftIsLottery) appendSpan(user, 'highlight-row__price is-pending', '待开奖')
  else if (payload.giftIsFree || payload.giftPrice === 0) appendSpan(user, 'highlight-row__price is-pending', '免费')
  else if (payload.giftKind === 'unknown') appendSpan(user, 'highlight-row__price is-pending', '待补价')

  const gift = document.createElement('div')
  gift.className = 'highlight-row__gift'
  right.appendChild(gift)
  const isOrdinaryGift = payload.giftKind === 'gift' || payload.giftKind === 'unknown' || !payload.giftKind
  if (isOrdinaryGift) {
    const art = appendSpan(top, 'gift-art')
    art.appendChild(createGiftImage(payload, 'gift-image'))
    appendSpan(art, 'gift-effect-host')
    const name = appendSpan(gift, 'gift-name', String(payload.giftName ?? '').trim() || '礼物')
    name.title = name.textContent || '礼物'
    name.style.color = safeColor(cfg.giftTextColor, '#f7b500')
    const count = giftCount(payload)
    if (count > 0) appendSpan(gift, 'gift-count', `×${count}`)
  } else {
    appendSpan(
      gift,
      'gift-action',
      String(payload.giftName ?? payload.text ?? '').trim() || '礼物消息'
    )
  }

  if (summary) {
    const input = appendSpan(gift, 'gift-cost')
    appendSpan(input, 'gift-value-label', '投入')
    appendSpan(input, 'gift-amount', summary.inputCount === 0 ? '待关联' :
      summary.inputValue == null ? '待确认' : `¥${formatMoney(summary.inputValue) || '0'}`)
    input.title = summary.inputCount ? `投入 ${summary.inputCount} 份` : '尚未收到对应投入广播'
    if (summary.rewards.length) {
      const rewards = appendSpan(row, 'lottery-rewards')
      for (const item of summary.rewards) appendSpan(rewards, 'lottery-reward-item', `${item.name} ×${item.count}${item.value == null ? ' · 待补价' : ''}`)
    }
    if (summary.unpricedRewardCount) appendSpan(row, 'gift-pending-note', `${summary.unpricedRewardCount} 件待补价 · 金额自动更新`)
  } else if (payload.lotteryUnmatched) {
    appendSpan(row, 'gift-pending-note', '奖励已记录 · 暂未关联到对应投入')
  }

  return row
}

/** 更新数字与图片属性时保留原节点，避免连击、补价重新播放进场和 GIF。 */
function patchVisualChildren(target: Element, source: Element): void {
  // 播放器自管 canvas 生命周期，补价/连击只更新旁边的文本和官方图片。
  if (target.classList.contains('gift-effect-host')) return
  const next = [...source.childNodes]
  for (let index = 0; index < next.length; index += 1) {
    const node = next[index]!
    const old = target.childNodes[index]
    if (!old) { target.appendChild(node); continue }
    if (old.nodeType !== node.nodeType || (old instanceof Element && node instanceof Element && old.tagName !== node.tagName)) {
      old.replaceWith(node)
    } else if (old instanceof Element && node instanceof Element) {
      if (old.classList.contains('gift-art') && old.classList.contains('is-playing')) node.classList.add('is-playing')
      for (const name of old.getAttributeNames()) if (!node.hasAttribute(name)) old.removeAttribute(name)
      for (const name of node.getAttributeNames()) {
        const value = node.getAttribute(name)!
        if (old.getAttribute(name) !== value) old.setAttribute(name, value)
      }
      patchVisualChildren(old, node)
    } else if (old.nodeValue !== node.nodeValue) old.nodeValue = node.nodeValue
  }
  while (target.childNodes.length > next.length) target.lastChild!.remove()
}

function updateHighlightVisual(entry: HighlightEntry, cfg: AppConfig): void {
  const next = createHighlightRow(entry.payload, cfg)
  entry.element.title = next.title
  entry.element.classList.toggle('is-lottery', Boolean(entry.payload.lotterySummary))
  entry.element.classList.toggle('is-inline-gift', next.classList.contains('is-inline-gift'))
  entry.element.classList.toggle('has-official-banner', next.classList.contains('has-official-banner'))
  entry.element.dataset.valueTier = next.dataset.valueTier
  patchVisualChildren(entry.element, next)
  fittedLayouts.delete(entry.element)
}

/** 到时先淡出并保留占位，结束后再释放；容量裁剪仍立即移除，保证不叠行。 */
function fadeOut(element: HTMLElement, remove: () => void): void {
  if (exitAnimations.has(element)) return
  if (reducedMotion.matches || config?.motionEnabled === false) { remove(); return }
  const edge = edgeStageOf(element)
  const frames = edge
    ? [edge.freeze(element), { transform: edge.travel, opacity: 0 }]
    : [{ opacity: getComputedStyle(element).opacity }, { opacity: 0 }]
  const animation = element.animate(frames, {
    duration: (edge ? EDGE_EXIT_MS : EXIT_FADE_MS) / motionSpeedScale(config?.speedPxPerSec),
    easing: edge ? EDGE_EXIT_EASING : 'ease-out', fill: 'forwards'
  })
  element.classList.add('is-leaving')
  exitAnimations.set(element, animation)
  animation.onfinish = () => {
    if (exitAnimations.get(element) !== animation) return
    // 动画回调可能位于 RAF 之后。把移除并入下一帧的插入/裁剪事务，避免先跳一帧再补偿。
    completedExits.set(element, () => { remove(); animation.cancel(); scheduleLayout() })
  }
}

function cancelFade(element: HTMLElement, resume = false): void {
  completedExits.delete(element)
  const animation = exitAnimations.get(element)
  const stage = edgeStageOf(element)
  const from = resume && animation && stage ? stage.freeze(element) : undefined
  exitAnimations.delete(element)
  animation?.cancel()
  element.classList.remove('is-leaving')
  if (from) stage!.reveal(element, from)
}

function removeCommon(entry: CommonEntry, animate = false): void {
  if (animate) { fadeOut(entry.parts.element, () => removeCommon(entry)); return }
  cancelFade(entry.parts.element)
  edgeStage.unmount(entry.parts.element)
  const index = commonEntries.indexOf(entry)
  if (index >= 0) commonEntries.splice(index, 1)
  entry.parts.element.remove()
}

function removeHighlight(entry: HighlightEntry, animate = false, discard = true): void {
  if (animate) { fadeOut(entry.element, () => removeHighlight(entry)); return }
  cancelFade(entry.element)
  edgeStage.unmount(entry.element)
  if (discard) giftPresentation.retire(entry.sourceIds)
  const index = highlightEntries.indexOf(entry)
  if (index >= 0) highlightEntries.splice(index, 1)
  entry.element.remove()
  highlightPane.hidden = highlightEntries.length === 0
}

function removeMoving(entry: MovingEntry): void {
  const index = movingEntries.indexOf(entry)
  if (index >= 0) movingEntries.splice(index, 1)
  entry.parts.element.remove()
}

function replaceEdgeElement(element: HTMLElement): void {
  const frame = edgeStage.freeze(element)
  const common = commonEntries.find(entry => entry.parts.element === element)
  const gift = highlightEntries.find(entry => entry.element === element)
  if (common) removeCommon(common)
  else if (gift) removeHighlight(gift)
  else { edgeStage.unmount(element); element.remove() }
  edgeStage.exitReplaced(element, frame)
}

function scheduleLayout(): void {
  if (layoutFrame) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    performLayout()
  })
}

function performLayout(): void {
  if (isEdgeMode()) {
    const statusSpace = statusBar.hidden ? 0 : statusBar.offsetHeight + (config?.edgeMessageGap ?? 8)
    edgeLayer.style.top = `${config?.edgeStatusPosition === 'top' ? statusSpace : 0}px`
    edgeLayer.style.bottom = `${config?.edgeStatusPosition === 'bottom' ? statusSpace : 0}px`
    edgeStage.layout()
    return
  }
  const statusSpace = statusBar.hidden ? 0 : statusBar.offsetHeight + (parseFloat(getComputedStyle(statusBar).marginTop) || 0)
  root.style.setProperty('--status-space', `${statusSpace}px`)
  pruneHighlightsToBounds()
  const reserved = config?.danmakuScrollDirection !== 'verticalUp'
    ? statusSpace + (!highlightPane.hidden ? highlightPane.offsetHeight + 4 : 0) : 0
  movingLayer.style.bottom = `${reserved}px`
  if (config?.danmakuScrollDirection === 'verticalUp') pruneStreamToBounds()
  else reflowMovingEntries()
  softenLayoutMovement()
}

/** 先完成真实布局与裁剪，再用位移缓动衔接旧位置；测量始终使用真实尺寸。 */
function softenLayoutMovement(): void {
  const enabled = config?.motionEnabled !== false && !reducedMotion.matches
  for (const [list, flow] of listFlows) {
    const positions: FlowLayout['positions'] = new Map()
    let anchor: { previous: number; next: number } | undefined
    let sizeChanged = false
    for (const element of Array.from(list.children) as HTMLElement[]) {
      const rect = element.getBoundingClientRect()
      const next = { top: rect.top - flow.state.offset, width: rect.width, height: rect.height }
      positions.set(element, next)
      const previous = flow.positions.get(element)
      if (!previous) continue
      if (Math.abs(previous.width - next.width) > 0.5 || Math.abs(previous.height - next.height) > 0.5) sizeChanged = true
      anchor = { previous: previous.top, next: next.top }
    }
    flow.positions = positions
    if (!enabled || sizeChanged || !anchor) flow.state = { offset: 0, velocity: 0, acceleration: 0 }
    else {
      const delta = anchor.previous - anchor.next
      // 目标没变时只保留现有轨迹，统计刷新、ResizeObserver 不再重启动画。
      flow.state = retargetFlowMotion(flow.state, delta)
    }
    list.style.setProperty('--flow-offset', `${flow.state.offset}px`)
  }
}

function advanceListMotion(dt: number): void {
  const enabled = config?.motionEnabled !== false && !reducedMotion.matches
  for (const [list, flow] of listFlows) {
    if (!flow.state.offset && !flow.state.velocity) continue
    flow.state = enabled ? advanceFlowMotion(flow.state, dt, config?.speedPxPerSec) : { offset: 0, velocity: 0, acceleration: 0 }
    list.style.setProperty('--flow-offset', `${flow.state.offset}px`)
  }
}

/** 超长消息放不下时只缩小这一条，字号、头像和字距按相同比例适配。 */
function fitEntryToHeight(element: HTMLElement, availableHeight: number): void {
  if (!config || availableHeight <= 0) return
  const baseSize = element.classList.contains('highlight-row') && !element.classList.contains('is-inline-gift')
    ? clamp(config.fontSize * .85, 12, 22) : config.fontSize
  const width = element.parentElement?.clientWidth || root.clientWidth
  const key = [baseSize, config.avatarSize, config.fansMedalScale, config.userLevelScale, config.nicknameScale,
    config.letterSpacing, config.lineHeight, config.giftAmountScale, width, Math.floor(availableHeight)].join(':')
  if (fittedLayouts.get(element) === key) return
  fittedLayouts.set(element, key)
  const applySize = (size: number): void => {
    const scale = size / baseSize
    element.style.fontSize = `${size}px`
    element.style.setProperty('--avatar-size', `${config!.avatarSize * scale}px`)
    element.style.setProperty('--letter-spacing', `${config!.letterSpacing * scale}px`)
    element.dataset.fitScale = scale.toFixed(3)
    // 金额作为整体缩放，窄窗口和大字号下也不把 ¥100 拆成两行。
    const amounts = [...element.querySelectorAll<HTMLElement>('.gift-amount')]
    for (const amount of amounts) amount.style.fontSize = ''
    const amountScale = Math.min(1, ...amounts.filter(amount => amount.clientWidth > 0)
      .map(amount => amount.clientWidth / Math.max(1, amount.scrollWidth)))
    if (amountScale < 1) for (const amount of amounts) {
      amount.style.fontSize = `${Math.floor(parseFloat(getComputedStyle(amount).fontSize) * amountScale * 10) / 10}px`
    }
    // 徽章作为完整的一组缩放，避免长牌名把原生底图拉成两行。
    const info = element.querySelector<HTMLElement>('.info-box')
    if (info) for (const medal of info.querySelectorAll<HTMLElement>('.fans-medal')) {
      medal.style.fontSize = ''
      const style = getComputedStyle(medal)
      const availableWidth = info.clientWidth - parseFloat(style.marginRight) - 1
      const gap = parseFloat(style.columnGap) || 0
      const naturalWidth = [...medal.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + gap * (medal.children.length - 1)
      if (availableWidth > 0 && naturalWidth > availableWidth) {
        medal.style.fontSize = `${parseFloat(style.fontSize) * availableWidth / naturalWidth}px`
      }
    }
  }
  const height = (): number => {
    const style = getComputedStyle(element)
    return Math.max(element.offsetHeight, element.scrollHeight) + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  }
  const fits = (): boolean => height() <= availableHeight &&
    (!element.classList.contains('highlight-row') ||
      [...element.querySelectorAll<HTMLElement>('.highlight-row__top, .highlight-row__right')]
        .every(part => part.scrollWidth <= part.clientWidth + 1))
  applySize(baseSize)
  if (fits()) return
  let low = Math.min(12, baseSize)
  let high = baseSize
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const middle = (low + high) / 2
    applySize(middle)
    if (!fits()) high = middle
    else low = middle
  }
  applySize(Math.floor(low * 10) / 10)
}

function pruneHighlightsToBounds(): void {
  if (isEdgeMode()) return
  if (!highlightEntries.length) return
  const padding = getComputedStyle(highlightList)
  const available = Math.floor(root.clientHeight * 0.46) - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - 2
  for (const entry of highlightEntries) fitEntryToHeight(entry.element, available)
  // scrollHeight 会包含进场/位移动画的 transform；offsetHeight 只反映真实排版。
  while (highlightEntries.length > 0 && highlightList.offsetHeight > highlightPane.clientHeight + 1) {
    removeHighlight(highlightEntries[0]!)
  }
}

function pruneStreamToBounds(): void {
  if (config?.danmakuScrollDirection !== 'verticalUp') return
  pruneHighlightsToBounds()
  const padding = getComputedStyle(messageList)
  const available = messagePane.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - 2
  for (const entry of commonEntries) fitEntryToHeight(entry.parts.element, available)

  while (
    commonEntries.length > 0 &&
    messageList.offsetHeight > messagePane.clientHeight + 1
  ) {
    removeCommon(commonEntries[0]!)
  }
}

function commonExpiry(queuedAt: number, cfg: AppConfig): number {
  if (cfg.danmakuScrollDirection === 'edge') return Infinity
  return cfg.commonTimeSec <= 0 ? Number.POSITIVE_INFINITY : queuedAt + cfg.commonTimeSec * 1_000
}

function highlightExpiry(shownAt: number, cfg: AppConfig): number {
  if (cfg.danmakuScrollDirection === 'edge') return Infinity
  return cfg.markedTimeSec <= 0
    ? Number.POSITIVE_INFINITY
    : shownAt + cfg.markedTimeSec * 1_000
}

function appendHighlight(item: PresentedGift, cfg: AppConfig): boolean {
  const element = createHighlightRow(item.payload, cfg)
  element.dataset.giftKey = item.key
  if (isEdgeMode()) {
    if (!edgeStage.mount(element)) return false
  } else highlightList.appendChild(element)
  highlightEntries.push({
    ...item,
    element,
    shownAt: Date.now(),
    signature: JSON.stringify(item.payload),
    expiresAt: highlightExpiry(Math.max(Date.now(), item.updatedAt), cfg)
  })
  highlightPane.hidden = false
  return true
}

function syncGiftHighlights(now: number): void {
  if (!config) return
  giftRenderDirty = false
  const items = giftPresentation.snapshot(config.giftFold)
  const keys = new Set(items.map(item => item.key))
  let changed = false
  for (const entry of [...highlightEntries]) {
    // 晚到的目录把多种奖励识别成同一组时，仅撤下被合并的卡片，保留分项。
    if (!keys.has(entry.key)) { removeHighlight(entry, false, false); changed = true }
  }
  for (const item of items) {
    const entry = highlightEntries.find(candidate => candidate.key === item.key)
    const expiresAt = highlightExpiry(Math.max(entry?.shownAt || now, item.updatedAt), config)
    if (!isEdgeMode() && expiresAt <= now) {
      if (entry) removeHighlight(entry, true)
      else giftPresentation.retire(item.sourceIds)
      continue
    }
    if (!hasWidgetModule(config, 'highlight') || !shouldHighlight(item.payload, config)) {
      if (entry) { removeHighlight(entry, false, false); changed = true }
      // 未达到门槛的分项短时保留，允许后续开奖或补价达到门槛。
      if (now - item.updatedAt > 120_000) giftPresentation.discard(item.sourceIds)
      continue
    }
    const signature = JSON.stringify(item.payload)
    if (entry) {
      const receivedMore = item.updatedAt !== entry.updatedAt
      const updated = signature !== entry.signature || receivedMore
      Object.assign(entry, item, { signature, expiresAt })
      if (updated) {
        // 新礼物或开奖可续时；只补价格、图片不重播进场，也不延长顶部停留。
        if (receivedMore) {
          cancelFade(entry.element, true)
          edgeStage.refreshGiftHold(entry.element, now)
        }
        entry.expiresAt = highlightExpiry(Math.max(entry.shownAt, item.updatedAt), config)
        updateHighlightVisual(entry, config)
        changed = true
      }
    } else {
      if (appendHighlight(item, config)) changed = true
      else if (isEdgeMode()) giftPresentation.retire(item.sourceIds)
      else giftRenderDirty = true
    }
  }
  if (!isEdgeMode()) for (const entry of highlightEntries.slice(0, Math.max(0, highlightEntries.length - config.markedTotal))) removeHighlight(entry)
  if (changed) { scheduleLayout(); updateContentVisibility() }
}

function appendCommon(item: PendingMessage, cfg: AppConfig): boolean {
  const parts = createMessageRow(item.payload, item.count, cfg)
  if (isEdgeMode()) {
    if (!edgeStage.mount(parts.element)) return false
  } else messageList.appendChild(parts.element)
  const shownAt = Date.now()
  commonEntries.push({ ...item, parts, shownAt, expiresAt: commonExpiry(shownAt, cfg) })
  if (!isEdgeMode()) while (commonEntries.length > cfg.commonTotal) removeCommon(commonEntries[0]!)
  // 新消息的这一帧就完成边界裁剪，避免高速消息流中短暂露出半行。
  pruneStreamToBounds()
  return true
}

function replaceCommonVisual(entry: CommonEntry, cfg: AppConfig): void {
  const nextParts = createMessageRow(entry.payload, entry.count, cfg)
  if (edgeStage.has(entry.parts.element)) {
    patchVisualChildren(entry.parts.element, nextParts.element)
    entry.parts.messageText = entry.parts.element.querySelector('.content')
    entry.parts.repeat = entry.parts.element.querySelector('.repeat-count')
    fittedLayouts.delete(entry.parts.element)
    return
  }
  nextParts.element.classList.add('is-static')
  entry.parts.element.replaceWith(nextParts.element)
  entry.parts = nextParts
}

function replaceMovingVisual(entry: MovingEntry, cfg: AppConfig): void {
  const nextParts = createMessageRow(entry.payload, entry.count, cfg)
  nextParts.element.classList.add('is-static')
  nextParts.element.style.maxWidth = `${Math.max(120, movingLayer.clientWidth)}px`
  nextParts.element.style.transform = `translate3d(${Math.round(entry.x)}px, ${Math.round(entry.y)}px, 0)`
  entry.parts.element.replaceWith(nextParts.element)
  entry.parts = nextParts
  const rect = nextParts.element.getBoundingClientRect()
  entry.width = Math.ceil(rect.width)
  entry.height = Math.ceil(rect.height)
}

function mergeIntoActive(
  item: PendingMessage,
  now: number,
  cfg: AppConfig,
  windowMs = Math.max(1, cfg.duplicateMergeWindowSec) * 1000
): boolean {
  const common = [...commonEntries]
    .reverse()
    .find((entry) => entry.key === item.key && now - entry.lastMergeAt <= windowMs && !exitAnimations.has(entry.parts.element))
  if (common) {
    common.count += 1
    common.lastMergeAt = now
    if (common.parts.repeat) {
      common.parts.repeat.textContent = `x${common.count}`
      common.parts.repeat.hidden = false
    }
    scheduleLayout()
    return true
  }

  const moving = [...movingEntries]
    .reverse()
    .find((entry) => entry.key === item.key && now - entry.lastMergeAt <= windowMs)
  if (moving) {
    moving.count += 1
    moving.lastMergeAt = now
    if (moving.parts.repeat) {
      moving.parts.repeat.textContent = `x${moving.count}`
      moving.parts.repeat.hidden = false
    }
    scheduleLayout()
    return true
  }
  return false
}

function isAlreadyInFlight(key: string): boolean {
  return (
    pendingMessages.some((entry) => entry.key === key) ||
    commonEntries.some((entry) => entry.key === key && !exitAnimations.has(entry.parts.element)) ||
    movingEntries.some((entry) => entry.key === key)
  )
}

function enqueueDanmaku(payload: DanmakuPayload): void {
  if (!config || !normalizedText(payload)) return
  if (isWelcome(payload) && !config.showWelcome) return
  // 同一批广播也保留接收顺序，礼物不会越过同帧内先到的弹幕。
  const now = Math.max(Date.now(), lastDisplayEventAt + 0.01)
  lastDisplayEventAt = now
  if (isGift(payload)) {
    if (!hasWidgetModule(config, 'highlight')) return
    giftPresentation.add(payload, now)
    giftRenderDirty = true
    if (isEdgeMode()) syncGiftHighlights(now)
    return
  }
  trimPendingDisplay(now)
  const item: PendingMessage = {
    key: messageKey(payload),
    payload,
    count: 1,
    queuedAt: now,
    lastMergeAt: now
  }

  if (config.chatFold && !isGift(payload) && !isWelcome(payload) && isAlreadyInFlight(item.key)) {
    return
  }

  if (config.duplicateDanmakuMode === 'once' && isAlreadyInFlight(item.key)) return

  if (config.duplicateDanmakuMode === 'merge') {
    if (mergeIntoActive(item, now, config)) return
    const windowMs = Math.max(1, config.duplicateMergeWindowSec) * 1000
    const queued = [...pendingMessages]
      .reverse()
      .find((entry) => entry.key === item.key && now - entry.lastMergeAt <= windowMs)
    if (queued) {
      queued.count += 1
      queued.lastMergeAt = now
      return
    }
  }

  if (isEdgeMode()) {
    appendCommon(item, config)
    scheduleLayout()
  } else pendingMessages.push(item)
}

function trimPendingDisplay(now: number): void {
  if (isEdgeMode()) return
  // 展示跟上当前直播，不积压数十秒后再高速倾倒；采集统计在主进程逐条完成。
  const limit = Math.min(100, Math.max(24, (config?.commonTotal || 12) * 3))
  while (pendingMessages.length && (pendingMessages.length >= limit || now - pendingMessages[0]!.queuedAt > 4_000)) {
    pendingMessages.shift()
  }
}

function movingCollision(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  direction: AppConfig['danmakuScrollDirection']
): boolean {
  if (direction === 'horizontal') {
    const verticalOverlap = a.y < b.y + b.height && a.y + a.height > b.y
    const horizontalOverlap =
      a.x < b.x + b.width + MOVING_GAP_PX &&
      a.x + a.width + MOVING_GAP_PX > b.x
    return verticalOverlap && horizontalOverlap
  }
  const horizontalOverlap = a.x < b.x + b.width && a.x + a.width > b.x
  const verticalOverlap =
    a.y < b.y + b.height + MOVING_GAP_PX &&
    a.y + a.height + MOVING_GAP_PX > b.y
  return horizontalOverlap && verticalOverlap
}

function movingLaneMetrics(
  direction: AppConfig['danmakuScrollDirection'],
  rowWidth: number,
  rowHeight: number,
  cfg: AppConfig
): { laneCount: number; laneSize: number } {
  if (direction === 'horizontal') {
    const laneSize = Math.max(1, rowHeight + Math.max(0, cfg.lanePadding))
    return { laneCount: Math.max(1, Math.floor(movingLayer.clientHeight / laneSize)), laneSize }
  }
  const laneSize = Math.max(220, rowWidth + Math.max(0, cfg.lanePadding) * 2)
  return { laneCount: Math.max(1, Math.floor(movingLayer.clientWidth / laneSize)), laneSize }
}

function positionMovingElement(entry: MovingEntry): void {
  entry.parts.element.style.transform = `translate3d(${entry.x.toFixed(2)}px, ${entry.y.toFixed(2)}px, 0)`
  // 在完全离开边缘前淡出，不覆盖负责移动的 transform，也不改变碰撞占位。
  const remaining = config?.danmakuScrollDirection === 'horizontal'
    ? entry.x + entry.width : movingLayer.clientHeight - entry.y
  const fadeDistance = Math.max(48, (config?.speedPxPerSec || 100) * EXIT_FADE_MS / 1_000)
  entry.parts.element.style.opacity = reducedMotion.matches || config?.motionEnabled === false ? '1' : String(clamp(remaining / fadeDistance, 0, 1))
}

function spawnMoving(item: PendingMessage, cfg: AppConfig): boolean {
  const parts = createMessageRow(item.payload, item.count, cfg)
  parts.element.style.maxWidth = `${Math.max(120, movingLayer.clientWidth)}px`
  movingLayer.appendChild(parts.element)
  fitEntryToHeight(parts.element, movingLayer.clientHeight - 2)
  const rect = parts.element.getBoundingClientRect()
  const width = Math.max(1, Math.ceil(rect.width))
  const height = Math.max(1, Math.ceil(rect.height))
  const direction = cfg.danmakuScrollDirection
  const { laneCount, laneSize } = movingLaneMetrics(direction, width, height, cfg)

  for (let lane = 0; lane < laneCount; lane += 1) {
    const x = direction === 'horizontal' ? movingLayer.clientWidth : lane * laneSize
    const y = direction === 'horizontal' ? lane * laneSize : -height
    const candidate = { x, y, width, height }
    if (movingEntries.some((entry) => movingCollision(candidate, entry, direction))) continue
    const entry: MovingEntry = {
      ...item,
      parts,
      createdAt: Date.now(),
      x,
      y,
      width,
      height,
      lane
    }
    movingEntries.push(entry)
    positionMovingElement(entry)
    return true
  }

  parts.element.remove()
  return false
}

function reflowMovingEntries(): void {
  if (!config || config.danmakuScrollDirection === 'verticalUp' || isEdgeMode()) return
  const direction = config.danmakuScrollDirection
  const byNewest = [...movingEntries].sort((a, b) => b.createdAt - a.createdAt)
  const survivors: MovingEntry[] = []

  for (const entry of byNewest) {
    entry.parts.element.style.maxWidth = `${Math.max(120, movingLayer.clientWidth)}px`
    fitEntryToHeight(entry.parts.element, movingLayer.clientHeight - 2)
    const rect = entry.parts.element.getBoundingClientRect()
    entry.width = Math.max(1, Math.ceil(rect.width))
    entry.height = Math.max(1, Math.ceil(rect.height))
    const { laneCount, laneSize } = movingLaneMetrics(
      direction,
      entry.width,
      entry.height,
      config
    )
    let placed = false
    for (let lane = 0; lane < laneCount; lane += 1) {
      const x = direction === 'horizontal' ? Math.min(entry.x, movingLayer.clientWidth) : lane * laneSize
      const y = direction === 'horizontal' ? lane * laneSize : entry.y
      const candidate = { x, y, width: entry.width, height: entry.height }
      if (survivors.some((other) => movingCollision(candidate, other, direction))) continue
      entry.lane = lane
      entry.x = x
      entry.y = y
      positionMovingElement(entry)
      survivors.push(entry)
      placed = true
      break
    }
    if (!placed) entry.parts.element.remove()
  }

  movingEntries.length = 0
  movingEntries.push(...survivors.sort((a, b) => a.createdAt - b.createdAt))
}

function processIncoming(animationTs: number): void {
  if (!config || isEdgeMode() || animationTs < nextIncomingAt) return
  trimPendingDisplay(Date.now())
  if (!pendingMessages.length) return
  const stream = config.danmakuScrollDirection === 'verticalUp'
  const averageHeight = commonEntries.length
    ? commonEntries.reduce((sum, entry) => sum + entry.parts.element.offsetHeight + config!.lanePadding, 0) / commonEntries.length
    : Math.max(config.avatarSize, config.fontSize * config.lineHeight)
  const capacity = Math.max(1, Math.floor(messagePane.clientHeight / Math.max(1, averageHeight)))
  const count = stream ? incomingBatchSize(pendingMessages.length, capacity) : 1
  const backlogLimit = Math.max(8, count * 8)
  if (stream && pendingMessages.length > backlogLimit) {
    pendingMessages.splice(0, pendingMessages.length - backlogLimit)
  }
  for (let index = 0; index < count && pendingMessages.length; index += 1) {
    const item = pendingMessages[0]!
    if (stream) appendCommon(item, config)
    else if (!spawnMoving(item, config)) { nextIncomingAt = animationTs + 80; return }
    pendingMessages.shift()
  }
  nextIncomingAt = animationTs + (pendingMessages.length > 4 ? 180 : NORMAL_INCOMING_INTERVAL_MS)
  scheduleLayout()
}

function pruneExpired(now: number): void {
  if (isEdgeMode() && config) {
    for (const entry of [...commonEntries]) {
      const readableAt = Math.max(entry.shownAt, edgeStage.readableAt(entry.parts.element))
      if (edgeReadComplete(readableAt, now, config.edgeHoldSec)) removeCommon(entry, true)
    }
    for (const entry of [...highlightEntries]) {
      if (edgeStage.isPinnedGift(entry.element)) {
        if (edgeStage.giftHoldComplete(entry.element, now)) removeHighlight(entry, true)
      } else {
        const readableAt = Math.max(entry.shownAt, entry.updatedAt, edgeStage.readableAt(entry.element))
        if (edgeStage.isHead(entry.element) && edgeReadComplete(readableAt, now, config.edgeHoldSec)) {
          if (edgeStage.holdGift(entry.element, now)) scheduleLayout()
          else removeHighlight(entry, true)
        }
      }
    }
    return
  }
  for (let index = commonEntries.length - 1; index >= 0; index -= 1) {
    const entry = commonEntries[index]!
    if (entry.expiresAt <= now) removeCommon(entry, true)
  }
  for (let index = highlightEntries.length - 1; index >= 0; index -= 1) {
    const entry = highlightEntries[index]!
    if (entry.expiresAt <= now) removeHighlight(entry, true)
  }
}

function advanceMoving(dt: number, cfg: AppConfig): void {
  if (cfg.danmakuScrollDirection === 'verticalUp' || isEdgeMode() || dt <= 0) return
  const distance = Math.max(1, cfg.speedPxPerSec) * dt
  for (let index = movingEntries.length - 1; index >= 0; index -= 1) {
    const entry = movingEntries[index]!
    if (cfg.danmakuScrollDirection === 'horizontal') {
      entry.x -= distance
      if (entry.x + entry.width < 0) {
        removeMoving(entry)
        continue
      }
    } else {
      entry.y += distance
      if (entry.y > movingLayer.clientHeight) {
        removeMoving(entry)
        continue
      }
    }
    positionMovingElement(entry)
  }
}

const STATUS_LABELS: Record<OverlayStatusMetric, string> = {
  noble: '贵宾',
  danmakuUsers: '弹幕人数',
  danmakuCount: '弹幕',
  giftCount: '礼物',
  giftValue: '礼物价值'
}

function statusMetricValue(metric: OverlayStatusMetric): number | null {
  return stats[metric]
}

function formatStatusValue(metric: OverlayStatusMetric, value: number): string {
  if (metric === 'giftValue') return `￥${formatMoney(value) || '0'}${stats.unknownGiftCount ? '+' : ''}`
  if (metric === 'danmakuUsers' && stats.unidentifiedChatCount) return `≥${Math.floor(value)}`
  return String(Math.floor(value))
}

function renderStatusItem(
  metric: OverlayStatusMetric | undefined,
  wrapper: HTMLElement,
  label: HTMLElement,
  value: HTMLElement,
  change: HTMLElement
): void {
  const count = metric ? statusMetricValue(metric) : null
  const visible = Boolean(metric && count != null && Number.isFinite(count) && count >= 0)
  wrapper.hidden = !visible
  if (!visible || !metric || count == null) return
  label.textContent = STATUS_LABELS[metric]
  value.textContent = formatStatusValue(metric, count)
  wrapper.dataset.metric = metric
  wrapper.title = `${STATUS_LABELS[metric]}：${value.textContent}。统计本次运行在当前房间实际收到的消息。`
  if (metric === 'giftValue' && stats.unknownGiftCount) wrapper.title += `另有 ${stats.unknownGiftCount} 件礼物待确认价格，确认后自动补计。`
  if (metric === 'danmakuUsers' && stats.unidentifiedChatCount) wrapper.title += `有 ${stats.unidentifiedChatCount} 条消息缺少用户 ID，人数只显示可确认的下限。`
  const diff = statDiffs.get(metric) ?? 0
  change.hidden = diff === 0
  change.classList.toggle('is-positive', diff > 0)
  const formattedDiff = metric === 'giftValue'
    ? `￥${formatMoney(Math.abs(diff)) || '0'}`
    : String(Math.floor(Math.abs(diff)))
  change.textContent = diff === 0
    ? ''
    : `${diff > 0 ? '+' : '-'}${formattedDiff} ${diff > 0 ? '↑' : '↓'}`
}

function renderStats(): void {
  const enabled = Boolean(config && hasWidgetModule(config, 'status') && (!isEdgeMode() || config.edgeStatusMode !== 'hidden'))
  statusBar.hidden = !enabled
  statusPrimary.style.fontSize = ''
  statusRotating.style.fontSize = ''
  const available = config
    ? config.statusMetrics.filter((metric) => {
        const value = statusMetricValue(metric)
        return value != null && Number.isFinite(value) && value >= 0
      })
    : []
  const narrow = root.clientWidth <= 330
  const primaryMetric = !narrow ? available[0] : undefined
  const rotatingPool = narrow ? available : available.slice(1)
  const rotatingMetric = rotatingPool.length
    ? rotatingPool[statusRotationIndex % rotatingPool.length]
    : undefined

  renderStatusItem(
    primaryMetric,
    statusPrimary,
    statusPrimaryLabel,
    statusPrimaryValue,
    statusPrimaryChange
  )
  renderStatusItem(
    rotatingMetric,
    statusRotating,
    statusRotatingLabel,
    statusRotatingValue,
    statusRotatingChange
  )
  if (enabled) {
    const items = statusBar.querySelector<HTMLElement>('.status-bar__items')!
    if (!statusPrimary.hidden && !statusRotating.hidden &&
        statusPrimary.scrollWidth + statusRotating.scrollWidth + 16 > items.clientWidth) {
      // 大字号、长金额或窄窗口时，一次显示一个完整指标，避免截掉金额末位。
      renderStatusItem(undefined, statusPrimary, statusPrimaryLabel, statusPrimaryValue, statusPrimaryChange)
      renderStatusItem(available[statusRotationIndex % available.length], statusRotating, statusRotatingLabel, statusRotatingValue, statusRotatingChange)
    }
    statusBar.classList.toggle('is-single-stat', statusPrimary.hidden || statusRotating.hidden)
    for (const [item, change] of [[statusPrimary, statusPrimaryChange], [statusRotating, statusRotatingChange]]) {
      if (item!.hidden || item!.clientWidth <= 0) continue
      if (item!.scrollWidth > item!.clientWidth + 1) change!.hidden = true
      if (item!.scrollWidth > item!.clientWidth + 1) {
        item!.style.fontSize = `${Math.max(10, Math.floor((config?.statusFontSize || 14) * item!.clientWidth / item!.scrollWidth * 10) / 10)}px`
      }
    }
  }
  updateStatusVisibility()
  statusBar.dataset.source = stats.source || 'live'
  statusBar.title = stats.source === 'simulate' ? '测试模式：以下统计由模拟消息实际累加' : '本次运行接收统计；重连保留，不含启动前和断线期间未收到的数据'
  unlockIndicator.hidden = isEdgeMode() || config?.clickThrough !== false
  scheduleLayout()
}

function sameModules(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function updateStatusVisibility(): void {
  const visible = isEdgeMode() ? config?.edgeStatusMode === 'always' || (config?.edgeStatusMode === 'active' && contentVisible)
    : Boolean(config?.statusAlwaysVisible || contentVisible)
  statusBar.classList.toggle('is-idle-hidden', !visible)
  statusBar.setAttribute('aria-hidden', String(statusBar.hidden || !visible))
}

function updateContentVisibility(): void {
  const hasMoving = movingEntries.some(entry => entry.x < movingLayer.clientWidth &&
    entry.x + entry.width > 0 && entry.y < movingLayer.clientHeight && entry.y + entry.height > 0)
  const next = commonEntries.length > 0 || highlightEntries.length > 0 || hasMoving
  if (next === contentVisible) return
  contentVisible = next
  root.classList.toggle('has-content', next)
  updateStatusVisibility()
}

function needsConfigLayout(previous: AppConfig | null, next: AppConfig): boolean {
  if (!previous) return true
  const keys: (keyof AppConfig)[] = ['fontSize', 'avatarSize', 'letterSpacing', 'lineHeight',
    'fansMedalScale', 'userLevelScale', 'nicknameScale', 'motionEnabled',
    'lanePadding', 'commonTimeSec', 'commonTotal', 'markedTimeSec', 'markedTotal',
    'markedFilterYuan', 'showFreeGifts', 'showWelcome', 'clickThrough', 'giftFold', 'danmakuScrollDirection', 'showDouyuEmoticons',
    'edgeSide', 'edgeHoldSec', 'edgeMaxVisible', 'edgeWidth', 'edgeBottomPercent', 'giftOfficialBanner', 'giftOfficialAnimation',
    'giftLayout', 'giftAmountScale', 'edgeMessageGap', 'edgeGiftTopHoldSec', 'edgeStatusMode', 'edgeStatusPosition', 'statusFontSize', 'statusAlwaysVisible']
  return keys.some(key => previous[key] !== next[key]) ||
    !sameModules(previous.chatModules, next.chatModules) ||
    !sameModules(previous.widgetModules, next.widgetModules) ||
    !sameModules(previous.statusMetrics, next.statusMetrics)
}

function refreshMessageColors(
  element: HTMLElement,
  payload: DanmakuPayload,
  cfg: AppConfig
): void {
  const username = element.querySelector<HTMLElement>('.username')
  if (username) username.style.color = safeColor(cfg.usernameTextColor, '#56e3f9')
  const content = element.querySelector<HTMLElement>('.content')
  if (content) {
    content.style.color = isGift(payload) || isWelcome(payload)
      ? safeColor(cfg.minorTextColor, '#bcbcbc')
      : resolvedMessageColor(cfg, payload)
  }
  const giftName = element.querySelector<HTMLElement>('.gift-name')
  if (giftName) giftName.style.color = safeColor(cfg.giftTextColor, '#f7b500')
}

function refreshHighlightColors(element: HTMLElement, cfg: AppConfig): void {
  const username = element.querySelector<HTMLElement>('.username')
  if (username) username.style.color = safeColor(cfg.usernameTextColor, '#56e3f9')
  const giftName = element.querySelector<HTMLElement>('.gift-name')
  if (giftName) giftName.style.color = safeColor(cfg.giftTextColor, '#f7b500')
}

function refreshExistingEntries(previous: AppConfig | null, cfg: AppConfig): void {
  const structureChanged = previous != null && !sameModules(previous.chatModules, cfg.chatModules)
  for (const entry of commonEntries) {
    if (exitAnimations.has(entry.parts.element)) continue
    entry.expiresAt = commonExpiry(entry.shownAt, cfg)
    if (structureChanged) replaceCommonVisual(entry, cfg)
    else refreshMessageColors(entry.parts.element, entry.payload, cfg)
    if (entry.parts.messageText) emoticons.render(entry.parts.messageText, entry.payload.text, cfg.showDouyuEmoticons && !isWelcome(entry.payload))
  }
  for (const entry of movingEntries) {
    if (structureChanged) replaceMovingVisual(entry, cfg)
    else refreshMessageColors(entry.parts.element, entry.payload, cfg)
    if (entry.parts.messageText) emoticons.render(entry.parts.messageText, entry.payload.text, cfg.showDouyuEmoticons && !isWelcome(entry.payload))
  }
  for (const entry of highlightEntries) {
    if (exitAnimations.has(entry.element)) continue
    if (previous?.giftOfficialBanner !== cfg.giftOfficialBanner || previous?.motionEnabled !== cfg.motionEnabled || previous?.giftLayout !== cfg.giftLayout) updateHighlightVisual(entry, cfg)
    entry.expiresAt = highlightExpiry(Math.max(entry.shownAt, entry.updatedAt), cfg)
    entry.element.dataset.valueTier = cfg.giftValueColors ? giftValueTier(entry.payload) : 'neutral'
    refreshHighlightColors(entry.element, cfg)
  }
}

function applyConfig(next: AppConfig): void {
  const previous = config
  const directionChanged =
    previous != null && (previous.danmakuScrollDirection !== next.danmakuScrollDirection ||
      (next.danmakuScrollDirection === 'edge' && previous.edgeSide !== next.edgeSide))
  if (directionChanged) clearDanmaku(true)
  config = next
  configureEdgeStages(next)
  if (!previous || ['giftFold', 'markedTotal', 'markedTimeSec', 'markedFilterYuan', 'showFreeGifts'].some(key =>
    previous[key as keyof AppConfig] !== next[key as keyof AppConfig]) ||
    !sameModules(previous.widgetModules, next.widgetModules)) giftRenderDirty = true
  if (!next.motionEnabled) for (const animation of exitAnimations.values()) animation.finish()
  for (let i = pendingMessages.length - 1; i >= 0; i -= 1) {
    const payload = pendingMessages[i]!.payload
    if ((!next.showFreeGifts && isGift(payload) && (payload.giftIsFree || payload.giftPrice === 0)) ||
        (!next.showWelcome && isWelcome(payload))) pendingMessages.splice(i, 1)
  }

  root.style.setProperty('--font-size', `${clamp(Number(next.fontSize) || 20, 12, 96)}px`)
  root.style.setProperty('--avatar-size', `${clamp(Number(next.avatarSize) || 32, 16, 128)}px`)
  root.style.setProperty('--fans-medal-scale', String(next.fansMedalScale))
  root.style.setProperty('--user-level-scale', String(next.userLevelScale))
  root.style.setProperty('--nickname-scale', String(next.nicknameScale))
  root.classList.toggle('reduce-motion', !next.motionEnabled)
  root.style.setProperty('--letter-spacing', `${clamp(Number(next.letterSpacing) || 0, 0, 12)}px`)
  root.style.setProperty('--text-line-height', String(clamp(Number(next.lineHeight) || 1.5, 1, 2.5)))
  root.style.setProperty('--edge-inset', '0px')
  root.style.setProperty('--edge-bottom-percent', `${next.edgeBottomPercent}%`)
  root.style.setProperty('--gift-opacity', String(next.giftOpacity))
  root.style.setProperty('--gift-background', colorWithOpacity(next.danmakuBgColor, next.giftBackgroundOpacity, '#000000'))
  root.style.setProperty('--gift-banner-opacity', String(next.giftBannerOpacity))
  root.style.setProperty('--gift-amount-scale', String(next.giftAmountScale))
  root.style.setProperty('--status-opacity', String(next.statusOpacity))
  root.style.setProperty('--status-background', colorWithOpacity(next.danmakuBgColor, next.statusBackgroundOpacity, '#000000'))
  root.style.setProperty('--status-font-size', `${next.statusFontSize}px`)
  root.style.setProperty('--message-enter-duration', `${200 / motionSpeedScale(next.speedPxPerSec)}ms`)
  root.style.setProperty(
    '--row-gap',
    `${clamp(Math.round(Number(next.lanePadding) || 0), 0, 40)}px`
  )
  root.style.setProperty('--common-text', safeColor(next.commonTextColor, '#ffffff'))
  root.style.setProperty('--secondary-text', safeColor(next.minorTextColor, '#bcbcbc'))
  root.style.setProperty('--username-text', safeColor(next.usernameTextColor, '#56e3f9'))
  root.style.setProperty('--gift-text', safeColor(next.giftTextColor, '#f7b500'))
  root.style.setProperty(
    '--text-shadow',
    next.textShadowColor ? `1px 1px 2px ${safeColor(next.textShadowColor, '#000000')}` : 'none'
  )
  root.style.setProperty(
    '--panel-background',
    colorWithOpacity(next.danmakuBgColor, next.danmakuBgOpacity, '#000000')
  )
  root.style.setProperty(
    '--window-background',
    colorWithOpacity(next.danmakuBgColor, next.overlayBackgroundOpacity, '#000000')
  )
  root.style.opacity = String(clamp(next.opacity, 0.05, 1))

  const streamMode = next.danmakuScrollDirection === 'verticalUp'
  const edgeMode = next.danmakuScrollDirection === 'edge'
  root.classList.toggle('is-stream-mode', streamMode)
  root.classList.toggle('is-moving-mode', !streamMode && !edgeMode)
  root.classList.toggle('is-edge-mode', edgeMode)
  root.dataset.edgeSide = next.edgeSide
  root.dataset.edgeStatusPosition = next.edgeStatusPosition
  if (edgeMode && statusBar.parentElement !== edgeScene) edgeScene.prepend(statusBar)
  else if (!edgeMode && statusBar.parentElement !== root) root.insertBefore(statusBar, movingLayer)
  document.getElementById('dragRegion')!.hidden = edgeMode
  root.classList.toggle('is-locked', edgeMode || next.clickThrough !== false)
  root.classList.toggle('is-unlocked', !edgeMode && next.clickThrough === false)
  updateStatusVisibility()
  refreshExistingEntries(previous, next)
  // 颜色与不透明度只更新合成样式，不重排正在移动的消息。
  if (!needsConfigLayout(previous, next)) return
  if (!hasWidgetModule(next, 'highlight')) {
    while (highlightEntries.length) removeHighlight(highlightEntries[0]!)
    giftPresentation.clear()
  } else {
    for (const entry of [...highlightEntries]) {
      if (!shouldHighlight(entry.payload, next)) removeHighlight(entry, false, false)
    }
    if (!edgeMode) for (const entry of highlightEntries.slice(0, Math.max(0, highlightEntries.length - next.markedTotal))) removeHighlight(entry)
  }
  if (!edgeMode) while (commonEntries.length > next.commonTotal) removeCommon(commonEntries[0]!)
  pruneExpired(Date.now())
  renderStats()
  scheduleLayout()
  updateContentVisibility()
  if (!previous) {
    // 隐藏窗口可能暂停 RAF；首屏同步应用配置和布局，避免显示与 RAF 互相等待。
    performLayout()
    root.classList.add('is-ready')
    window.overlayApi?.rendered()
  }
}

function clearDanmaku(preserveGiftHistory = false): void {
  for (const [list, flow] of listFlows) {
    flow.state = { offset: 0, velocity: 0, acceleration: 0 }
    flow.positions.clear()
    list.style.setProperty('--flow-offset', '0px')
  }
  for (const animation of exitAnimations.values()) animation.cancel()
  exitAnimations.clear()
  completedExits.clear()
  inboundPayloads.length = 0
  pendingMessages.length = 0
  // 切换显示方式/左右边缘只重建展示，后到的开奖仍需核对原投入。
  if (!preserveGiftHistory) giftPresentation.clear()
  giftEffects.clear()
  giftRenderDirty = preserveGiftHistory
  nextGiftSyncAt = 0
  for (const entry of commonEntries) entry.parts.element.remove()
  for (const entry of highlightEntries) entry.element.remove()
  for (const entry of movingEntries) entry.parts.element.remove()
  commonEntries.length = 0
  highlightEntries.length = 0
  movingEntries.length = 0
  messageList.replaceChildren()
  highlightList.replaceChildren()
  movingLayer.replaceChildren()
  edgeStage.clear()
  highlightPane.hidden = true
  nextIncomingAt = 0
  updateContentVisibility()
}

window.addEventListener('resize', renderStats)
reducedMotion.addEventListener('change', () => {
  if (config) configureEdgeStages(config)
  if (reducedMotion.matches) for (const animation of exitAnimations.values()) animation.finish()
  if (config) for (const entry of highlightEntries) updateHighlightVisual(entry, config)
  scheduleLayout()
})
const resizeObserver = new ResizeObserver(scheduleLayout)
resizeObserver.observe(root)
resizeObserver.observe(messagePane)
resizeObserver.observe(highlightPane)
resizeObserver.observe(messageList)
resizeObserver.observe(highlightList)
resizeObserver.observe(statusBar)

unlockIndicator.addEventListener('click', () => {
  void window.settingsApi?.setConfig({ clickThrough: true })
})

setInterval(() => {
  statusRotationIndex += 1
  renderStats()
}, STATUS_ROTATION_MS)

if (window.overlayApi) {
  let catalogReceived = false
  const updateEmoticons = (items: import('../shared/emoticons').DouyuEmoticon[]): void => {
    emoticons.setCatalog(items)
    if (config) refreshExistingEntries(config, config)
  }
  window.overlayApi.onEmoticonCatalog(catalog => {
    catalogReceived = true
    updateEmoticons(catalog.items)
  })
  void window.overlayApi.getEmoticonCatalog().then(catalog => {
    if (!catalogReceived) updateEmoticons(catalog.items)
  }).catch(error => console.warn('表情目录暂不可用', error))
  window.overlayApi.onGiftCatalog((items: GiftMetadata[], banners) => {
    const catalog = new Map(items.map((item) => [giftCatalogKey(item.id, item.catalogType), item]))
    giftPresentation.updateCatalog(catalog, banners)
    giftRenderDirty = true
  })
  window.overlayApi.onConfig(applyConfig)
  // 订阅后主动读取，避免首次配置推送早于监听；已收到的推送优先。
  void window.settingsApi.getConfig().then(initial => {
    if (!config) applyConfig(initial)
  }).catch(error => console.error('弹幕配置加载失败', error))
  window.overlayApi.onDanmaku(payload => {
    inboundPayloads.push(payload)
    if (inboundPayloads.length > 5_000) inboundPayloads.splice(0, inboundPayloads.length - 5_000)
  })
  window.overlayApi.onClearDanmaku(clearDanmaku)
  window.overlayApi.onStats((nextStats) => {
    for (const metric of Object.keys(STATUS_LABELS) as OverlayStatusMetric[]) {
      const previous = stats[metric]
      const next = nextStats[metric]
      const diff =
        previous != null && previous > 0 && next != null && Number.isFinite(next)
          ? next - previous
          : 0
      statDiffs.set(metric, diff)
    }
    stats = nextStats
    renderStats()
  })
}

requestAnimationFrame(function tick(animationTs: number): void {
  requestAnimationFrame(tick)
  const dt = lastAnimationTs ? Math.min(0.1, (animationTs - lastAnimationTs) / 1000) : 0
  lastAnimationTs = animationTs
  if (!config) return
  // 系统偏好变更事件可能晚于本帧消息，入场前重新读取，避免先滑动一帧再被取消。
  if (isEdgeMode()) configureEdgeStages(config)
  // 先沿旧轨迹推进到本帧，再接入新目标，避免新消息借用上一帧的时间突然加速。
  advanceListMotion(dt)
  if (isEdgeMode()) edgeStage.advance(dt)
  for (const payload of inboundPayloads.splice(0)) enqueueDanmaku(payload)
  if (giftRenderDirty && (isEdgeMode() || animationTs >= nextGiftSyncAt)) {
    syncGiftHighlights(Date.now())
    nextGiftSyncAt = animationTs + 120
  }
  processIncoming(animationTs)
  pruneExpired(Date.now())
  advanceMoving(Math.min(dt, 0.05), config)
  for (const [element, remove] of [...completedExits]) {
    if (!completedExits.has(element)) continue
    completedExits.delete(element)
    remove()
  }
  // 本帧插入、裁剪后立即建立位移补偿，不能先画一帧新位置、下一帧再拉回旧位置。
  if (layoutFrame) {
    cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
    performLayout()
  }
  giftEffects.update(highlightEntries.map(entry => ({ element: entry.element, payload: entry.payload,
    ready: !exitAnimations.has(entry.element) && (!isEdgeMode() || Number.isFinite(edgeStage.readableAt(entry.element)))
  })), config.giftOfficialAnimation && motionAllowed())
  updateContentVisibility()
})
