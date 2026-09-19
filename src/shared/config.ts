import type { DanmakuPayload } from './types'
import { normalizeManualGiftPrices, type ManualGiftPrices } from './manualGiftPrices'
import type { Rectangle } from './overlayGeometry'

/** 相同弹幕文案出现时的处理方式 */
export type DuplicateDanmakuMode = 'each' | 'once' | 'merge'

/** 飘屏绑定的显示器：主显示器（随系统主屏变化）或指定显示器 id */
export type OverlayDisplayMode = 'primary' | 'specific'

/** 设置页与 IPC 共用的显示器条目（仅元数据，不含原生 Display 对象） */
export interface OverlayDisplayListItem {
  id: string
  label: string
  isPrimary: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  physicalSize: { width: number; height: number }
}

/** 鼠标拖动/缩放后保存的悬浮窗绝对边界；显示器改变时会自动失效。 */
export interface OverlayManualBounds {
  x: number
  y: number
  width: number
  height: number
  displayId: string
  workArea?: Rectangle
}

/** 消息流、连续飘屏，或逐条从屏幕边缘进退的沉浸模式。 */
export type DanmakuScrollDirection = 'horizontal' | 'vertical' | 'verticalUp' | 'edge'
export type DanmakuEdgeSide = 'left' | 'right'

/** 「常规消息组成」的六个选项。 */
export type OverlayChatModule =
  | 'moderator'
  | 'avatar'
  | 'noble'
  | 'medal'
  | 'level'
  | 'gifticon'

/** 「挂件模块」选项。 */
export type OverlayWidgetModule = 'highlight' | 'status'

/** 从斗鱼消息流中获取或统计的指标。 */
export type OverlayStatusMetric =
  | 'noble'
  | 'danmakuUsers'
  | 'danmakuCount'
  | 'giftCount'
  | 'giftValue'

export const OVERLAY_CHAT_MODULE_OPTIONS: readonly {
  value: OverlayChatModule
  label: string
}[] = [
  { value: 'moderator', label: '房管标识' },
  { value: 'avatar', label: '用户头像' },
  { value: 'noble', label: '贵族牌子' },
  { value: 'medal', label: '粉丝勋章' },
  { value: 'level', label: '用户等级' },
  { value: 'gifticon', label: '礼物图片' }
]

export const OVERLAY_WIDGET_MODULE_OPTIONS: readonly {
  value: OverlayWidgetModule
  label: string
}[] = [
  { value: 'highlight', label: '高亮消息' },
  { value: 'status', label: '状态栏' }
]

export const OVERLAY_STATUS_METRIC_OPTIONS: readonly {
  value: OverlayStatusMetric
  label: string
}[] = [
  { value: 'noble', label: '贵宾数' },
  { value: 'danmakuUsers', label: '弹幕人数' },
  { value: 'danmakuCount', label: '弹幕条数' },
  { value: 'giftCount', label: '礼物数量' },
  { value: 'giftValue', label: '礼物价值' }
]

