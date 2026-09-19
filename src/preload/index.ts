import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AppConfig, OverlayDisplayListItem } from '../shared/config'
import type { AppearancePatch } from '../shared/appearancePreview'
import type { UpdateCheckResult } from '../shared/updateCheck'
import type { DanmakuPayload, OverlayStatsPayload, GiftMetadata, GiftCatalogStatus, GiftPricePatch, WindowChromeState, GiftBannerCatalog } from '../shared/types'
import type { DouyuStatusPayload } from '../shared/douyuStatus'
import type { ConfigStorageInfo, CacheInventory, CacheClearResult, CacheLocationInfo } from '../shared/storage'
import type { EmoticonCatalog } from '../shared/emoticons'
import type { StatisticsQuery, StatisticsResult, StatisticsExportResult, ChatHistoryQuery, ChatHistoryResult } from '../shared/statistics'

contextBridge.exposeInMainWorld('overlayApi', {
  getEmoticonCatalog: (): Promise<EmoticonCatalog> => ipcRenderer.invoke(IPC.emoticonCatalogGet),
  onEmoticonCatalog(cb: (catalog: EmoticonCatalog) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, catalog: EmoticonCatalog): void => cb(catalog)
    ipcRenderer.on(IPC.emoticonCatalogPush, handler)
    return () => ipcRenderer.removeListener(IPC.emoticonCatalogPush, handler)
  },
  rendered: (): void => ipcRenderer.send(IPC.overlayRendered),
  onGiftCatalog(cb: (items: GiftMetadata[], banners: GiftBannerCatalog) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, items: GiftMetadata[], banners: GiftBannerCatalog = {}): void => cb(items, banners)
    ipcRenderer.on(IPC.overlayGiftCatalog, handler)
    return () => ipcRenderer.removeListener(IPC.overlayGiftCatalog, handler)
  },
  onDanmaku(cb: (d: DanmakuPayload) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, d: DanmakuPayload): void => cb(d)
    ipcRenderer.on(IPC.overlayPushDanmaku, handler)
    return () => ipcRenderer.removeListener(IPC.overlayPushDanmaku, handler)
  },
  onClearDanmaku(cb: () => void): () => void {
    const handler = (): void => cb()
    ipcRenderer.on(IPC.overlayClearDanmaku, handler)
    return () => ipcRenderer.removeListener(IPC.overlayClearDanmaku, handler)
  },
  onConfig(cb: (c: AppConfig) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, c: AppConfig): void => cb(c)
    ipcRenderer.on(IPC.overlayPushConfig, handler)
    return () => ipcRenderer.removeListener(IPC.overlayPushConfig, handler)
  },
  onStats(cb: (stats: OverlayStatsPayload) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, stats: OverlayStatsPayload): void => cb(stats)
    ipcRenderer.on(IPC.overlayPushStats, handler)
    return () => ipcRenderer.removeListener(IPC.overlayPushStats, handler)
  }
})

