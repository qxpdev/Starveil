import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  shell,
  dialog,
  session,
  type Display,
  type NativeImage
} from 'electron'
import type { DanmakuPayload, OverlayStatsPayload, GiftCatalogStatus, GiftPricePatch, GiftBannerCatalog } from '../shared/types'
import type { DouyuStatusPayload } from '../shared/douyuStatus'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  shouldBlock,
  type AppConfig,
  type OverlayDisplayListItem
} from '../shared/config'
import { normalizeRoomId } from '../shared/room'
import { DouyuWsClient, type GiftMessage } from '../douyu/client'
import {
  fetchDouyuGiftCatalog,
  isKnownFreeGiftName,
  resolveGiftMetadata,
  resolveDouyuRoomId,
  type DouyuGiftMeta
} from '../douyu/roomInfo'
import {
  applyTrayAndWindowIcons,
  fetchAnchorAvatarAsIcon,
  invalidateAvatarCache,
  getDefaultIconImage,
  pushHomeLogoToRenderer,
  trayImageFromSource
} from './appIcons'
import { getWritableDataDirectory, getLegacyConfigPaths, setRuntimeCacheDirectory } from './dataPaths'
import { ConfigStore } from './configStore'
import { AppearancePreview } from '../shared/appearancePreview'
import { CacheManager } from './cacheManager'
import { CachePaths } from './cachePaths'
import { registerGiftMediaScheme, installGiftMediaProtocol, clearGiftVideoCache, giftVideoCacheBytes } from './giftMediaProtocol'
import { HTTP_CACHE_BYTES } from './cacheFiles'
import { EmoticonService } from './emoticonService'
import { formatBytes, type CacheClearResult } from '../shared/storage'
import { SessionStats } from './sessionStats'
import { StatisticsStore } from './statisticsStore'
import { chatExclusionReason } from '../shared/chatPolicy'
import { localDateKey, type StatisticsQuery, type StatisticsExportResult, type ChatHistoryQuery } from '../shared/statistics'
import { withManualGiftPrices, listGiftPricing } from './giftPricing'
import { parseManualGiftPrice } from '../shared/manualGiftPrices'
import { giftCatalogKey, mergeGiftMetadata } from '../shared/giftMetadata'
import { acquireInstanceGuard, type InstanceGuard } from './singleInstance'
import { watchFullscreenDisplay } from './desktopState'
import { APP_NAME, APP_DISPLAY_NAME } from './appMetadata'
import {
  clampOverlayBounds, clampAndSnapOverlayBounds, defaultOverlayBounds, remapOverlayBounds, edgeOverlayBounds,
  OVERLAY_MIN_WIDTH, OVERLAY_MIN_HEIGHT
} from '../shared/overlayGeometry'
import {
  checkForUpdates,
  getCachedUpdateResult,
  isAllowedExternalUrl,
  scheduleUpdateChecks
} from './updateService'

const __dirname = dirname(fileURLToPath(import.meta.url))
registerGiftMediaScheme()

/** 解析 preload 绝对路径（dev/build 下均在 out/preload；兼容 cwd 与主入口差异） */
function getPreloadPath(): string {
  const nextToMain = resolve(__dirname, '..', 'preload', 'index.mjs')
  if (existsSync(nextToMain)) return nextToMain
  const underPkg = resolve(app.getAppPath(), 'out', 'preload', 'index.mjs')
  if (existsSync(underPkg)) return underPkg
  return nextToMain
}

/** 标题栏拖动会话：移动时用固定宽高 setBounds，避免 Windows 下尺寸漂移；记录上次位置避免重复 setBounds */
let dragSession: {
  win: BrowserWindow
  offsetX: number
  offsetY: number
  width: number
  height: number
  lastX: number
  lastY: number
} | null = null

function registerChromeWindow(win: BrowserWindow): void {
  const publish = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowStatePush, { maximized: win.isMaximized() })
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.webContents.on('did-finish-load', publish)
}

function toggleWorkAreaMaximize(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

function ensureUnmaximizedForDrag(win: BrowserWindow, screenX: number, screenY: number): void {
  if (!win.isMaximized()) return
  const before = win.getBounds()
  const normal = win.getNormalBounds()
  const fraction = Math.min(1, Math.max(0, (screenX - before.x) / before.width))
  win.unmaximize()
  win.setBounds({ ...normal, x: Math.round(screenX - normal.width * fraction), y: Math.round(screenY - 23) })
}

let overlayWin: BrowserWindow | null = null
let overlayRendered = false
let overlayLoaded = false
let overlayInitialized = false
/** programmatic setBounds 期间忽略 resize/move 事件，避免把约束结果重复写回。 */
let applyingOverlayBounds = false
let overlayBoundsResetTimer: ReturnType<typeof setTimeout> | null = null
let overlayBoundsRememberTimer: ReturnType<typeof setTimeout> | null = null
let overlaySnapTimer: ReturnType<typeof setTimeout> | null = null
let overlayNativeInteraction = false
let homeWin: BrowserWindow | null = null
let tray: Tray | null = null
/** 为 true 时允许主窗口 close 真正销毁（否则 close 仅隐藏，会拦截 app.quit） */
let isAppQuitting = false
let douyu: DouyuWsClient | null = null
let simulateTimer: ReturnType<typeof setInterval> | null = null
let roomInfoTimer: ReturnType<typeof setInterval> | null = null
let roomInfoGeneration = 0
let roomGiftCatalog = new Map<string, DouyuGiftMeta>()
let roomGiftBanners: GiftBannerCatalog = {}
let effectiveGiftCatalog = new Map<string, DouyuGiftMeta>()
const requestedGiftIds = new Set<string>()
const requestedPropIds = new Set<string>()
let lastCatalogRequestedKeys = new Set<string>()
let catalogState: GiftCatalogStatus['state'] = 'idle'
let catalogUpdatedAt: number | null = null
let catalogDetail = ''
let roomInfoInputId = ''
let roomInfoResolvedId = ''
let roomInfoRefreshPromise: Promise<void> | null = null
let lastUnknownGiftRefreshAt = 0
/** 避免快速切换房间时异步图标请求乱序覆盖 */
let iconSyncGeneration = 0
let currentConfig: AppConfig = { ...DEFAULT_CONFIG }
let lastDouyuStatus: DouyuStatusPayload = {
  state: 'idle',
  detail: '在主界面输入房间号并点「开启飘屏」'
}
const EMPTY_OVERLAY_STATS: OverlayStatsPayload = {
  noble: null,
  danmakuUsers: 0,
  danmakuCount: 0,
  giftCount: 0,
  giftValue: 0
}
let lastOverlayStats: OverlayStatsPayload = { ...EMPTY_OVERLAY_STATS }
const sessionStats = new SessionStats()
let statsPublishTimer: ReturnType<typeof setTimeout> | null = null
let lastCatalogRefreshAt = 0
let simulateTick = 0

let fullscreenDisplayId: number | null = null
let stopDesktopState: (() => void) | null = null
const OVERLAY_TOPMOST_REFRESH_MS = 2_000
let overlayTopmostRefreshTimer: ReturnType<typeof setInterval> | null = null

let configStore: ConfigStore
const appearancePreview = new AppearancePreview()
let cacheManager: CacheManager
let emoticonService: EmoticonService
let cacheDialogOpen = false
let statisticsStore: StatisticsStore
let exportingStatistics = false
let instanceGuard: InstanceGuard | null = null

function saveBackgroundConfig(next: AppConfig): boolean {
  try {
    configStore.save(next)
    currentConfig = next
    return true
  } catch (error) {
    console.error('[config-save]', error)
    dialog.showErrorBox('设置未保存', error instanceof Error ? error.message : String(error))
    return false
  }
}

function broadcastConfig(): void {
  overlayWin?.webContents.send(IPC.overlayPushConfig, appearancePreview.config(currentConfig))
  homeWin?.webContents.send(IPC.overlayPushConfig, currentConfig)
}

function resetAppearancePreview(): void {
  appearancePreview.clear()
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (currentConfig.danmakuScrollDirection === 'edge') applyOverlayBounds()
    overlayWin.webContents.send(IPC.overlayPushConfig, currentConfig)
  }
}

function sendDouyuStatus(payload: DouyuStatusPayload): void {
  lastDouyuStatus = payload
  if (homeWin && !homeWin.isDestroyed()) {
    homeWin.webContents.send(IPC.douyuStatus, payload)
  }
  void syncAppIcons()
}

function sendOverlayStats(payload: OverlayStatsPayload): void {
  lastOverlayStats = payload
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IPC.overlayPushStats, payload)
  }
}