/** 当前保存的使用方案，同时供首次启动与恢复默认排版使用。 */
export const DEFAULT_CONFIG: AppConfig = {
  roomId: '11921577',
  /** 总开关：关则隐藏飘屏窗口并停止拉流 */
  overlayEnabled: false,
  /** 飘屏绑定主显示器或指定显示器 */
  overlayDisplayMode: 'primary',
  /** `specific` 时使用 Electron display id，否则为空 */
  overlayDisplayId: '',
  /** 窗口是否保持在普通窗口之上；仍使用工作区边界避开任务栏。 */
  overlayAlwaysOnTop: true,
  /** 是否定时重新确认置顶层级，避免其他程序抢走窗口层级。 */
  overlayAutoRefreshTopmost: true,
  /** 原生拖动结束后，在 6 个逻辑像素内轻柔贴边。 */
  overlayEdgeSnap: true,
  /** 飘屏窗口底色不透明度；0 表示完全透明 */
  overlayBackgroundOpacity: 0,
  /** 普通窗口沿用当前的位置与尺寸；显示器不匹配时回退到目标屏幕的默认位置。 */
  overlayManualBounds: {
    x: 1560, y: 410, width: 360, height: 640, displayId: '297857999',
    workArea: { x: 0, y: 0, width: 1920, height: 1050 }
  },
  /** 默认显示字号。 */
  fontSize: 18,
  avatarSize: 30,
  fansMedalScale: 0.9,
  userLevelScale: 1,
  nicknameScale: 1,
  motionEnabled: true,
  letterSpacing: 0,
  lineHeight: 1,
  dailyStatisticsEnabled: true,
  saveDanmakuHistory: false,
  showDouyuEmoticons: true,
  giftValueColors: true,
  giftOfficialBanner: true,
  giftOfficialAnimation: true,
  giftLayout: 'card',
  giftOpacity: 1,
  giftBackgroundOpacity: 0,
  giftBannerOpacity: 1,
  giftAmountScale: 1.25,
  fontColor: '#ffffff',
  /** 单条弹幕背后衬底颜色（#RRGGBB）；透明度由 danmakuBgOpacity 控制 */
  danmakuBgColor: '#2a2828',
  /** 0–1，弹幕背景不透明度；为 0 时不绘制背景 */
  danmakuBgOpacity: 0.5,
  danmakuScrollDirection: 'edge',
  edgeSide: 'right',
  edgeHoldSec: 6,
  edgeGiftTopHoldSec: 4,
  edgeMaxVisible: 8,
  edgeWidth: 440,
  edgeBottomPercent: 7,
  edgeMessageGap: 10,
  edgeStatusMode: 'always',
  edgeStatusPosition: 'bottom',
  statusOpacity: 1,
  statusBackgroundOpacity: 0.5,
  statusFontSize: 15,
  cacheDirectory: '',
  opacity: 1,
  speedPxPerSec: 100,
  blockWords: [],
  /** 昵称（nn）黑名单：发送者昵称包含任一规则即屏蔽整条；逗号分隔，子串、不区分大小写 */
  blockNicks: [],
  /** 是否让飘屏窗口接收鼠标；true 时鼠标穿透到下层应用 */
  clickThrough: false,
  /** 相同文案弹幕：每条都显示 / 同屏与队列中只保留一条 / 合并并放大且显示 xN */
  duplicateDanmakuMode: 'each',
  /** 「合并变大」时：与上一条同文案间隔小于该秒数才计入连击并逐渐放大 */
  duplicateMergeWindowSec: 10,
  lanePadding: 10,
  simulateDanmaku: false,
  simulateIntervalMs: 200,
  /** 为 true 时用 WS 包中的 col 映射文字颜色，否则统一用 fontColor */
  showDanmakuColor: false,
  /** 为 true 时丢弃无 `dms` 字段的 chatmsg（通常为机器人弹幕） */
  filterRobotDanmaku: true,
  /** 通用弹幕助手设置。 */
  commonTimeSec: 10,
  commonTotal: 10,
  chatModules: ['moderator', 'avatar', 'medal', 'noble', 'level', 'gifticon'],
  widgetModules: ['highlight', 'status'],
  markedFilterYuan: 0,
  markedTimeSec: 60,
  markedTotal: 3,
  statusMetrics: ['noble', 'danmakuUsers', 'danmakuCount', 'giftCount', 'giftValue'],
  statusAlwaysVisible: true,
  giftFold: true,
  manualGiftPrices: {},
  chatFold: false,
  chatMinLength: 0,
  chatPrefix: '',
  showFreeGifts: false,
  showWelcome: false,
  welcomeNobleLevel: 0,
  usernameTextColor: '#56e3f9',
  giftTextColor: '#f7b500',
  commonTextColor: '#ffffff',
  minorTextColor: '#bcbcbc',
  textShadowColor: '#000000',
  /** 用户是否已看过「关闭主窗口会收到托盘」提示（仅首次关闭主界面弹窗一次） */
  dismissedTrayCloseHint: true
}