contextBridge.exposeInMainWorld('settingsApi', {
  getCacheLocation: (): Promise<CacheLocationInfo> => ipcRenderer.invoke(IPC.cacheLocation),
  chooseCacheDirectory: (): Promise<CacheLocationInfo | null> => ipcRenderer.invoke(IPC.cacheChooseDirectory),
  resetCacheDirectory: (): Promise<CacheLocationInfo> => ipcRenderer.invoke(IPC.cacheResetDirectory),
  openCacheDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.cacheOpenDirectory),
  restartApp: (): Promise<boolean> => ipcRenderer.invoke(IPC.appRestart),
  getCacheInventory: (): Promise<CacheInventory> => ipcRenderer.invoke(IPC.cacheInventory),
  clearCache: (): Promise<CacheClearResult> => ipcRenderer.invoke(IPC.cacheClear),
  getChatHistory: (query: ChatHistoryQuery): Promise<ChatHistoryResult> => ipcRenderer.invoke(IPC.statisticsChats, query),
  getStatistics: (query: StatisticsQuery): Promise<StatisticsResult> => ipcRenderer.invoke(IPC.statisticsQuery, query),
  exportStatistics: (query: StatisticsQuery): Promise<StatisticsExportResult> => ipcRenderer.invoke(IPC.statisticsExport, query),
  onSettingsSection(cb: (section: string) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, section: string): void => cb(section)
    ipcRenderer.on(IPC.settingsSection, handler)
    return () => ipcRenderer.removeListener(IPC.settingsSection, handler)
  },
  getGiftCatalogStatus: (): Promise<GiftCatalogStatus> => ipcRenderer.invoke(IPC.giftCatalogGet),
  refreshGiftCatalog: (): Promise<GiftCatalogStatus> => ipcRenderer.invoke(IPC.giftCatalogRefresh),
  setGiftPrice: (patch: GiftPricePatch): Promise<GiftCatalogStatus> => ipcRenderer.invoke(IPC.giftPriceSet, patch),
  onGiftCatalogStatus(cb: (status: GiftCatalogStatus) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, status: GiftCatalogStatus): void => cb(status)
    ipcRenderer.on(IPC.giftCatalogStatus, handler)
    return () => ipcRenderer.removeListener(IPC.giftCatalogStatus, handler)
  },
  getWindowState: (): Promise<WindowChromeState> => ipcRenderer.invoke(IPC.windowStateGet),
  onWindowState(cb: (state: WindowChromeState) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, state: WindowChromeState): void => cb(state)
    ipcRenderer.on(IPC.windowStatePush, handler)
    return () => ipcRenderer.removeListener(IPC.windowStatePush, handler)
  },
  getStorageInfo: (): Promise<ConfigStorageInfo> => ipcRenderer.invoke(IPC.configStorageGet),
  openConfigDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.configOpenDirectory),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),
  setConfig: (partial: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.configSet, partial),
  previewAppearance: (partial: AppearancePatch | null): void =>
    ipcRenderer.send(IPC.configPreview, partial),
  listDisplays: (): Promise<OverlayDisplayListItem[]> => ipcRenderer.invoke(IPC.displayList),
  openSettingsWindow: (section?: string): Promise<boolean> => ipcRenderer.invoke(IPC.windowOpenSettings, section),
  openHomeWindow: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowOpenHome),
  reconnectDouyu: (): Promise<boolean> => ipcRenderer.invoke(IPC.douyuReconnect),
  closeWindow: (): void => ipcRenderer.send(IPC.windowClose),
  minimizeWindow: (): void => ipcRenderer.send(IPC.windowMinimize),
  toggleMaximizeWindow: (): void => ipcRenderer.send(IPC.windowToggleMaximize),
  windowDragStart: (screenX: number, screenY: number): void =>
    ipcRenderer.send(IPC.windowDragStart, screenX, screenY),
  windowDragMove: (screenX: number, screenY: number): void =>
    ipcRenderer.send(IPC.windowDragMove, screenX, screenY),
  windowDragEnd: (): void => ipcRenderer.send(IPC.windowDragEnd),
  onHomeLogo(cb: (dataUrl: string) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, dataUrl: string): void => cb(dataUrl)
    ipcRenderer.on(IPC.homePushLogo, handler)
    return () => ipcRenderer.removeListener(IPC.homePushLogo, handler)
  },
  onConfig(cb: (c: AppConfig) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, c: AppConfig): void => cb(c)
    ipcRenderer.on(IPC.overlayPushConfig, handler)
    return () => ipcRenderer.removeListener(IPC.overlayPushConfig, handler)
  },
  onDouyuStatus(cb: (s: DouyuStatusPayload) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, s: DouyuStatusPayload): void => cb(s)
    ipcRenderer.on(IPC.douyuStatus, handler)
    return () => ipcRenderer.removeListener(IPC.douyuStatus, handler)
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appGetVersion),
  checkUpdate: (force?: boolean): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke(IPC.appCheckUpdate, Boolean(force)),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.appOpenExternal, url),
  onUpdateInfo(cb: (r: UpdateCheckResult) => void): () => void {
    const handler = (_: Electron.IpcRendererEvent, r: UpdateCheckResult): void => cb(r)
    ipcRenderer.on(IPC.appUpdatePush, handler)
    return () => ipcRenderer.removeListener(IPC.appUpdatePush, handler)
  }
})