function publishSessionStats(): void {
  if (statsPublishTimer) return
  // 高峰期合并 IPC 通知，但每条接收事件仍逐一记账。
  statsPublishTimer = setTimeout(() => {
    statsPublishTimer = null
    sendOverlayStats(sessionStats.snapshot())
    broadcastGiftCatalogStatus()
  }, 100)
}

function getGiftCatalogStatus(): GiftCatalogStatus {
  const items = [...roomGiftCatalog.values()]
  return {
    state: catalogState, roomId: roomInfoResolvedId || roomInfoInputId,
    count: items.length, pricedCount: items.filter(item => item.isFree || item.priceYuan != null).length,
    manualCount: [...effectiveGiftCatalog.values()].filter(item => item.priceSource === 'manual').length,
    pendingCount: sessionStats.snapshot().unknownGiftCount || 0,
    updatedAt: catalogUpdatedAt, detail: catalogDetail,
    pricing: listGiftPricing(effectiveGiftCatalog, currentConfig.manualGiftPrices,
      currentConfig.simulateDanmaku ? [] : sessionStats.getGiftBuckets())
  }
}

function syncEffectiveGiftCatalog(): void {
  effectiveGiftCatalog = withManualGiftPrices(roomGiftCatalog, currentConfig.manualGiftPrices)
  statisticsStore?.updatePricing(roomGiftCatalog, currentConfig.manualGiftPrices)
  if (!currentConfig.simulateDanmaku) {
    sessionStats.updateCatalog(effectiveGiftCatalog, true)
    overlayWin?.webContents.send(IPC.overlayGiftCatalog, [...effectiveGiftCatalog.values()], roomGiftBanners)
    publishSessionStats()
  }
  broadcastGiftCatalogStatus()
}

function broadcastGiftCatalogStatus(): void {
  const status = getGiftCatalogStatus()
  for (const win of [homeWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.giftCatalogStatus, status)
  }
}

function stopRoomInfo(): void {
  roomInfoGeneration += 1
  if (roomInfoTimer) {
    clearInterval(roomInfoTimer)
    roomInfoTimer = null
  }
  roomInfoInputId = ''
  roomInfoResolvedId = ''
  roomInfoRefreshPromise = null
  lastUnknownGiftRefreshAt = 0
  requestedGiftIds.clear()
  requestedPropIds.clear()
  lastCatalogRequestedKeys.clear()
  catalogState = 'idle'
  catalogUpdatedAt = null
  catalogDetail = ''
  broadcastGiftCatalogStatus()
}

/** 获取当前房间礼物目录；同一时刻只允许一个请求，避免新礼物突发时重复打接口。 */
function refreshActiveRoomInfoCatalog(): Promise<void> {
  const generation = roomInfoGeneration
  const inputId = roomInfoInputId
  if (!inputId) return Promise.resolve()
  if (roomInfoRefreshPromise) return roomInfoRefreshPromise

  const task = (async (): Promise<void> => {
    catalogState = 'loading'
    catalogDetail = '正在从斗鱼获取最新礼物目录'
    broadcastGiftCatalogStatus()
    try {
      lastCatalogRefreshAt = Date.now()
      const propIds = [...new Set([
        ...[...roomGiftCatalog.values()].filter(meta => meta.catalogType === 'prop' && !requestedPropIds.has(meta.id)).map(meta => meta.id),
        ...requestedPropIds
      ])]
      lastCatalogRequestedKeys = new Set([...requestedGiftIds, ...propIds.map(id => giftCatalogKey(id, 'prop'))])
      const catalog = await fetchDouyuGiftCatalog(inputId, roomInfoResolvedId || undefined, [...requestedGiftIds], propIds)
      if (generation !== roomInfoGeneration || inputId !== roomInfoInputId) return
      if (!catalog.gifts.size) throw new Error('未获取到礼物目录，稍后会自动重试')
      roomInfoResolvedId = catalog.roomId || inputId
      if (catalog.banners) roomGiftBanners = catalog.banners
      for (const [id, meta] of catalog.gifts) {
        const previous = roomGiftCatalog.get(id)
        if (meta.priceYuan == null && !meta.isFree && !meta.isLottery && previous?.priceYuan != null) continue
        // 活动配置临时不可用时，普通目录不能把已确认的投入礼包恢复成可累计的礼物。
        roomGiftCatalog.set(id, mergeGiftMetadata(previous, meta))
        if (meta.isFree || meta.isLottery || meta.priceYuan != null) {
          if (meta.catalogType === 'prop') requestedPropIds.delete(meta.id)
          else requestedGiftIds.delete(meta.id)
        }
      }
      syncEffectiveGiftCatalog()
      catalogState = 'ready'
      catalogUpdatedAt = Date.now()
      catalogDetail = '普通礼物与奖励道具分别查价，新 ID 自动补查；抽奖按开出的奖励统计'
    } catch (error) {
      if (generation !== roomInfoGeneration) return
      catalogState = 'error'
      catalogDetail = roomGiftCatalog.size ? '刷新失败，暂时保留上次的目录价格' : '暂未取到礼物价格，会自动重试'
      // 礼物图片和价格属于增强信息，失败不能中断 WebSocket 数据流。
      console.warn('[gift-catalog]', error)
    } finally {
      if (generation === roomInfoGeneration) broadcastGiftCatalogStatus()
    }
  })()
  roomInfoRefreshPromise = task
  void task.finally(() => {
    if (roomInfoRefreshPromise === task) roomInfoRefreshPromise = null
  })
  return task
}

async function startRoomInfo(roomId: string): Promise<string | null> {
  const generation = ++roomInfoGeneration
  roomInfoInputId = roomId
  roomInfoResolvedId = roomId
  lastUnknownGiftRefreshAt = 0
  const resolvedRoomId = await resolveDouyuRoomId(roomId)
  if (generation !== roomInfoGeneration) return null
  roomInfoResolvedId = resolvedRoomId
  refreshEmoticons()
  const historical = statisticsStore.pendingGiftReferences(resolvedRoomId)
  for (const id of historical.giftIds) requestedGiftIds.add(id)
  for (const id of historical.propIds) requestedPropIds.add(id)
  // 礼物目录可在后台补齐，不再阻塞弹幕连接、漏掉加载期间的消息。
  void refreshActiveRoomInfoCatalog()
  roomInfoTimer = setInterval(() => {
    refreshEmoticons()
    if (catalogState === 'error' || requestedGiftIds.size || requestedPropIds.size || sessionStats.snapshot().unknownGiftCount || Date.now() - lastCatalogRefreshAt >= 60 * 60 * 1000) {
      void refreshRoomInfoForUnknownGift()
    }
  }, 60_000)
  return roomInfoResolvedId || roomId
}

/** 新礼物 ID 不在当前目录时，短暂冷却后主动刷新目录。 */
async function refreshRoomInfoForUnknownGift(): Promise<void> {
  if (!roomInfoInputId) return
  if (roomInfoRefreshPromise) {
    await roomInfoRefreshPromise
    // 首次加载期间新到达的礼物 ID 可能未进入那次请求，随后补查一次。
    if (!requestedGiftIds.size && !requestedPropIds.size) return
  }
  const now = Date.now()
  const hasUnqueriedId = [...requestedGiftIds, ...[...requestedPropIds].map(id => giftCatalogKey(id, 'prop'))]
    .some(key => !lastCatalogRequestedKeys.has(key))
  // 本轮查询期间又开出了另一种奖品，应继续查新 ID；失败的旧 ID 仍遵守冷却。
  if (now - lastUnknownGiftRefreshAt < 60_000 && !hasUnqueriedId) return
  lastUnknownGiftRefreshAt = now
  await refreshActiveRoomInfoCatalog()
}

function stopOverlayTopmostRefresh(): void {
  if (overlayTopmostRefreshTimer) {
    clearInterval(overlayTopmostRefreshTimer)
    overlayTopmostRefreshTimer = null
  }
}

/** 恢复真实 Z 序；moveTop 不激活窗口，也不切换可见性或透明度。 */
function applyOverlayTopmost(): void {
  if (isAppQuitting || !overlayWin || overlayWin.isDestroyed()) {
    stopOverlayTopmostRefresh()
    return
  }

  const enabled = currentConfig.overlayAlwaysOnTop === true
  overlayWin.setAlwaysOnTop(enabled, 'screen-saver')
  if (enabled && overlayWin.isVisible()) overlayWin.moveTop()

  if (!enabled || currentConfig.overlayAutoRefreshTopmost !== true) {
    stopOverlayTopmostRefresh()
    return
  }

  if (!overlayTopmostRefreshTimer) {
    overlayTopmostRefreshTimer = setInterval(() => {
      if (
        !overlayWin ||
        overlayWin.isDestroyed() ||
        currentConfig.overlayAlwaysOnTop !== true ||
        currentConfig.overlayAutoRefreshTopmost !== true
      ) {
        stopOverlayTopmostRefresh()
        return
      }
      if (!overlayWin.isVisible()) return
      overlayWin.setAlwaysOnTop(true, 'screen-saver')
      overlayWin.moveTop()
    }, OVERLAY_TOPMOST_REFRESH_MS)
  }
}

