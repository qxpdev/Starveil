/// <reference types="vite/client" />
import type { AppConfig, OverlayDisplayListItem } from '../shared/config'
import type { AppearancePatch } from '../shared/appearancePreview'
import type { UpdateCheckResult } from '../shared/updateCheck'
import type { DanmakuPayload, OverlayStatsPayload, GiftMetadata, GiftCatalogStatus, GiftPricePatch, WindowChromeState, GiftBannerCatalog } from '../shared/types'
import type { DouyuStatusPayload } from '../shared/douyuStatus'
import type { ConfigStorageInfo, CacheInventory, CacheClearResult, CacheLocationInfo } from '../shared/storage'
import type { EmoticonCatalog } from '../shared/emoticons'
import type { StatisticsQuery, StatisticsResult, StatisticsExportResult, ChatHistoryQuery, ChatHistoryResult } from '../shared/statistics'

declare global {
  interface Window {
    overlayApi: {
      getEmoticonCatalog: () => Promise<EmoticonCatalog>
      onEmoticonCatalog: (cb: (catalog: EmoticonCatalog) => void) => () => void
      rendered: () => void
      onGiftCatalog: (cb: (items: GiftMetadata[], banners: GiftBannerCatalog) => void) => () => void
      onDanmaku: (cb: (d: DanmakuPayload) => void) => () => void
      onClearDanmaku: (cb: () => void) => () => void
      onConfig: (cb: (c: AppConfig) => void) => () => void
      onStats: (cb: (stats: OverlayStatsPayload) => void) => () => void
    }
    settingsApi: {
      getCacheLocation: () => Promise<CacheLocationInfo>
      chooseCacheDirectory: () => Promise<CacheLocationInfo | null>
      resetCacheDirectory: () => Promise<CacheLocationInfo>
      openCacheDirectory: () => Promise<string>
      restartApp: () => Promise<boolean>
      getCacheInventory: () => Promise<CacheInventory>
      clearCache: () => Promise<CacheClearResult>
      getChatHistory: (query: ChatHistoryQuery) => Promise<ChatHistoryResult>
      getStatistics: (query: StatisticsQuery) => Promise<StatisticsResult>
      exportStatistics: (query: StatisticsQuery) => Promise<StatisticsExportResult>
      onSettingsSection: (cb: (section: string) => void) => () => void
      getGiftCatalogStatus: () => Promise<GiftCatalogStatus>
      refreshGiftCatalog: () => Promise<GiftCatalogStatus>
      setGiftPrice: (patch: GiftPricePatch) => Promise<GiftCatalogStatus>
      onGiftCatalogStatus: (cb: (status: GiftCatalogStatus) => void) => () => void
      getWindowState: () => Promise<WindowChromeState>
      onWindowState: (cb: (state: WindowChromeState) => void) => () => void
      getStorageInfo: () => Promise<ConfigStorageInfo>
      openConfigDirectory: () => Promise<string>
      getConfig: () => Promise<AppConfig>
      setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>
      previewAppearance: (partial: AppearancePatch | null) => void
      openSettingsWindow: (section?: string) => Promise<boolean>
      openHomeWindow: () => Promise<boolean>
      reconnectDouyu: () => Promise<boolean>
      closeWindow: () => void
      minimizeWindow: () => void
      toggleMaximizeWindow: () => void
      windowDragStart: (screenX: number, screenY: number) => void
      windowDragMove: (screenX: number, screenY: number) => void
      windowDragEnd: () => void
      onHomeLogo: (cb: (dataUrl: string) => void) => () => void
      onConfig: (cb: (c: AppConfig) => void) => () => void
      onDouyuStatus: (cb: (s: DouyuStatusPayload) => void) => () => void
      getAppVersion: () => Promise<string>
      checkUpdate: (force?: boolean) => Promise<UpdateCheckResult>
      openExternal: (url: string) => Promise<boolean>
      onUpdateInfo: (cb: (r: UpdateCheckResult) => void) => () => void
      listDisplays: () => Promise<OverlayDisplayListItem[]>
    }
  }
}

export {}
