import { DEFAULT_CONFIG, parseBlockWordsText, type AppConfig, type OverlayDisplayListItem } from '../shared/config'
import { pickAppearancePatch, type AppearancePatch } from '../shared/appearancePreview'
import type { GiftCatalogStatus } from '../shared/types'
import { bindTitlebarChrome } from './titlebarChrome'
import { installColorPicker } from './colorPicker'
import { installSettingsLayout } from './settingsLayout'
import { installGiftPricing } from './giftPricing'
import { installRangeControls } from './rangeControls'
import { installStatisticsHistory } from './statisticsHistory'
import { installCacheSettings } from './cacheSettings'

const api = window.settingsApi
const picker = installColorPicker()
installSettingsLayout(picker.close)
const ranges = installRangeControls()
const statisticsHistory = installStatisticsHistory()
installCacheSettings(() => flushBeforeLeave())
const giftPricing = installGiftPricing(status => { renderCatalog(status); void refreshStorageInfo() }, message => showSaveStatus(message, 'error'))
type Control = HTMLInputElement | HTMLSelectElement
const controls = [...document.querySelectorAll<Control>('[data-config]')]
let currentConfig: AppConfig | null = null
let pending: Partial<AppConfig> = {}
let inFlight: Partial<AppConfig> = {}
let previewPending: AppearancePatch = {}
let previewFrame: number | null = null
let draggingRange = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveWork: Promise<void> | null = null
let loadingDisplays: Promise<void> | null = null

function showSaveStatus(text: string, state: 'saved' | 'saving' | 'error' = 'saved'): void {
  const status = document.getElementById('saveStatus')!
  status.dataset.state = state
  status.title = text
  document.getElementById('saveStatusText')!.textContent = state === 'error' ? '未保存' : text
  const error = document.getElementById('saveError')!
  error.hidden = state !== 'error'
  error.textContent = state === 'error' ? text : ''
}