function applyOverlayWindowState(previous?: AppConfig): void {
  if (isAppQuitting || !overlayWin || overlayWin.isDestroyed()) return
  // 整体不透明度交给渲染层合成，避免 SetLayeredWindowAttributes 导致透明 HWND 闪烁。
  const edge = currentConfig.danmakuScrollDirection === 'edge'
  const modeChanged = previous?.danmakuScrollDirection !== currentConfig.danmakuScrollDirection
  const clickThrough = edge || currentConfig.clickThrough !== false
  // 穿透开启时完全交给下层窗口；关闭后恢复焦点和原生 resize hit-test，
  // 用户可以直接把鼠标移到飘屏窗口边缘调整大小。
  if (!previous || modeChanged || previous.clickThrough !== currentConfig.clickThrough) {
    overlayWin.setIgnoreMouseEvents(clickThrough, { forward: false })
    overlayWin.setFocusable(!clickThrough)
    overlayWin.setResizable(!edge)
  }
  if (!previous || modeChanged || previous.clickThrough !== currentConfig.clickThrough ||
      previous.overlayAlwaysOnTop !== currentConfig.overlayAlwaysOnTop ||
      previous.overlayAutoRefreshTopmost !== currentConfig.overlayAutoRefreshTopmost) applyOverlayTopmost()
}

/** 任务栏可见时使用工作区；全屏且任务栏未覆盖时可使用整块屏幕。 */
function overlayWorkArea(display: Display): Electron.Rectangle {
  return display.id === fullscreenDisplayId ? display.bounds : display.workArea
}

function resolvedOverlayBounds(cfg: AppConfig, display: Display): Electron.Rectangle {
  if (cfg.danmakuScrollDirection === 'edge') return edgeOverlayBounds(overlayWorkArea(display), cfg.edgeWidth, cfg.edgeSide)
  const manual = cfg.overlayManualBounds
  if (manual && manual.displayId === String(display.id)) {
    return remapOverlayBounds(manual, manual.workArea, overlayWorkArea(display))
  }
  return defaultOverlayBounds(overlayWorkArea(display))
}

/** 按配置解析飘屏所在显示器；指定 id 缺失时回退主显示器（配置仍保留，插回后可恢复） */
function resolveOverlayDisplay(cfg: AppConfig): Display {
  if (cfg.overlayDisplayMode === 'specific' && cfg.overlayDisplayId.trim()) {
    const want = cfg.overlayDisplayId.trim()
    const found = screen.getAllDisplays().find((d) => String(d.id) === want)
    if (found) return found
  }
  return screen.getPrimaryDisplay()
}

/** 设置页下拉：枚举显示器（稳定排序） */
function listOverlayDisplays(): OverlayDisplayListItem[] {
  const primary = screen.getPrimaryDisplay()
  const sorted = [...screen.getAllDisplays()].sort((a, b) => {
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x
    return a.bounds.y - b.bounds.y
  })
  let secondaryIndex = 0
  return sorted.map((d) => {
    const w = Math.round(d.bounds.width * d.scaleFactor)
    const h = Math.round(d.bounds.height * d.scaleFactor)
    const resolution = `${w}×${h} · 缩放 ${Math.round(d.scaleFactor * 100)}%`
    const isPrimary = d.id === primary.id
    const label = isPrimary
      ? `主显示器（${resolution}）`
      : (() => {
          secondaryIndex += 1
          return `扩展显示器 ${secondaryIndex}（${resolution}）`
        })()
    return {
      id: String(d.id),
      label,
      isPrimary,
      scaleFactor: d.scaleFactor,
      physicalSize: { width: w, height: h },
      bounds: {
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height
      }
    }
  })
}

function onDisplayLayoutChanged(): void {
  applyOverlayBounds()
}

function setOverlayBoundsSafely(bounds: Electron.Rectangle): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  if (sameBounds(overlayWin.getBounds(), bounds)) return
  applyingOverlayBounds = true
  if (overlayBoundsResetTimer) clearTimeout(overlayBoundsResetTimer)
  try {
    overlayWin.setBounds(bounds)
  } finally {
    // Electron 在 Windows 上通常异步派发 resize/move；留到下一个 tick 再解除保护。
    overlayBoundsResetTimer = setTimeout(() => {
      applyingOverlayBounds = false
      overlayBoundsResetTimer = null
    }, 0)
  }
}

function applyOverlayBounds(cfg: AppConfig = appearancePreview.config(currentConfig)): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const display = resolveOverlayDisplay(cfg)
  overlayWin.setMinimumSize(
    Math.min(OVERLAY_MIN_WIDTH, overlayWorkArea(display).width),
    Math.min(OVERLAY_MIN_HEIGHT, overlayWorkArea(display).height)
  )
  setOverlayBoundsSafely(resolvedOverlayBounds(cfg, display))
}