export interface AppConfig {
  /** 只用于平台尚未给出价格的礼物，按斗鱼礼物 ID 保存。 */
  manualGiftPrices: ManualGiftPrices
  /** 斗鱼房间号 */
  roomId: string
  /** 是否显示飘屏并连接弹幕源 */
  overlayEnabled: boolean
  overlayDisplayMode: OverlayDisplayMode
  /** 仅在 overlayDisplayMode 为 specific 时有效 */
  overlayDisplayId: string
  /** 窗口是否保持在普通窗口之上。 */
  overlayAlwaysOnTop: boolean
  /** 是否定时重新确认置顶层级。 */
  overlayAutoRefreshTopmost: boolean
  overlayEdgeSnap: boolean
  /** 飘屏窗口底色不透明度（0–1） */
  overlayBackgroundOpacity: number
  /** 关闭鼠标穿透后，通过原生窗口边缘/拖动区得到的位置与尺寸。 */
  overlayManualBounds: OverlayManualBounds | null
  fontSize: number
  /** 逻辑像素；由系统 DPI 自动换算为屏幕像素。 */
  avatarSize: number
  /** 相对于正文的比例；徽章、等级、昵称可以独立调整。 */
  fansMedalScale: number
  userLevelScale: number
  nicknameScale: number
  motionEnabled: boolean
  /** 文字字距（逻辑像素）。 */
  letterSpacing: number
  /** 随字号缩放的行高倍数，区别于消息之间的 lanePadding。 */
  lineHeight: number
  dailyStatisticsEnabled: boolean
  saveDanmakuHistory: boolean
  showDouyuEmoticons: boolean
  giftValueColors: boolean
  /** 可选官方皮肤；默认沿用完全透明的礼物栏。 */
  giftOfficialBanner: boolean
  /** 仅播放广播实际触发且支持透明解码的官方特效。 */
  giftOfficialAnimation: boolean
  /** 普通礼物可以与弹幕同高；抽奖仍保留投入和奖励明细。 */
  giftLayout: 'inline' | 'card'
  giftOpacity: number
  giftBackgroundOpacity: number
  giftBannerOpacity: number
  /** 礼物总金额相对正文字号的倍数。 */
  giftAmountScale: number
  fontColor: string
  danmakuBgColor: string
  danmakuBgOpacity: number
  danmakuScrollDirection: DanmakuScrollDirection
  edgeSide: DanmakuEdgeSide
  /** 完整进场后的统一保留秒数，不随文字长度变化，也不阻塞新消息。 */
  edgeHoldSec: number
  /** 礼物到消息列顶部后的额外保留秒数；独立于下方的消息流。 */
  edgeGiftTopHoldSec: number
  /** 弹幕与礼物共用的同屏上限。 */
  edgeMaxVisible: number
  /** 边缘显示区域的逻辑像素宽度，与普通窗口位置独立。 */
  edgeWidth: number
  /** 距屏幕底部的留白比例，0–80；只移动边缘消息，不改普通窗口位置。 */
  edgeBottomPercent: number
  edgeMessageGap: number
  edgeStatusMode: 'hidden' | 'active' | 'always'
  edgeStatusPosition: 'top' | 'bottom'
  statusOpacity: number
  statusBackgroundOpacity: number
  statusFontSize: number
  /** 专用缓存目录，空字符串使用默认位置；变更在下次启动生效。 */
  cacheDirectory: string
  /** 0–1，弹幕内容与背景的整体不透明度。 */
  opacity: number
  /** 保留历史配置键；界面用标准速度百分比，同时控制连续飘屏与进退场。 */
  speedPxPerSec: number
  blockWords: string[]
  /** 昵称（nn）黑名单：仅匹配发送者昵称，子串、不区分大小写；逗号分隔，规则与屏蔽词列表解析一致 */
  blockNicks: string[]
  clickThrough: boolean
  duplicateDanmakuMode: DuplicateDanmakuMode
  duplicateMergeWindowSec: number
  lanePadding: number
  simulateDanmaku: boolean
  simulateIntervalMs: number
  showDanmakuColor: boolean
  /** 按 dms 字段启发式过滤疑似机器人，同时从条数和人数中排除。 */
  filterRobotDanmaku: boolean
  /** 常规消息保留时长；0 表示不按时间删除。 */
  commonTimeSec: number
  /** 常规消息数量上限。 */
  commonTotal: number
  chatModules: OverlayChatModule[]
  widgetModules: OverlayWidgetModule[]
  /** 高亮礼物总价阈值（人民币元）。 */
  markedFilterYuan: number
  /** 高亮消息保留秒数；0 表示不按时间删除。 */
  markedTimeSec: number
  markedTotal: number
  statusMetrics: OverlayStatusMetric[]
  /** 没有弹幕或礼物时也显示统计栏及其自身底色。 */
  statusAlwaysVisible: boolean
  giftFold: boolean
  chatFold: boolean
  /** 弹幕字数小于此值时不显示；0 表示不限制。 */
  chatMinLength: number
  /** 仅显示以此前缀开头的弹幕；空字符串表示不限制。 */
  chatPrefix: string
  showFreeGifts: boolean
  showWelcome: boolean
  welcomeNobleLevel: number
  usernameTextColor: string
  giftTextColor: string
  commonTextColor: string
  minorTextColor: string
  /** 空字符串为关闭，否则生成 1px 1px 2px 阴影。 */
  textShadowColor: string
  dismissedTrayCloseHint: boolean
}