async function refreshStorageInfo(): Promise<void> {
  const info = await api.getStorageInfo()
  document.getElementById('storagePath')!.textContent = info.directory
  if (Object.keys(pending).length) return
  const error = Boolean(info.notice && /未保存|无法读取|尚未保存/.test(info.notice))
  showSaveStatus(info.notice || (info.savedAt ? `已保存 · ${new Date(info.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '更改自动保存'), error ? 'error' : 'saved')
}

function setDependentItems(selector: string, enabled: boolean): void {
  for (const item of document.querySelectorAll<HTMLElement>(selector)) {
    item.classList.toggle('is-disabled', !enabled)
    for (const control of item.querySelectorAll<Control>('input, select')) control.disabled = !enabled
  }
}

function updateLabels(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"][data-config]')) {
    const value = Number(input.value), minimum = Number(input.min), maximum = Number(input.max)
    input.style.setProperty('--range-fill', `${Math.min(100, Math.max(0, (value - minimum) / (maximum - minimum) * 100))}%`)
    const label = document.getElementById(`${input.id}Val`)
    if (label) label.textContent = input.dataset.format === 'percent' ? String(Math.round(value * 100)) : input.value
  }
  picker.sync()
  ranges.sync()
}

function updateDependencies(config: AppConfig): void {
  const edge = config.danmakuScrollDirection === 'edge'
  setDependentItems('[data-requires-edge]', edge)
  for (const id of ['clickThrough', 'overlayEdgeSnap', 'overlayBackgroundOpacity', 'commonTimeSec', 'commonTotal', 'lanePad']) {
    const control = document.getElementById(id) as HTMLInputElement
    control.disabled = edge
    control.closest('.setting-item')?.classList.toggle('is-disabled', edge)
  }
  if (edge) (document.getElementById('clickThrough') as HTMLInputElement).checked = true
  setDependentItems('[data-requires-history]', config.dailyStatisticsEnabled)
  setDependentItems('[data-requires-topmost]', config.overlayAlwaysOnTop)
  setDependentItems('[data-requires-highlight]', config.widgetModules.includes('highlight'))
  for (const id of ['markedTimeSec', 'markedTotal']) {
    const control = document.getElementById(id) as HTMLInputElement
    control.disabled = edge || !config.widgetModules.includes('highlight')
    control.closest('.setting-item')?.classList.toggle('is-disabled', control.disabled)
  }
  setDependentItems('[data-requires-edge][data-requires-highlight]', edge && config.widgetModules.includes('highlight'))
  setDependentItems('[data-requires-banner]', config.widgetModules.includes('highlight') && config.giftOfficialBanner)
  setDependentItems('[data-requires-status]', config.widgetModules.includes('status'))
  setDependentItems('[data-requires-edge-status]', edge && config.widgetModules.includes('status'))
  const regularStatus = document.getElementById('statusAlwaysVisible') as HTMLInputElement
  regularStatus.disabled = edge || !config.widgetModules.includes('status')
  regularStatus.closest('.setting-item')?.classList.toggle('is-disabled', regularStatus.disabled)
  document.getElementById('activateEdgeMode')!.hidden = edge
  document.getElementById('edgeModeNote')!.textContent = edge ? '当前已使用边缘沉浸。新消息从底部进入，已有消息平滑上移；礼物顶部停留不会暂停弹幕。' : '当前使用普通显示方式。切换为边缘沉浸后，可以调整以下选项。'
  setDependentItems('[data-requires-welcome]', config.showWelcome)
  setDependentItems('[data-requires-merge]', !config.chatFold && config.duplicateDanmakuMode === 'merge')
  const shadow = document.querySelector<HTMLButtonElement>('[data-color-for="textShadowColor"]')!
  shadow.disabled = !config.textShadowColor
}

function syncForm(config: AppConfig): void {
  currentConfig = config
  for (const control of controls) {
    // 编辑期间不改写正在输入的控件，也不重建颜色弹层。
    if (document.activeElement === control && control.type !== 'checkbox') continue
    const key = control.dataset.config as keyof AppConfig
    const value = config[key]
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value)
    else if (control.dataset.csv) control.value = (value as string[]).join(', ')
    else if (key === 'textShadowColor') control.value = String(value || '#000000')
    else if (key === 'duplicateDanmakuMode') control.value = config.chatFold ? 'once' : String(value)
    else control.value = String(value ?? '')
  }
  ;(document.getElementById('textShadowOn') as HTMLInputElement).checked = Boolean(config.textShadowColor)
  for (const group of document.querySelectorAll<HTMLElement>('[data-config-group]')) {
    const values = config[group.dataset.configGroup as keyof AppConfig] as string[]
    for (const input of group.querySelectorAll<HTMLInputElement>('input')) input.checked = values.includes(input.value)
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-widget-module]')) {
    input.checked = config.widgetModules.includes(input.dataset.widgetModule as 'highlight' | 'status')
  }
  const display = document.getElementById('overlayDisplay') as HTMLSelectElement
  display.value = config.overlayDisplayMode === 'specific' && [...display.options].some(o => o.value === config.overlayDisplayId) ? config.overlayDisplayId : 'primary'
  updateDependencies(config)
  updateLabels()
}

function flushAppearancePreview(): void {
  if (previewFrame !== null) cancelAnimationFrame(previewFrame)
  previewFrame = null
  if (!Object.keys(previewPending).length) return
  api.previewAppearance(previewPending)
  previewPending = {}
}

function queueSave(partial: Partial<AppConfig>): void {
  Object.assign(pending, partial)
  Object.assign(previewPending, pickAppearancePatch(partial))
  if (Object.keys(previewPending).length && previewFrame === null) {
    previewFrame = requestAnimationFrame(flushAppearancePreview)
  }
  showSaveStatus(draggingRange ? '实时预览 · 松开保存' : '正在保存…', 'saving')
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = draggingRange ? null : setTimeout(() => { saveTimer = null; void flushPending() }, 120)
}

function flushPending(): Promise<void> {
  flushAppearancePreview()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (saveWork) return saveWork
  if (!Object.keys(pending).length) return Promise.resolve()
  saveWork = (async () => {
    let failed = false
    do {
      const partial = pending
      pending = {}
      inFlight = partial
      try {
        currentConfig = await api.setConfig(partial)
        failed = false
      } catch (error) {
        failed = true
        showSaveStatus(error instanceof Error ? error.message : String(error), 'error')
        try { currentConfig = await api.getConfig() } catch { /* 保留上一次有效配置 */ }
      } finally {
        inFlight = {}
      }
    } while (Object.keys(pending).length && !draggingRange)
    if (!failed) await refreshStorageInfo()
  })().catch(error => showSaveStatus(String(error), 'error')).finally(() => {
    saveWork = null
    if (Object.keys(pending).length) { if (!draggingRange) void flushPending() }
    else if (currentConfig) syncForm(currentConfig)
  })
  return saveWork
}

async function flushBeforeLeave(): Promise<boolean> {
  ;(document.activeElement as HTMLElement | null)?.blur()
  picker.close()
  if (!await giftPricing.waitForSave()) return false
  if (!await statisticsHistory.waitForSave()) return false
  do { await flushPending() } while (saveWork || Object.keys(pending).length)
  return document.getElementById('saveStatus')!.dataset.state !== 'error'
}
bindTitlebarChrome(flushBeforeLeave)
document.getElementById('backHome')!.addEventListener('click', () => {
  void (async () => { if (await flushBeforeLeave()) await api.openHomeWindow() })()
})

function patchFromControl(control: Control): Partial<AppConfig> | null {
  const key = control.dataset.config as keyof AppConfig | undefined
  if (!key || control.disabled) return null
  let value: unknown = control.value
  if (control instanceof HTMLInputElement && control.type === 'checkbox') value = control.checked
  else if (control.dataset.csv) value = parseBlockWordsText(control.value)
  else if (control.type === 'range' || control.type === 'number') {
    if (control.value.trim() === '') return null
    const numeric = Number(control.value)
    if (!Number.isFinite(numeric)) return null
    const input = control as HTMLInputElement
    value = Math.min(input.max ? Number(input.max) : Infinity, Math.max(input.min ? Number(input.min) : -Infinity, numeric))
  }
  if (key === 'textShadowColor' && !(document.getElementById('textShadowOn') as HTMLInputElement).checked) return null
  const patch = { [key]: value } as Partial<AppConfig>
  if (key === 'duplicateDanmakuMode') patch.chatFold = false
  return patch
}

for (const control of controls) {
  if (control.type === 'range') control.addEventListener('pointerdown', () => {
    draggingRange = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
  })
  const eventName = control.type === 'checkbox' || control.tagName === 'SELECT' ? 'change' : 'input'
  control.addEventListener(eventName, () => {
    const patch = patchFromControl(control)
    if (!patch) return
    queueSave(patch)
    updateLabels()
    if (currentConfig) updateDependencies({ ...currentConfig, ...inFlight, ...pending })
    ranges.sync()
  })
  control.addEventListener('change', () => { void flushPending() })
}

function finishRangeDrag(): void {
  if (!draggingRange) return
  draggingRange = false
  void flushPending()
}
window.addEventListener('pointerup', finishRangeDrag)
window.addEventListener('pointercancel', finishRangeDrag)
window.addEventListener('blur', finishRangeDrag)

document.getElementById('activateEdgeMode')!.addEventListener('click', () => {
  queueSave({ danmakuScrollDirection: 'edge' })
  void flushPending()
})
for (const input of document.querySelectorAll<HTMLInputElement>('[data-widget-module]')) {
  input.addEventListener('change', () => {
    if (!currentConfig) return
    const effective = { ...currentConfig, ...inFlight, ...pending }
    const values = new Set(effective.widgetModules)
    const module = input.dataset.widgetModule as 'highlight' | 'status'
    if (input.checked) values.add(module)
    else values.delete(module)
    const patch = { widgetModules: [...values] }
    queueSave(patch)
    updateDependencies({ ...effective, ...patch })
    ranges.sync()
    void flushPending()
  })
}

document.getElementById('resetTypography')!.addEventListener('click', () => {
  const patch = Object.fromEntries((['fontSize', 'avatarSize', 'fansMedalScale', 'userLevelScale', 'nicknameScale', 'letterSpacing', 'lineHeight', 'lanePadding'] as const)
    .map(key => [key, DEFAULT_CONFIG[key]])) as Partial<AppConfig>
  queueSave(patch)
  if (currentConfig) syncForm({ ...currentConfig, ...pending })
  void flushPending()
})

document.getElementById('textShadowOn')!.addEventListener('change', event => {
  const enabled = (event.target as HTMLInputElement).checked
  const value = (document.getElementById('textShadowColor') as HTMLInputElement).value || '#000000'
  queueSave({ textShadowColor: enabled ? value : '' })
  document.querySelector<HTMLButtonElement>('[data-color-for="textShadowColor"]')!.disabled = !enabled
  if (!enabled) picker.close()
  void flushPending()
})

for (const group of document.querySelectorAll<HTMLElement>('[data-config-group]')) {
  group.addEventListener('change', () => {
    const values = [...group.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value)
    const patch = { [group.dataset.configGroup!]: values } as Partial<AppConfig>
    queueSave(patch)
    if (currentConfig) updateDependencies({ ...currentConfig, ...pending })
    void flushPending()
  })
}

document.addEventListener('focusout', () => {
  queueMicrotask(() => { if (currentConfig && !saveWork && !Object.keys(pending).length) syncForm(currentConfig) })
})

async function loadDisplays(): Promise<void> {
  if (loadingDisplays) return loadingDisplays
  loadingDisplays = (async () => {
    const items: OverlayDisplayListItem[] = await api.listDisplays()
    const select = document.getElementById('overlayDisplay') as HTMLSelectElement
    const options = [new Option(`${items.find(item => item.isPrimary)?.label || '主显示器'} · 自动跟随`, 'primary'), ...items.map(item => new Option(item.label, item.id))]
    select.replaceChildren(...options)
    if (currentConfig) select.value = currentConfig.overlayDisplayMode === 'specific' && items.some(item => item.id === currentConfig!.overlayDisplayId) ? currentConfig.overlayDisplayId : 'primary'
  })().finally(() => { loadingDisplays = null })
  return loadingDisplays
}

document.getElementById('overlayDisplay')!.addEventListener('change', event => {
  const value = (event.target as HTMLSelectElement).value
  queueSave({ overlayDisplayMode: value === 'primary' ? 'primary' : 'specific', overlayDisplayId: value === 'primary' ? '' : value })
  void flushPending()
})
window.addEventListener('focus', () => { void loadDisplays().catch(() => {}) })

document.getElementById('openConfigDirectory')!.addEventListener('click', () => {
  void api.openConfigDirectory().then(error => { if (error) showSaveStatus(`无法打开配置目录：${error}`, 'error') }).catch(error => showSaveStatus(String(error), 'error'))
})

function renderCatalog(status: GiftCatalogStatus): void {
  giftPricing.render(status)
  const summary = document.getElementById('catalogSummary')!
  summary.dataset.state = status.state
  summary.textContent = status.state === 'loading' ? '正在更新礼物价格…' : status.state === 'idle' ? '连接直播间后自动获取价格' : status.state === 'error' ? '暂时无法更新礼物目录' : `已获取 ${status.count} 种礼物 · ${status.pricedCount} 种价格已确认`
  if (status.manualCount) summary.textContent += ` · ${status.manualCount} 种手动补价`
  document.getElementById('catalogDetail')!.textContent = [status.detail, status.pendingCount ? `${status.pendingCount} 个已收到的礼物等待补价` : '', status.updatedAt ? `上次更新 ${new Date(status.updatedAt).toLocaleTimeString()}` : ''].filter(Boolean).join(' · ')
  ;(document.getElementById('refreshGiftCatalog') as HTMLButtonElement).disabled = status.state === 'idle' || status.state === 'loading'
}
document.getElementById('refreshGiftCatalog')!.addEventListener('click', () => {
  void api.refreshGiftCatalog().then(renderCatalog).catch(error => { document.getElementById('catalogDetail')!.textContent = String(error) })
})
api.onGiftCatalogStatus(renderCatalog)

let updateUrl = ''
document.getElementById('checkUpdates')!.addEventListener('click', async () => {
  if (updateUrl) { await api.openExternal(updateUrl); return }
  const button = document.getElementById('checkUpdates') as HTMLButtonElement
  const status = document.getElementById('updateStatus')!
  button.disabled = true; status.hidden = false; status.textContent = '正在检查更新…'
  try {
    const result = await api.checkUpdate(true)
    status.textContent = result.ok ? result.hasUpdate ? `新版本 ${result.latestVersion} 已可下载。` : '当前已是最新版本。' : `暂时无法检查更新：${result.error || '网络不可用'}`
    if (result.ok && result.hasUpdate && result.openUrl) { updateUrl = result.openUrl; button.textContent = '下载新版本' }
  } catch (error) { status.textContent = `暂时无法检查更新：${String(error)}` }
  finally { button.disabled = false }
})

api.onConfig(config => {
  currentConfig = config
  if (!saveWork && !Object.keys(pending).length) syncForm(config)
})
void (async () => {
  syncForm(await api.getConfig())
  await Promise.all([loadDisplays(), refreshStorageInfo(), api.getGiftCatalogStatus().then(renderCatalog), api.getAppVersion().then(version => {
    for (const label of document.querySelectorAll<HTMLElement>('[data-app-version]')) label.textContent = `v${version}`
  })])
})().catch(error => showSaveStatus(`设置加载失败：${String(error)}`, 'error'))