function sameBounds(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 原生无边框窗口在关闭穿透后可以直接拖动边缘缩放。位置和尺寸始终限制在
 * 目标显示器工作区内，并保存绝对边界供下次启动恢复。
 */
function rememberManualOverlayBounds(): void {
  if (currentConfig.danmakuScrollDirection === 'edge') return
  if (!overlayWin || overlayWin.isDestroyed() || applyingOverlayBounds) return
  const display = resolveOverlayDisplay(currentConfig)
  const current = overlayWin.getBounds()
  const clamped = clampOverlayBounds(current, overlayWorkArea(display))
  if (!sameBounds(current, clamped)) {
    setOverlayBoundsSafely(clamped)
  }

  const manualBounds = {
    ...clamped,
    displayId: String(display.id),
    workArea: { ...overlayWorkArea(display) }
  }
  const previousManual = currentConfig.overlayManualBounds
  if (
    !previousManual ||
    previousManual.x !== manualBounds.x ||
    previousManual.y !== manualBounds.y ||
    previousManual.width !== manualBounds.width ||
    previousManual.height !== manualBounds.height ||
    previousManual.displayId !== manualBounds.displayId
  ) {
    const next = mergeConfig({
      ...currentConfig,
      overlayManualBounds: manualBounds
    })
    if (saveBackgroundConfig(next)) broadcastConfig()
  }
}

function scheduleRememberManualOverlayBounds(): void {
  if (overlayBoundsRememberTimer) clearTimeout(overlayBoundsRememberTimer)
  overlayBoundsRememberTimer = setTimeout(() => {
    overlayBoundsRememberTimer = null
    rememberManualOverlayBounds()
  }, 140)
}

function handleOverlayBoundsChanged(): void {
  if (currentConfig.danmakuScrollDirection === 'edge') return
  if (!overlayWin || overlayWin.isDestroyed() || applyingOverlayBounds) return
  const display = resolveOverlayDisplay(currentConfig)
  const current = overlayWin.getBounds()
  const constrained = clampOverlayBounds(current, overlayWorkArea(display))
  if (!sameBounds(current, constrained)) setOverlayBoundsSafely(constrained)
  scheduleRememberManualOverlayBounds()
}

function cancelOverlaySnap(): void {
  if (overlaySnapTimer) clearTimeout(overlaySnapTimer)
  overlaySnapTimer = null
}

function finishOverlayInteraction(): void {
  if (currentConfig.danmakuScrollDirection === 'edge') { overlayNativeInteraction = false; return }
  if (!overlayNativeInteraction || !overlayWin || overlayWin.isDestroyed() || applyingOverlayBounds) return
  overlayNativeInteraction = false
  if (!currentConfig.overlayEdgeSnap) { scheduleRememberManualOverlayBounds(); return }
  const from = overlayWin.getBounds()
  const target = clampAndSnapOverlayBounds(from, overlayWorkArea(resolveOverlayDisplay(currentConfig)))
  if (sameBounds(from, target)) { scheduleRememberManualOverlayBounds(); return }
  cancelOverlaySnap()
  const start = performance.now()
  const step = (): void => {
    if (!overlayWin || overlayWin.isDestroyed() || overlayNativeInteraction) return
    const t = Math.min(1, (performance.now() - start) / 110)
    const ease = 1 - (1 - t) ** 3
    setOverlayBoundsSafely({ ...target, x: Math.round(from.x + (target.x - from.x) * ease),
      y: Math.round(from.y + (target.y - from.y) * ease) })
    if (t < 1) overlaySnapTimer = setTimeout(step, 16)
    else { overlaySnapTimer = null; scheduleRememberManualOverlayBounds() }
  }
  step()
}

function applyOverlayVisibility(): void {
  if (isAppQuitting || !overlayWin || overlayWin.isDestroyed()) return
  if (currentConfig.overlayEnabled) {
    if (!overlayLoaded || !overlayRendered) return
    applyOverlayBounds()
    applyOverlayWindowState()
    if (!overlayWin.isVisible()) overlayWin.showInactive()
  } else {
    overlayWin.hide()
    stopDouyu()
    stopSimulate()
    sendDouyuStatus({ state: 'idle', detail: '未连接' })
  }
}

function pushDanmaku(payload: DanmakuPayload): void {
  if (!currentConfig.overlayEnabled) return
  if (!overlayWin || overlayWin.isDestroyed()) return
  if (payload.kind === 'welcome' && !currentConfig.showWelcome) return
  // 免费奖励也要交给汇总器，显示开关由渲染器处理，避免抽奖结果缺项。
  if (shouldBlock(currentConfig, payload)) return
  overlayWin.webContents.send(IPC.overlayPushDanmaku, payload)
}

/** WebSocket 断开或开始重连时清空飘屏，避免旧会话弹幕与新会话混在一起 */
function clearOverlayDanmaku(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send(IPC.overlayClearDanmaku)
}

function stopDouyu(): void {
  stopRoomInfo()
  douyu?.stop()
  douyu = null
}

function stopSimulate(): void {
  if (simulateTimer) {
    clearInterval(simulateTimer)
    simulateTimer = null
  }
}

async function startDouyu(): Promise<void> {
  stopDouyu()
  const rid = normalizeRoomId(currentConfig.roomId)
  if (!rid || currentConfig.simulateDanmaku) {
    if (currentConfig.overlayEnabled && !currentConfig.simulateDanmaku) {
      sendDouyuStatus({ state: 'idle', detail: '请先填写有效房间号' })
    }
    return
  }

  sendDouyuStatus({ state: 'connecting', detail: `正在解析直播间 ${rid}…` })
  const connectionRoomId = await startRoomInfo(rid)
  if (
    !connectionRoomId ||
    !currentConfig.overlayEnabled ||
    currentConfig.simulateDanmaku ||
    normalizeRoomId(currentConfig.roomId) !== rid
  ) {
    return
  }
  sendDouyuStatus({ state: 'connecting', detail: `正在连接房间 ${rid} …` })
  const connectionGeneration = roomInfoGeneration

  douyu = new DouyuWsClient({
    roomId: connectionRoomId,
    onChat: (msg) => {
      if (connectionGeneration !== roomInfoGeneration) return
      const exclusion = chatExclusionReason(msg, connectionRoomId, currentConfig.filterRobotDanmaku)
      if (currentConfig.dailyStatisticsEnabled) statisticsStore.recordChat(connectionRoomId, msg,
        currentConfig.filterRobotDanmaku, currentConfig.saveDanmakuHistory)
      if (exclusion) { sessionStats.recordExcluded(msg, exclusion); return }
      if (!sessionStats.recordChat(msg)) return
      publishSessionStats()
      pushDanmaku({
        ...(msg.userId ? { userId: msg.userId } : {}),
        nick: msg.nick || '观众',
        text: msg.text,
        ...(msg.isHighEnergy ? { isHighEnergy: true } : {}),
        ...(msg.col ? { col: msg.col } : {}),
        ...(msg.avatar ? { avatar: msg.avatar } : {}),
        ...(msg.level ? { level: msg.level } : {}),
        ...(msg.fansName ? { fansName: msg.fansName } : {}),
        ...(msg.fansLevel ? { fansLevel: msg.fansLevel } : {}),
        ...(msg.isDiamond ? { isDiamond: true } : {}),
        ...(msg.isNoble ? { isNoble: true } : {}),
        ...(msg.nobleLevel !== undefined ? { nobleLevel: msg.nobleLevel } : {}),
        ...(msg.isRoomAdmin ? { isRoomAdmin: true } : {}),
        ...(msg.isSuper ? { isSuper: true } : {}),
        ...(msg.isVip ? { isVip: true } : {})
      })
    },
    onGift: (gift: GiftMessage) => {
      void (async (): Promise<void> => {
        if (connectionGeneration !== roomInfoGeneration) return
        // 贵族和粉丝牌特殊广播只保留当前房间。
        if (gift.roomId && gift.roomId !== connectionRoomId) return
        if (gift.type === 'dgb') {
          if (gift.roomId !== connectionRoomId) return
          if (!sessionStats.recordGift(gift)) return
          if (currentConfig.dailyStatisticsEnabled) statisticsStore.recordGift(connectionRoomId, gift)
          publishSessionStats()
        }

        const resolveMeta = (): {
          giftId: string | undefined
          meta: DouyuGiftMeta | undefined
        } => {
          const meta = resolveGiftMetadata(gift, effectiveGiftCatalog)
          return { giftId: meta?.id || gift.giftId || gift.fallbackGiftId, meta }
        }

        const resolved = resolveMeta()
        // 查价在后台补齐，接收顺序不被网络请求打乱，连批开奖可稳定关联。
        if (
          gift.type === 'dgb' &&
          !resolved.meta?.isLottery &&
          ((resolved.meta?.priceYuan == null && !resolved.meta?.isFree) || resolved.meta?.priceSource === 'manual') &&
          (gift.giftId || gift.fallbackGiftId)
        ) {
          const requests = gift.giftCatalogType === 'prop' ? requestedPropIds : requestedGiftIds
          for (const id of [gift.giftId, gift.fallbackGiftId]) {
            if (id && /^\d{1,18}$/.test(id) && id !== '0') requests.add(id)
          }
          while (requests.size > 200) requests.delete(requests.values().next().value!)
          void refreshRoomInfoForUnknownGift()
        }
        if (gift.sourceGiftId && !roomGiftCatalog.has(gift.sourceGiftId)) {
          requestedGiftIds.add(gift.sourceGiftId)
          while (requestedGiftIds.size > 200) requestedGiftIds.delete(requestedGiftIds.values().next().value!)
          void refreshRoomInfoForUnknownGift()
        }

        const giftMeta = resolved.meta
        const giftName = giftMeta?.name || gift.giftName || '礼物'
        const isFreeGift =
          Boolean(giftMeta?.isFree) ||
          isKnownFreeGiftName(giftName) ||
          giftMeta?.priceYuan === 0
        // 免费礼物仍保留数量统计，但单价强制为 0，防止目录中的 0.1 元
        // 展示价被误当成可提现金额。
        const effectiveGiftPrice = isFreeGift ? 0 : (giftMeta?.priceYuan ?? null)
        const giftKind = gift.type === 'dgb' ? (effectiveGiftPrice != null ? 'gift' : 'unknown') : gift.giftKind
        // 粉丝牌升级走普通消息排版；只有 dgb 礼物参与消费统计。
        pushDanmaku({
          kind: giftKind === 'fans' ? 'fans' : 'gift',
          giftKind,
          ...(gift.userId ? { userId: gift.userId } : {}),
          nick: gift.nick || '观众',
          text: giftKind === 'fans' ? giftName : '送出' + giftName,
          giftName,
          ...(gift.giftCount !== undefined ? { giftCount: gift.giftCount } : {}),
          ...(gift.giftHits !== undefined ? { giftHits: gift.giftHits } : {}),
          ...(gift.giftEffectId ? { giftEffectId: gift.giftEffectId } : {}),
          ...(gift.giftBannerId ? { giftBannerId: gift.giftBannerId } : {}),
          ...(gift.giftSkinId ? { giftSkinId: gift.giftSkinId } : {}),
          ...(resolved.giftId ? { giftId: resolved.giftId } : {}),
          ...(gift.giftCatalogType ? { giftCatalogType: gift.giftCatalogType } : {}),
          ...(gift.sourceGiftId ? { sourceGiftId: gift.sourceGiftId } : {}),
          ...(gift.fallbackGiftId ? { fallbackGiftId: gift.fallbackGiftId } : {}),
          ...(giftMeta?.isLottery ? { giftIsLottery: true } : {}),
          ...(giftMeta?.image || gift.giftImage
            ? { giftImage: giftMeta?.image || gift.giftImage }
            : {}),
          ...(effectiveGiftPrice != null ? { giftPrice: effectiveGiftPrice } : {}),
          ...(giftMeta?.priceSource ? { giftPriceSource: giftMeta.priceSource } : {}),
          ...(isFreeGift ? { giftIsFree: true } : {}),
          ...(gift.avatar ? { avatar: gift.avatar } : {}),
          ...(gift.level ? { level: gift.level } : {}),
          ...(gift.fansName ? { fansName: gift.fansName } : {}),
          ...(gift.fansLevel ? { fansLevel: gift.fansLevel } : {}),
          ...(gift.isDiamond ? { isDiamond: true } : {}),
          ...(gift.isNoble ? { isNoble: true } : {}),
          ...(gift.nobleLevel !== undefined ? { nobleLevel: gift.nobleLevel } : {}),
          ...(gift.isRoomAdmin ? { isRoomAdmin: true } : {}),
          ...(gift.isSuper ? { isSuper: true } : {}),
          ...(gift.isVip ? { isVip: true } : {})
        })
      })().catch((error) => console.error('[douyu-gift]', error))
    },
    onEnter: (enter) => {
      if (connectionGeneration !== roomInfoGeneration) return
      if (!currentConfig.showWelcome) return
      const nobleLevel = Math.max(0, Number(enter.nobleLevel) || 0)
      if (
        currentConfig.welcomeNobleLevel > 0 &&
        nobleLevel < currentConfig.welcomeNobleLevel
      ) return
      pushDanmaku({
        kind: 'welcome',
        ...(enter.userId ? { userId: enter.userId } : {}),
        nick: enter.nick || '观众',
        text: '进入直播间',
        ...(enter.avatar ? { avatar: enter.avatar } : {}),
        ...(enter.level ? { level: enter.level } : {}),
        ...(nobleLevel > 0 ? { nobleLevel, isNoble: true } : {})
      })
    },
    onRoomData: (roomData) => {
      if (connectionGeneration !== roomInfoGeneration) return
      if (roomData.roomId && roomData.roomId !== connectionRoomId) return
      sessionStats.setNoble(roomData.nobleCount)
      publishSessionStats()
    },
    onError: (e) => {
      if (connectionGeneration !== roomInfoGeneration) return
      console.error('[douyu]', e)
      sendDouyuStatus({ state: 'error', detail: e.message })
    },
    onStatus: (s) => {
      if (connectionGeneration !== roomInfoGeneration) return
      if (s === 'connecting' || s === 'closed') {
        clearOverlayDanmaku()
      }
      if (s === 'open') {
        sendDouyuStatus({ state: 'socket-open', detail: '已连接，等待登录结果…' })
      } else if (s === 'closed') {
        sendDouyuStatus({ state: 'closed', detail: '连接已断开，将自动重试' })
      } else if (s === 'connecting') {
        sendDouyuStatus({ state: 'connecting', detail: `正在连接房间 ${rid} …` })
      }
    },
    onLoginRes: (ok, detail) => {
      if (connectionGeneration !== roomInfoGeneration) return
      if (ok) {
        sendDouyuStatus({ state: 'login-ok', detail: '已连接，正在接收本直播间消息。' })
      } else {
        sendDouyuStatus({ state: 'login-fail', detail: detail || '登录失败，请检查房间号或网络' })
      }
    }
  })
  douyu.start()
}

function startSimulate(): void {
  stopSimulate()
  if (!currentConfig.simulateDanmaku) return
  sendDouyuStatus({ state: 'login-ok', detail: '模拟弹幕模式（未连接斗鱼）' })
  sessionStats.setNoble(128)
  publishSessionStats()
  const profiles = [
    {
      userId: '10001',
      nick: '测试用户',
      level: '32',
      fansName: '小淳粉丝',
      fansLevel: '18',
      isDiamond: true,
      avatar: 'https://apic.douyucdn.cn/upload/avatar/002/48/83/16_avatar_big.jpg'
    },
    { userId: '10002', nick: '模拟弹幕', level: '68', fansName: '斗鱼观察员', fansLevel: '7' },
    { userId: '10003', nick: '性能压测', level: '21', fansName: '飘屏体验官', fansLevel: '26' },
    {
      userId: '10004',
      nick: 'Electron',
      level: '75',
      fansName: '开发者',
      fansLevel: '39',
      isNoble: true,
      nobleLevel: 6
    },
    { userId: '10005', nick: 'Canvas', level: '11', fansName: '新朋友', fansLevel: '3' }
  ]
  const texts = [
    '这是一条模拟弹幕',
    '这是一条用于验证自动换行的长弹幕：头像固定在首行左侧，昵称、等级、粉丝牌和完整正文都必须在窗口宽度内自然换行，不能被省略。',
    '飘屏测试中……',
    '1234567890',
    'Hello 斗鱼'
  ]
  const gifts = [
    {
      giftId: '20006',
      giftName: '赞',
      giftCount: 1,
      giftHits: 1,
      giftPrice: 0,
      giftIsFree: true,
      giftImage:
        'https://gfs-op.douyucdn.cn/dygift/2018/11/29/c7b50fe3e472edeb9e21b1a3fc877321.png'
    },
    {
      giftId: '24491',
      giftName: '小心心',
      giftCount: 3,
      giftHits: 6,
      giftPrice: 0.1,
      giftImage:
        'https://gfs-op.douyucdn.cn/dygift/2025/04/15/fb9293026dfdb3289befc454fa77c223.png'
    },
    {
      giftId: '20005',
      giftName: '超级火箭',
      giftCount: 1,
      giftHits: 12,
      giftPrice: 2000,
      giftImage:
        'https://gfs-op.douyucdn.cn/dygift/2024/01/19/bc0a7bb6c8e0b083d1dd1e970943434a.png'
    },
    {
      giftId: '20000',
      giftName: '100鱼丸',
      giftCount: 20,
      giftHits: 20,
      giftPrice: 0,
      giftIsFree: true,
      giftImage:
        'https://gfs-op.douyucdn.cn/dygift/2018/12/18/72f59a35489207e7dd88618304a362b3.png'
    }
  ]
  sessionStats.updateCatalog(new Map(gifts.map((gift) => [gift.giftId, {
    id: gift.giftId, name: gift.giftName, image: gift.giftImage,
    priceYuan: gift.giftPrice, isFree: gift.giftIsFree === true
  }])))
  simulateTimer = setInterval(() => {
    simulateTick += 1
    const profile = profiles[simulateTick % profiles.length]!
    if (simulateTick % 10 === 0) {
      pushDanmaku({ ...profile, kind: 'welcome', text: '进入直播间' })
    } else if (simulateTick % 4 === 0) {
      const gift = gifts[Math.floor(simulateTick / 4) % gifts.length]!
      sessionStats.recordGift({ ...profile, ...gift, type: 'dgb', giftKind: 'gift', messageId: `sim:${simulateTick}` })
      publishSessionStats()
      pushDanmaku({
        ...profile,
        ...gift,
        kind: 'gift',
        giftKind: 'gift',
        text: `送出${gift.giftName}`
      })
    } else {
      sessionStats.recordChat({ userId: profile.userId, messageId: `sim:${simulateTick}` })
      publishSessionStats()
      pushDanmaku({
        ...profile,
        text: texts[simulateTick % texts.length]!
      })
    }
  }, Math.max(200, currentConfig.simulateIntervalMs))
}

async function syncAppIcons(): Promise<void> {
  const gen = ++iconSyncGeneration
  const rid = normalizeRoomId(currentConfig.roomId)
  const windows = [homeWin, overlayWin]

  const useRoomAvatar =
    currentConfig.overlayEnabled &&
    Boolean(rid) &&
    !currentConfig.simulateDanmaku &&
    lastDouyuStatus.state === 'login-ok'

  // 房间头像只用于主面板，应用、任务栏和托盘始终使用星幕自己的图标。
  applyTrayAndWindowIcons(tray, windows, getDefaultIconImage())
  const applyAndHomeLogo = (img: NativeImage): void => {
    pushHomeLogoToRenderer(homeWin, img, IPC.homePushLogo)
  }

  if (!useRoomAvatar) {
    applyAndHomeLogo(getDefaultIconImage())
    return
  }

  try {
    const avatarIcon = await fetchAnchorAvatarAsIcon(rid)
    if (gen !== iconSyncGeneration) return
    applyAndHomeLogo(avatarIcon ?? getDefaultIconImage())
  } catch (e) {
    console.error('[app-icons]', e)
    if (gen !== iconSyncGeneration) return
    applyAndHomeLogo(getDefaultIconImage())
  }
}

function refreshSources(): void {
  if (!overlayInitialized || isAppQuitting) return
  stopDouyu()
  stopSimulate()
  clearOverlayDanmaku()
  refreshEmoticons()
  if (currentConfig.overlayEnabled) {
    if (sessionStats.begin(currentConfig.simulateDanmaku ? 'simulate' : `live:${normalizeRoomId(currentConfig.roomId)}`)) {
      roomGiftCatalog = new Map()
    }
    syncEffectiveGiftCatalog()
  }
  sendOverlayStats(sessionStats.snapshot())
  if (!currentConfig.overlayEnabled) {
    sendDouyuStatus({ state: 'idle' })
    void syncAppIcons()
    return
  }
  if (currentConfig.simulateDanmaku) {
    startSimulate()
    void syncAppIcons()
    return
  }
  void startDouyu()
  void syncAppIcons()
}

/** 仅当弹幕源关键字段“实际变化”时才需重启（避免同值写入导致无意义重连） */
function sourceConfigChanged(prev: AppConfig, next: AppConfig): boolean {
  return (
    prev.overlayEnabled !== next.overlayEnabled ||
    prev.simulateDanmaku !== next.simulateDanmaku ||
    (next.overlayEnabled && !next.simulateDanmaku && prev.roomId !== next.roomId)
  )
}

function refreshEmoticons(): void {
  const room = currentConfig.overlayEnabled && currentConfig.showDouyuEmoticons
    ? roomInfoResolvedId || normalizeRoomId(currentConfig.roomId) : ''
  void emoticonService.activate(room).catch(error => console.warn('[emoticons]', error))
}

function finishOverlayInitialization(): void {
  if (!overlayLoaded || !overlayRendered || overlayInitialized || isAppQuitting) return
  overlayInitialized = true
  applyOverlayVisibility()
  refreshSources()
}

function createOverlayWindow(): BrowserWindow {
  const display = resolveOverlayDisplay(currentConfig)
  const ob = resolvedOverlayBounds(currentConfig, display)

  const win = new BrowserWindow({
    x: ob.x,
    y: ob.y,
    width: ob.width,
    height: ob.height,
    show: false,
    paintWhenInitiallyHidden: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    // 保留原生 resize 能力：关闭「鼠标穿透」后可直接拖动无边框窗口边缘调整大小。
    resizable: true,
    minWidth: Math.min(OVERLAY_MIN_WIDTH, overlayWorkArea(display).width),
    minHeight: Math.min(OVERLAY_MIN_HEIGHT, overlayWorkArea(display).height),
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: currentConfig.overlayAlwaysOnTop === true,
    // clickThrough 开启时会在 applyOverlayWindowState 中临时设为不可聚焦；
    // 这里必须先允许聚焦，才能在设置中关闭穿透后恢复原生 resize hit-test。
    focusable: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      // 沙箱 + 经 Vite 打包的 ESM preload 在部分环境下会导致脚本未执行，从而无 settingsApi
      sandbox: false
    }
  })

  // 实际几何边界避开可见任务栏，置顶层级保持在游戏和普通窗口上方。
  win.setAlwaysOnTop(currentConfig.overlayAlwaysOnTop === true, 'screen-saver')
  win.setMenuBarVisibility(false)

  win.webContents.on('did-start-loading', () => {
    overlayRendered = false
    overlayLoaded = false
    overlayInitialized = false
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  })
  win.webContents.on('did-finish-load', () => {
    overlayLoaded = true
    win.webContents.send(IPC.overlayPushConfig, appearancePreview.config(currentConfig))
    win.webContents.send(IPC.overlayPushStats, lastOverlayStats)
    applyOverlayWindowState()
    finishOverlayInitialization()
  })

  win.on('resize', () => {
    handleOverlayBoundsChanged()
  })
  win.on('move', () => {
    handleOverlayBoundsChanged()
  })
  const beginInteraction = (): void => { cancelOverlaySnap(); overlayNativeInteraction = true }
  win.on('will-move', beginInteraction)
  win.on('will-resize', beginInteraction)
  win.on('moved', finishOverlayInteraction)
  win.on('resized', finishOverlayInteraction)
  win.on('closed', () => {
    if (overlayWin === win) {
      overlayWin = null
      stopOverlayTopmostRefresh()
      cancelOverlaySnap()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/overlay.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  return win
}

function createHomeWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 880,
    height: 650,
    minWidth: 620,
    minHeight: 540,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#f4f7f7',
    maximizable: true,
    title: APP_DISPLAY_NAME,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false
    }
  })

  registerChromeWindow(win)

  win.webContents.on('did-start-loading', resetAppearancePreview)
  win.webContents.on('render-process-gone', resetAppearancePreview)
  win.on('closed', resetAppearancePreview)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/home.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/home.html'))
  }

  win.on('close', (e) => {
    if (isAppQuitting) return
    e.preventDefault()
    void (async () => {
      if (!currentConfig.dismissedTrayCloseHint) {
        try {
          await dialog.showMessageBox(win, {
            type: 'info',
            title: APP_DISPLAY_NAME,
            message: '已缩小到右下角托盘',
            detail:
              '关闭主窗口不会退出程序。请在任务栏右下角托盘通知区域找到本应用图标；双击可再次打开主界面，右键菜单中可选择「退出」彻底关闭。',
            buttons: ['知道了'],
            defaultId: 0,
            noLink: true
          })
        } catch {
          /* 窗口已销毁等 */
        }
        saveBackgroundConfig(mergeConfig({
          ...currentConfig,
          dismissedTrayCloseHint: true
        }))
      }
      if (!win.isDestroyed()) win.hide()
    })()
  })

  win.webContents.on('did-finish-load', () => {
    win.webContents.send(IPC.douyuStatus, lastDouyuStatus)
    void syncAppIcons()
  })

  return win
}