function normalizeOverlayDisplayMode(v: unknown): OverlayDisplayMode {
  return v === 'specific' ? 'specific' : 'primary'
}

const DUPLICATE_MODES: readonly DuplicateDanmakuMode[] = ['each', 'once', 'merge']
const CHAT_MODULES = new Set<OverlayChatModule>(OVERLAY_CHAT_MODULE_OPTIONS.map((item) => item.value))
const WIDGET_MODULES = new Set<OverlayWidgetModule>(OVERLAY_WIDGET_MODULE_OPTIONS.map((item) => item.value))
const STATUS_METRICS = new Set<OverlayStatusMetric>(OVERLAY_STATUS_METRIC_OPTIONS.map((item) => item.value))

/** 屏蔽词分隔：英文逗号与中文逗号 */
const BLOCK_WORD_DELIMITER = /[,，]/

/** 从单行输入解析屏蔽词列表（设置页与合并配置共用） */
export function parseBlockWordsText(text: string): string[] {
  return text
    .split(BLOCK_WORD_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 合并/加载配置时：数组项内若含逗号也会拆开，兼容旧版只存一条含「，」的字符串 */
export function normalizeBlockWords(value: unknown): string[] {
  if (typeof value === 'string') return parseBlockWordsText(value)
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const s = String(item).trim()
    if (!s) continue
    out.push(...parseBlockWordsText(s))
  }
  return out
}

function normalizeDuplicateMode(v: unknown): DuplicateDanmakuMode {
  return DUPLICATE_MODES.includes(v as DuplicateDanmakuMode)
    ? (v as DuplicateDanmakuMode)
    : DEFAULT_CONFIG.duplicateDanmakuMode
}

function normalizeDanmakuScrollDirection(v: unknown): DanmakuScrollDirection {
  if (v === 'edge') return 'edge'
  if (v === 'vertical') return 'vertical'
  if (v === 'verticalUp') return 'verticalUp'
  if (v === 'horizontal') return 'horizontal'
  return DEFAULT_CONFIG.danmakuScrollDirection
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  }
  return fallback
}

function normalizeOverlayManualBounds(value: unknown): OverlayManualBounds | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof OverlayManualBounds, unknown>>
  const x = Number(raw.x)
  const y = Number(raw.y)
  const width = Number(raw.width)
  const height = Number(raw.height)
  const displayId = String(raw.displayId ?? '').trim()
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    !displayId
  ) {
    return null
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    displayId,
    ...(normalizeReferenceArea(raw.workArea) ? { workArea: normalizeReferenceArea(raw.workArea)! } : {})
  }
}