function openHome(): void {
  if (!homeWin || homeWin.isDestroyed()) return
  if (homeWin.isMinimized()) homeWin.restore()
  homeWin.show()
  homeWin.focus()
}

function navigateMainPage(page: 'home' | 'settings', section?: string): void {
  if (!homeWin || homeWin.isDestroyed()) return
  if (!homeWin.webContents.getURL().includes(`/${page}.html`)) {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void homeWin.loadURL(`${devUrl}/${page}.html${section ? `?section=${encodeURIComponent(section)}` : ''}`)
    else void homeWin.loadFile(join(__dirname, `../renderer/${page}.html`), section ? { query: { section } } : {})
  } else if (section) homeWin.webContents.send(IPC.settingsSection, section)
  openHome()
}

function openSettings(section?: string): void {
  navigateMainPage('settings', section)
}

function quitAppFully(): void {
  isAppQuitting = true
  app.quit()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const on = currentConfig.overlayEnabled
  const upd = getCachedUpdateResult()
  const menu = Menu.buildFromTemplate([
    ...(upd?.ok && upd.hasUpdate && upd.openUrl && upd.latestVersion
      ? ([
          {
            label: `新版本 v${upd.latestVersion}（前往下载）`,
            click: () => {
              const u = upd.openUrl
              if (u && isAllowedExternalUrl(u)) void shell.openExternal(u)
            }
          },
          { type: 'separator' as const }
        ] as const)
      : []),
    {
      label: on ? '关闭飘屏（停止连接）' : '开启飘屏',
      click: () => {
        if (!saveBackgroundConfig(mergeConfig({ ...currentConfig, overlayEnabled: !currentConfig.overlayEnabled }))) return
        applyOverlayVisibility()
        broadcastConfig()
        refreshSources()
      }
    },
    {
      label: '打开主界面',
      click: () => {
        openHome()
      }
    },
    {
      label: '设置…',
      click: () => {
        openSettings()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitAppFully()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function createTray(): void {
  tray = new Tray(trayImageFromSource(getDefaultIconImage()))
  tray.setToolTip(APP_DISPLAY_NAME)
  tray.on('double-click', () => openHome())
  rebuildTrayMenu()
}

function registerIpc(): void {
  const requireSettings = (event: Electron.IpcMainInvokeEvent): void => {
    if (!homeWin || event.sender.id !== homeWin.webContents.id) throw new Error('请从设置页管理缓存位置。')
  }
  const saveCacheDirectory = (directory: string): ReturnType<CachePaths['info']> => {
    const next = mergeConfig({ ...currentConfig, cacheDirectory: directory })
    configStore.save(next)
    currentConfig = next
    broadcastConfig()
    return cachePaths.info(next.cacheDirectory)
  }
  ipcMain.handle(IPC.cacheLocation, event => { requireSettings(event); return cachePaths.info(currentConfig.cacheDirectory) })
  ipcMain.handle(IPC.cacheChooseDirectory, async event => {
    requireSettings(event)
    if (cacheDialogOpen) throw new Error('另一个缓存操作窗口已打开。')
    cacheDialogOpen = true
    try {
      const choice = await dialog.showOpenDialog(homeWin!, { title: '选择缓存存放位置', buttonLabel: '使用此位置',
        defaultPath: dirname(cachePaths.activeDirectory), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] })
      if (choice.canceled || !choice.filePaths[0]) return null
      return saveCacheDirectory(cachePaths.select(choice.filePaths[0]))
    } finally { cacheDialogOpen = false }
  })
  ipcMain.handle(IPC.cacheResetDirectory, event => { requireSettings(event); return saveCacheDirectory('') })
  ipcMain.handle(IPC.cacheOpenDirectory, event => { requireSettings(event); return shell.openPath(cachePaths.activeDirectory) })
  ipcMain.handle(IPC.appRestart, event => {
    requireSettings(event)
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    app.relaunch({ execPath: portable && existsSync(portable) ? portable : process.execPath, args: process.argv.slice(1) })
    setTimeout(() => app.quit(), 80)
    return true
  })
  ipcMain.handle(IPC.emoticonCatalogGet, () => emoticonService.snapshot())
  ipcMain.handle(IPC.cacheInventory, event => {
    if (!homeWin || event.sender.id !== homeWin.webContents.id) throw new Error('请从设置页查看存储。')
    return cacheManager.inventory()
  })
  ipcMain.handle(IPC.cacheClear, async (event): Promise<CacheClearResult> => {
    if (!homeWin || event.sender.id !== homeWin.webContents.id) throw new Error('请从设置页清理缓存。')
    if (cacheDialogOpen) throw new Error('缓存清理窗口已打开。')
    cacheDialogOpen = true
    try {
      const inventory = await cacheManager.inventory()
      const confirmation = await dialog.showMessageBox(homeWin, {
        type: 'question', title: `清理 ${APP_NAME} 缓存`, message: `清理约 ${formatBytes(inventory.bytes)} 缓存？`,
        detail: `当前与已知旧缓存位置（仅清理以下缓存类别）：\n${inventory.directories.join('\n')}\n\n可删除的内容：\n${inventory.groups.map(item => `• ${item.name}：${formatBytes(item.bytes)}\n  ${item.description}`).join('\n')}\n\n同时清空礼物透明动画的内存缓存：${formatBytes(giftVideoCacheBytes())}（不保存到硬盘，退出时也会释放）。\n\n以下内容始终保留：\n${inventory.protectedItems.map(item => `• ${item}`).join('\n')}\n\n图片、礼物条、动画和表情目录会在需要时重新获取。正在使用的文件可能无法立即清除。`,
        buttons: ['取消', '清理缓存'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return { canceled: true }
      clearGiftVideoCache()
      await emoticonService.invalidateCache()
      await invalidateAvatarCache()
      return await cacheManager.clear()
    } finally { cacheDialogOpen = false }
  })
  ipcMain.on(IPC.overlayRendered, (event) => {
    if (isAppQuitting || !overlayWin || event.sender.id !== overlayWin.webContents.id || overlayRendered) return
    overlayRendered = true
    event.sender.send(IPC.overlayGiftCatalog, [...effectiveGiftCatalog.values()], roomGiftBanners)
    finishOverlayInitialization()
  })
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.handle(IPC.statisticsQuery, (_e, query: StatisticsQuery) => statisticsStore.query(query))
  ipcMain.handle(IPC.statisticsChats, (event, query: ChatHistoryQuery) => {
    if (!homeWin || event.sender.id !== homeWin.webContents.id) throw new Error('请从主面板查询弹幕。')
    return statisticsStore.chats.query(query)
  })
  ipcMain.handle(IPC.statisticsExport, async (event, query: StatisticsQuery): Promise<StatisticsExportResult> => {
    if (!homeWin || event.sender.id !== homeWin.webContents.id) throw new Error('请从主面板导出统计。')
    if (exportingStatistics) throw new Error('已有一个统计导出正在进行。')
    exportingStatistics = true
    try {
      const result = statisticsStore.query(query)
      if (!result.days.length) throw new Error('当前筛选范围没有可导出的统计记录。')
      const save = await dialog.showSaveDialog(homeWin, { title: '导出每日统计',
        defaultPath: join(app.getPath('documents'), `${APP_NAME} 统计 ${localDateKey()}.xlsx`),
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }], properties: ['showOverwriteConfirmation'] })
      if (save.canceled || !save.filePath) return { canceled: true }
      const filePath = /\.xlsx$/i.test(save.filePath) ? save.filePath : `${save.filePath}.xlsx`
      const { exportStatisticsWorkbook } = await import('./statisticsExport')
      if (roomInfoRefreshPromise) await roomInfoRefreshPromise
      const latest = statisticsStore.query(query)
      await exportStatisticsWorkbook(filePath, latest.days, statisticsStore.chats.read(query))
      statisticsStore.flush()
      return { canceled: false, filePath }
    } finally { exportingStatistics = false }
  })

  ipcMain.handle(IPC.appCheckUpdate, async (_e, force?: boolean) => {
    const r = await checkForUpdates(Boolean(force))
    rebuildTrayMenu()
    return r
  })

  ipcMain.handle(IPC.appOpenExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) return false
    const u = url.trim()
    if (!isAllowedExternalUrl(u)) return false
    await shell.openExternal(u)
    return true
  })

  ipcMain.handle(IPC.displayList, (): OverlayDisplayListItem[] => listOverlayDisplays())

  ipcMain.handle(IPC.configGet, () => currentConfig)
  ipcMain.on(IPC.configPreview, (event, partial: unknown) => {
    if (!homeWin || homeWin.isDestroyed() || event.sender.id !== homeWin.webContents.id) return
    if (partial === null) { resetAppearancePreview(); return }
    const preview = appearancePreview.update(currentConfig, partial)
    if (currentConfig.danmakuScrollDirection === 'edge') applyOverlayBounds(preview)
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(IPC.overlayPushConfig, preview)
  })
  ipcMain.handle(IPC.configStorageGet, () => configStore.info)
  ipcMain.handle(IPC.giftCatalogGet, () => getGiftCatalogStatus())
  ipcMain.handle(IPC.giftCatalogRefresh, async () => {
    await refreshActiveRoomInfoCatalog()
    return getGiftCatalogStatus()
  })
  ipcMain.handle(IPC.giftPriceSet, (_e, patch: GiftPricePatch) => {
    if (!patch || typeof patch.giftId !== 'string' || !/^\d{1,18}$/.test(patch.giftId) || patch.giftId === '0') {
      throw new Error('请输入有效的斗鱼礼物 ID（数字）。')
    }
    if (patch.catalogType !== undefined && patch.catalogType !== 'gift' && patch.catalogType !== 'prop') {
      throw new Error('请选择普通礼物或奖励道具。')
    }
    const key = giftCatalogKey(patch.giftId, patch.catalogType)
    if (patch.priceYuan !== null && roomGiftCatalog.get(key)?.isLottery) {
      throw new Error('抽奖道具没有固定的开出价值，请对实际开出的奖励补价。')
    }
    const manualGiftPrices = { ...currentConfig.manualGiftPrices }
    if (patch.priceYuan === null) delete manualGiftPrices[key]
    else {
      const priceYuan = parseManualGiftPrice(patch.priceYuan)
      if (priceYuan == null) throw new Error('单价请填写 0 至 1000000 元，最多两位小数；0 表示免费。')
      if (!manualGiftPrices[key] && Object.keys(manualGiftPrices).length >= 1000) {
        throw new Error('已保存 1000 种手动价格，请先清除不再需要的补价。')
      }
      manualGiftPrices[key] = { name: String(patch.name ?? '').trim().slice(0, 60), priceYuan }
    }
    const next = mergeConfig({ ...currentConfig, manualGiftPrices })
    configStore.save(next)
    currentConfig = next
    syncEffectiveGiftCatalog()
    broadcastConfig()
    return getGiftCatalogStatus()
  })
  ipcMain.handle(IPC.configOpenDirectory, async () => {
    const directory = getWritableDataDirectory()
    mkdirSync(directory, { recursive: true })
    return await shell.openPath(directory)
  })

  ipcMain.handle(IPC.configSet, (_e, partial: Partial<AppConfig>) => {
    if (partial.cacheDirectory !== undefined && partial.cacheDirectory !== currentConfig.cacheDirectory) throw new Error('请在“存储与缓存”中选择缓存位置。')
    const prevConfig = currentConfig
    if (partial.roomId !== undefined) {
      partial.roomId = normalizeRoomId(String(partial.roomId))
    }
    const resetsManualBounds =
      (partial.overlayDisplayMode !== undefined && partial.overlayDisplayMode !== currentConfig.overlayDisplayMode) ||
      (partial.overlayDisplayId !== undefined && partial.overlayDisplayId !== currentConfig.overlayDisplayId)
    const nextConfig = mergeConfig({
      ...currentConfig,
      ...partial,
      ...(resetsManualBounds ? { overlayManualBounds: null } : {})
    })
    // 预览不写盘；保存成功后才改变运行配置，失败时撤回预览并显示错误。
    try { configStore.save(nextConfig) }
    catch (error) { resetAppearancePreview(); throw error }
    currentConfig = nextConfig
    appearancePreview.acceptSaved(currentConfig, partial)
    if (prevConfig.showDouyuEmoticons !== nextConfig.showDouyuEmoticons) refreshEmoticons()
    if (prevConfig.dailyStatisticsEnabled !== nextConfig.dailyStatisticsEnabled || prevConfig.saveDanmakuHistory !== nextConfig.saveDanmakuHistory) statisticsStore.flush()
    if (JSON.stringify(prevConfig.manualGiftPrices) !== JSON.stringify(nextConfig.manualGiftPrices)) syncEffectiveGiftCatalog()
    const overlayVisibilityChanged = prevConfig.overlayEnabled !== currentConfig.overlayEnabled
    const overlayDisplayChanged =
      prevConfig.overlayDisplayMode !== currentConfig.overlayDisplayMode ||
      prevConfig.overlayDisplayId !== currentConfig.overlayDisplayId
    const overlayModeChanged = prevConfig.danmakuScrollDirection !== currentConfig.danmakuScrollDirection
    const edgeBoundsChanged = prevConfig.edgeSide !== currentConfig.edgeSide || prevConfig.edgeWidth !== currentConfig.edgeWidth
    if (overlayModeChanged) {
      cancelOverlaySnap()
      overlayNativeInteraction = false
      if (overlayBoundsRememberTimer) clearTimeout(overlayBoundsRememberTimer)
      overlayBoundsRememberTimer = null
    }
    if (overlayVisibilityChanged) applyOverlayVisibility()
    else if (overlayDisplayChanged || resetsManualBounds || overlayModeChanged || edgeBoundsChanged) applyOverlayBounds()
    applyOverlayWindowState(prevConfig)
    if (!currentConfig.overlayEdgeSnap) cancelOverlaySnap()
    broadcastConfig()
    if (sourceConfigChanged(prevConfig, currentConfig)) {
      refreshSources()
    } else if (
      currentConfig.overlayEnabled &&
      currentConfig.simulateDanmaku &&
      prevConfig.simulateIntervalMs !== currentConfig.simulateIntervalMs
    ) {
      // 只重启模拟计时器，不清空现有消息或统计。
      startSimulate()
    }
    rebuildTrayMenu()
    return currentConfig
  })

  ipcMain.handle(IPC.douyuReconnect, () => {
    refreshSources()
    return true
  })

  ipcMain.handle(IPC.windowOpenSettings, (_e, section?: string) => {
    openSettings(section === 'history' ? section : undefined)
    return true
  })

  ipcMain.on(IPC.windowClose, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.close()
  })

  ipcMain.on(IPC.windowMinimize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.minimize()
  })

  ipcMain.on(IPC.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    toggleWorkAreaMaximize(win)
  })
  ipcMain.handle(IPC.windowOpenHome, () => {
    navigateMainPage('home')
    return true
  })

  ipcMain.handle(IPC.windowStateGet, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) }
  })

  ipcMain.on(IPC.windowDragStart, (e, screenX: number, screenY: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    ensureUnmaximizedForDrag(win, screenX, screenY)
    const b = win.getBounds()
    dragSession = {
      win,
      offsetX: screenX - b.x,
      offsetY: screenY - b.y,
      width: b.width,
      height: b.height,
      lastX: b.x,
      lastY: b.y
    }
  })

  ipcMain.on(IPC.windowDragMove, (e, screenX: number, screenY: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (!dragSession || dragSession.win.isDestroyed() || dragSession.win.id !== win.id) return
    const { offsetX, offsetY, width, height } = dragSession
    const nx = Math.round(screenX - offsetX)
    const ny = Math.round(screenY - offsetY)
    if (nx === dragSession.lastX && ny === dragSession.lastY) return
    dragSession.lastX = nx
    dragSession.lastY = ny
    win.setBounds({
      x: nx,
      y: ny,
      width,
      height
    })
  })

  ipcMain.on(IPC.windowDragEnd, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (
      win &&
      !win.isDestroyed() &&
      dragSession &&
      dragSession.win.id === win.id
    ) {
      // 原生窗口负责保存还原位置。
    }
    dragSession = null
  })
}

function whenReady(): void {
  installGiftMediaProtocol()
  cacheManager = new CacheManager(configStore.info.directory, session.defaultSession, cachePaths.activeDirectory, () => cachePaths.directories())
  emoticonService = new EmoticonService(configStore.info.directory, catalog => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(IPC.emoticonCatalogPush, catalog)
  }, cachePaths.activeDirectory)
  statisticsStore = new StatisticsStore(join(configStore.info.directory, 'statistics'), Date.now,
    message => dialog.showErrorBox('统计历史保存失败', message))
  statisticsStore.load()
  statisticsStore.updatePricing(roomGiftCatalog, currentConfig.manualGiftPrices)
  effectiveGiftCatalog = withManualGiftPrices(roomGiftCatalog, currentConfig.manualGiftPrices)
  if (currentConfig.overlayManualBounds && !currentConfig.overlayManualBounds.workArea) {
    currentConfig.overlayManualBounds.workArea = { ...overlayWorkArea(resolveOverlayDisplay(currentConfig)) }
  }
  registerIpc()
  overlayWin = createOverlayWindow()
  applyOverlayTopmost()
  homeWin = createHomeWindow()
  createTray()
  void syncAppIcons()

  scheduleUpdateChecks(
    () => homeWin,
    () => {
      rebuildTrayMenu()
    }
  )

  screen.on('display-metrics-changed', onDisplayLayoutChanged)
  screen.on('display-added', onDisplayLayoutChanged)
  screen.on('display-removed', onDisplayLayoutChanged)
  stopDesktopState = watchFullscreenDisplay((displayId) => {
    fullscreenDisplayId = displayId
    applyOverlayBounds()
  })

  openHome()

}