function normalizeReferenceArea(value: unknown): Rectangle | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const numbers = [r.x, r.y, r.width, r.height].map(Number)
  if (!numbers.every(Number.isFinite) || numbers[2]! <= 0 || numbers[3]! <= 0) return undefined
  return { x: numbers[0]!, y: numbers[1]!, width: numbers[2]!, height: numbers[3]! }
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/

function normalizeDanmakuBgColor(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (HEX_COLOR_RE.test(s)) return s
  return DEFAULT_CONFIG.danmakuBgColor
}

function normalizeColor(v: unknown, fallback: string, allowEmpty = false): string {
  const value = typeof v === 'string' ? v.trim() : ''
  if (allowEmpty && value === '') return ''
  return HEX_COLOR_RE.test(value) ? value.toLowerCase() : fallback
}

function normalizeChoiceList<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  fallback: readonly T[]
): T[] {
  if (!Array.isArray(value)) return [...fallback]
  const result: T[] = []
  for (const raw of value) {
    const item = String(raw) as T
    if (allowed.has(item) && !result.includes(item)) result.push(item)
  }
  return result
}

function finiteClamped(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

type RemovedLegacyConfig = {
  edgeReadCharsPerSec?: unknown
  edgeMaxHoldSec?: unknown
  markedTimeMin?: unknown
  overlayArea?: unknown
  overlayWidthPercent?: unknown
  overlayHeightPercent?: unknown
  edgeInset?: unknown
  showLikes?: unknown
  showFollows?: unknown
  welcomeFansLevel?: unknown
  welcomeOtherFansLevel?: unknown
}

export function mergeConfig(
  partial: (Partial<AppConfig> & RemovedLegacyConfig) | undefined
): AppConfig {
  const merged = { ...DEFAULT_CONFIG, ...(partial ?? {}) } as AppConfig & {
    blockUserIds?: unknown
    maxOnScreen?: unknown
    maxQueue?: unknown
  } & RemovedLegacyConfig
  merged.overlayDisplayMode = normalizeOverlayDisplayMode(merged.overlayDisplayMode)
  merged.roomId = String(merged.roomId ?? '').trim()
  merged.overlayEnabled = normalizeBoolean(merged.overlayEnabled, DEFAULT_CONFIG.overlayEnabled)
  merged.simulateDanmaku = normalizeBoolean(merged.simulateDanmaku, DEFAULT_CONFIG.simulateDanmaku)
  merged.opacity = finiteClamped(merged.opacity, DEFAULT_CONFIG.opacity, 0.05, 1)
  merged.simulateIntervalMs = Math.round(finiteClamped(merged.simulateIntervalMs, DEFAULT_CONFIG.simulateIntervalMs, 200, 60_000))
  merged.overlayDisplayId = String(merged.overlayDisplayId ?? '').trim()
  if (merged.overlayDisplayMode !== 'specific') {
    merged.overlayDisplayId = ''
  } else if (!merged.overlayDisplayId) {
    merged.overlayDisplayMode = 'primary'
  }
  merged.overlayAlwaysOnTop = normalizeBoolean(
    merged.overlayAlwaysOnTop,
    DEFAULT_CONFIG.overlayAlwaysOnTop
  )
  merged.overlayAutoRefreshTopmost = normalizeBoolean(
    merged.overlayAutoRefreshTopmost,
    DEFAULT_CONFIG.overlayAutoRefreshTopmost
  )
  merged.overlayEdgeSnap = normalizeBoolean(merged.overlayEdgeSnap, DEFAULT_CONFIG.overlayEdgeSnap)
  const overlayBgOpacity = Number(merged.overlayBackgroundOpacity)
  merged.overlayBackgroundOpacity = Number.isFinite(overlayBgOpacity)
    ? Math.min(1, Math.max(0, overlayBgOpacity))
    : DEFAULT_CONFIG.overlayBackgroundOpacity
  merged.overlayManualBounds = normalizeOverlayManualBounds(merged.overlayManualBounds)
  merged.edgeSide = merged.edgeSide === 'left' ? 'left' : 'right'
  merged.edgeHoldSec = finiteClamped(merged.edgeHoldSec, DEFAULT_CONFIG.edgeHoldSec, 2, 20)
  merged.edgeGiftTopHoldSec = finiteClamped(merged.edgeGiftTopHoldSec, DEFAULT_CONFIG.edgeGiftTopHoldSec, 0, 60)
  delete merged.edgeReadCharsPerSec
  delete merged.edgeMaxHoldSec
  merged.edgeMaxVisible = Math.round(finiteClamped(merged.edgeMaxVisible, DEFAULT_CONFIG.edgeMaxVisible, 1, 8))
  merged.edgeWidth = Math.round(finiteClamped(merged.edgeWidth, DEFAULT_CONFIG.edgeWidth, 280, 640))
  merged.edgeBottomPercent = finiteClamped(merged.edgeBottomPercent, DEFAULT_CONFIG.edgeBottomPercent, 0, 80)
  merged.fontSize = Math.round(
    finiteClamped(merged.fontSize, DEFAULT_CONFIG.fontSize, 12, 96)
  )
  merged.avatarSize = Math.round(finiteClamped(merged.avatarSize, DEFAULT_CONFIG.avatarSize, 16, 128))
  merged.fansMedalScale = finiteClamped(merged.fansMedalScale, DEFAULT_CONFIG.fansMedalScale, 0.6, 1.8)
  merged.userLevelScale = finiteClamped(merged.userLevelScale, 1, 0.6, 1.8)
  merged.nicknameScale = finiteClamped(merged.nicknameScale, 1, 0.6, 1.8)
  merged.motionEnabled = normalizeBoolean(merged.motionEnabled, true)
  merged.letterSpacing = finiteClamped(merged.letterSpacing, DEFAULT_CONFIG.letterSpacing, 0, 12)
  merged.lineHeight = finiteClamped(merged.lineHeight, DEFAULT_CONFIG.lineHeight, 1, 2.5)
  merged.dailyStatisticsEnabled = normalizeBoolean(merged.dailyStatisticsEnabled, true)
  merged.saveDanmakuHistory = normalizeBoolean(merged.saveDanmakuHistory, false)
  merged.showDouyuEmoticons = normalizeBoolean(merged.showDouyuEmoticons, true)
  merged.giftValueColors = normalizeBoolean(merged.giftValueColors, true)
  merged.giftOfficialBanner = normalizeBoolean(merged.giftOfficialBanner, DEFAULT_CONFIG.giftOfficialBanner)
  merged.giftOfficialAnimation = normalizeBoolean(merged.giftOfficialAnimation, true)
  merged.giftLayout = merged.giftLayout === 'card' || merged.giftLayout === 'inline' ? merged.giftLayout : DEFAULT_CONFIG.giftLayout
  merged.giftAmountScale = finiteClamped(merged.giftAmountScale, DEFAULT_CONFIG.giftAmountScale, 1, 1.8)
  for (const key of ['giftOpacity', 'giftBackgroundOpacity', 'giftBannerOpacity', 'statusOpacity', 'statusBackgroundOpacity'] as const) {
    merged[key] = finiteClamped(merged[key], DEFAULT_CONFIG[key], key === 'giftOpacity' || key === 'statusOpacity' ? 0.05 : 0, 1)
  }
  merged.edgeMessageGap = Math.round(finiteClamped(merged.edgeMessageGap, DEFAULT_CONFIG.edgeMessageGap, 0, 32))
  merged.edgeStatusMode = merged.edgeStatusMode === 'always' || merged.edgeStatusMode === 'active' || merged.edgeStatusMode === 'hidden'
    ? merged.edgeStatusMode : DEFAULT_CONFIG.edgeStatusMode
  merged.edgeStatusPosition = merged.edgeStatusPosition === 'bottom' || merged.edgeStatusPosition === 'top'
    ? merged.edgeStatusPosition : DEFAULT_CONFIG.edgeStatusPosition
  merged.statusFontSize = Math.round(finiteClamped(merged.statusFontSize, DEFAULT_CONFIG.statusFontSize, 12, 24))
  merged.cacheDirectory = typeof merged.cacheDirectory === 'string' && merged.cacheDirectory.length <= 1024
    ? merged.cacheDirectory.trim() : ''
  merged.speedPxPerSec = finiteClamped(
    merged.speedPxPerSec,
    DEFAULT_CONFIG.speedPxPerSec,
    40,
    320
  )
  merged.lanePadding = Math.round(
    finiteClamped(merged.lanePadding, DEFAULT_CONFIG.lanePadding, 0, 40)
  )
  merged.duplicateDanmakuMode = normalizeDuplicateMode(merged.duplicateDanmakuMode)
  merged.duplicateMergeWindowSec = Math.min(
    300,
    Math.max(1, Math.round(Number(merged.duplicateMergeWindowSec) || DEFAULT_CONFIG.duplicateMergeWindowSec))
  )
  merged.blockWords = normalizeBlockWords(merged.blockWords)
  const nickBlockRaw =
    partial !== undefined && Object.prototype.hasOwnProperty.call(partial, 'blockNicks')
      ? partial.blockNicks
      : partial !== undefined && Object.prototype.hasOwnProperty.call(partial, 'blockUserIds')
        ? merged.blockUserIds
        : merged.blockNicks
  merged.blockNicks = normalizeBlockWords(nickBlockRaw)
  delete merged.blockUserIds
  merged.clickThrough = normalizeBoolean(merged.clickThrough, DEFAULT_CONFIG.clickThrough)
  merged.showDanmakuColor = normalizeBoolean(merged.showDanmakuColor, DEFAULT_CONFIG.showDanmakuColor)
  merged.filterRobotDanmaku = normalizeBoolean(merged.filterRobotDanmaku, DEFAULT_CONFIG.filterRobotDanmaku)
  merged.commonTimeSec = Math.round(finiteClamped(merged.commonTimeSec, DEFAULT_CONFIG.commonTimeSec, 0, 600))
  merged.commonTotal = Math.round(finiteClamped(merged.commonTotal, DEFAULT_CONFIG.commonTotal, 10, 60))
  merged.chatModules = normalizeChoiceList(merged.chatModules, CHAT_MODULES, DEFAULT_CONFIG.chatModules)
  merged.widgetModules = normalizeChoiceList(merged.widgetModules, WIDGET_MODULES, DEFAULT_CONFIG.widgetModules)
  merged.markedFilterYuan = finiteClamped(merged.markedFilterYuan, DEFAULT_CONFIG.markedFilterYuan, 0, 1_000_000)
  // 只在没有秒字段时迁移旧分钟值；保存后删除旧字段，避免再次乘以 60。
  const markedTime = partial?.markedTimeSec == null && partial?.markedTimeMin != null
    ? finiteClamped(partial.markedTimeMin, DEFAULT_CONFIG.markedTimeSec / 60, 0, 30) * 60
    : merged.markedTimeSec
  merged.markedTimeSec = Math.round(finiteClamped(markedTime, DEFAULT_CONFIG.markedTimeSec, 0, 1_800))
  delete merged.markedTimeMin
  merged.markedTotal = Math.round(finiteClamped(merged.markedTotal, DEFAULT_CONFIG.markedTotal, 1, 8))
  merged.statusMetrics = normalizeChoiceList(merged.statusMetrics, STATUS_METRICS, DEFAULT_CONFIG.statusMetrics)
  merged.statusAlwaysVisible = normalizeBoolean(merged.statusAlwaysVisible, DEFAULT_CONFIG.statusAlwaysVisible)
  merged.giftFold = normalizeBoolean(merged.giftFold, DEFAULT_CONFIG.giftFold)
  merged.manualGiftPrices = normalizeManualGiftPrices(merged.manualGiftPrices)
  merged.chatFold = normalizeBoolean(merged.chatFold, DEFAULT_CONFIG.chatFold)
  merged.chatMinLength = Math.round(finiteClamped(merged.chatMinLength, DEFAULT_CONFIG.chatMinLength, 0, 10_000))
  merged.chatPrefix = String(merged.chatPrefix ?? '')
  merged.showFreeGifts = normalizeBoolean(merged.showFreeGifts, DEFAULT_CONFIG.showFreeGifts)
  merged.showWelcome = normalizeBoolean(merged.showWelcome, DEFAULT_CONFIG.showWelcome)
  merged.welcomeNobleLevel = Math.round(finiteClamped(merged.welcomeNobleLevel, DEFAULT_CONFIG.welcomeNobleLevel, 0, 9))
  // 从旧版本升级时沿用 fontColor；之后 commonTextColor 是统一的权威字段。
  const commonCandidate =
    partial && Object.prototype.hasOwnProperty.call(partial, 'commonTextColor')
      ? partial.commonTextColor
      : partial?.fontColor
  merged.usernameTextColor = normalizeColor(merged.usernameTextColor, DEFAULT_CONFIG.usernameTextColor)
  merged.giftTextColor = normalizeColor(merged.giftTextColor, DEFAULT_CONFIG.giftTextColor)
  merged.commonTextColor = normalizeColor(commonCandidate, DEFAULT_CONFIG.commonTextColor)
  merged.minorTextColor = normalizeColor(merged.minorTextColor, DEFAULT_CONFIG.minorTextColor)
  merged.textShadowColor = normalizeColor(merged.textShadowColor, DEFAULT_CONFIG.textShadowColor, true)
  merged.fontColor = merged.commonTextColor
  merged.dismissedTrayCloseHint = Boolean(merged.dismissedTrayCloseHint)
  merged.danmakuScrollDirection = normalizeDanmakuScrollDirection(merged.danmakuScrollDirection)
  merged.danmakuBgColor = normalizeDanmakuBgColor(merged.danmakuBgColor)
  const bgOp = Number(merged.danmakuBgOpacity)
  merged.danmakuBgOpacity = Number.isFinite(bgOp) ? Math.min(1, Math.max(0, bgOp)) : DEFAULT_CONFIG.danmakuBgOpacity
  Reflect.deleteProperty(merged, 'overlayArea')
  Reflect.deleteProperty(merged, 'overlayWidthPercent')
  Reflect.deleteProperty(merged, 'overlayHeightPercent')
  Reflect.deleteProperty(merged, 'edgeInset')
  Reflect.deleteProperty(merged, 'showLikes')
  Reflect.deleteProperty(merged, 'showFollows')
  Reflect.deleteProperty(merged, 'welcomeFansLevel')
  Reflect.deleteProperty(merged, 'welcomeOtherFansLevel')
  Reflect.deleteProperty(merged, 'maxOnScreen')
  Reflect.deleteProperty(merged, 'maxQueue')
  return merged
}

export function shouldBlock(config: AppConfig, payload: DanmakuPayload): boolean {
  if (payload.kind !== 'gift' && payload.kind !== 'welcome') {
    const message = String(payload.text ?? '')
    if (config.chatMinLength > 0 && Array.from(message).length < config.chatMinLength) return true
    if (config.chatPrefix && !message.startsWith(config.chatPrefix)) return true
  }
  const nick = (payload.nick ?? '').trim().toLowerCase()
  if (nick && config.blockNicks.length) {
    if (
      config.blockNicks.some((w) => {
        const t = w.trim().toLowerCase()
        return Boolean(t && nick.includes(t))
      })
    ) {
      return true
    }
  }
  // 礼物消息没有独立的正文，屏蔽词也应匹配礼物名称；保留昵称/正文拼接
  // 以兼容旧版行为。
  const hay = `${payload.nick}${payload.text}${payload.giftName ?? ''}`.toLowerCase()
  return config.blockWords.some((w) => w.trim() && hay.includes(w.trim().toLowerCase()))
}