app.setName(APP_DISPLAY_NAME)
const legacyConfigPaths = getLegacyConfigPaths()
const dataDirectory = getWritableDataDirectory()
mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)
configStore = new ConfigStore(dataDirectory, legacyConfigPaths)
currentConfig = configStore.load()
const cachePaths = new CachePaths(dataDirectory, currentConfig.cacheDirectory)
setRuntimeCacheDirectory(cachePaths.activeDirectory)
// Chromium 的图片、脚本及图形缓存集中存放，升级 EXE 不产生新的数据目录。
for (const [key, name] of [['sessionData', 'chromium'], ['logs', 'logs'], ['crashDumps', 'crash-dumps']] as const) {
  const directory = join(cachePaths.activeDirectory, name)
  mkdirSync(directory, { recursive: true })
  app.setPath(key, directory)
}
app.commandLine.appendSwitch('disk-cache-size', String(HTTP_CACHE_BYTES))
// 同一账户只运行一个实例，避免托盘中的旧进程把新设置覆盖回去。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openHome()
  })
  void acquireInstanceGuard(dataDirectory, () => { if (app.isReady()) openHome() }).then(async guard => {
    if (!guard) { app.quit(); return }
    instanceGuard = guard
    await app.whenReady()
    whenReady()
  }).catch(async error => {
    await app.whenReady()
    dialog.showErrorBox(`${APP_NAME} 无法启动`, error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

app.on('window-all-closed', () => {
  // 主窗口关闭后继续驻留托盘；完全退出由托盘菜单处理。
})

app.on('before-quit', () => {
  isAppQuitting = true
  clearGiftVideoCache()
  overlayRendered = false
  // 先撤下透明原生窗口，再保存和断连，防止清空、重排过程闪现默认弹幕框。
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
  statisticsStore?.flush()
  void instanceGuard?.close()
  instanceGuard = null
  cancelOverlaySnap()
  stopOverlayTopmostRefresh()
  stopDesktopState?.()
  stopDesktopState = null
  if (statsPublishTimer) clearTimeout(statsPublishTimer)
  if (overlayBoundsRememberTimer) {
    clearTimeout(overlayBoundsRememberTimer)
    overlayBoundsRememberTimer = null
    rememberManualOverlayBounds()
  }
  stopDouyu()
  stopSimulate()
  tray?.destroy()
  tray = null
})

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
})
