import type { AppConfig } from '../shared/config'
import type { DouyuStatusPayload } from '../shared/douyuStatus'
import type { GiftCatalogStatus } from '../shared/types'
import type { UpdateCheckResult } from '../shared/updateCheck'
import { bindTitlebarChrome } from './titlebarChrome'

const api = window.settingsApi
const room = document.getElementById('roomId') as HTMLInputElement
const toggle = document.getElementById('toggle') as HTMLButtonElement
const reconnect = document.getElementById('reconnect') as HTMLButtonElement
const status = document.getElementById('connStatus')!
const detail = document.getElementById('connectionDetail')!
const updateHint = document.getElementById('updateHint') as HTMLButtonElement
let current: AppConfig | null = null
let saveQueue: Promise<void> = Promise.resolve()
let saveCount = 0
let busy = false
let lastUpdateUrl = ''
let saveError = ''
let lastConnectionStatus: DouyuStatusPayload = { state: 'idle' }

function renderConnection(payload: DouyuStatusPayload): void {
  lastConnectionStatus = payload
  const labels: Record<DouyuStatusPayload['state'], string> = {
    idle: '未连接', connecting: '连接中', 'socket-open': '正在连接', 'login-ok': current?.simulateDanmaku ? '模拟测试中' : '已连接',
    'login-fail': '连接失败', closed: '连接已断开', error: '连接异常'
  }
  status.textContent = labels[payload.state]
  status.className = `status-pill ${payload.state === 'login-ok' ? 'ok' : payload.state === 'error' || payload.state === 'login-fail' ? 'err' : payload.state === 'connecting' || payload.state === 'socket-open' ? 'connecting' : ''}`
  if (saveError) { detail.textContent = saveError; detail.dataset.error = 'true'; return }
  const idle = !current?.overlayEnabled && current?.roomId
    ? '飘屏已关闭，点击“启动飘屏”即可显示弹幕窗口。'
    : current?.simulateDanmaku ? '模拟弹幕已选中，启动后即可预览。' : '填入房间后，即可开始接收实时弹幕。'
  detail.textContent = payload.state === 'idle' ? idle : payload.detail || labels[payload.state]
  detail.dataset.error = String(payload.state === 'error' || payload.state === 'login-fail')
}

function renderConfig(config: AppConfig): void {
  current = config
  if (document.activeElement !== room) room.value = config.roomId
  toggle.classList.toggle('off', !config.overlayEnabled)
  toggle.querySelector('span')!.textContent = config.overlayEnabled ? '停止飘屏' : '启动飘屏'
  toggle.querySelector('svg')!.innerHTML = config.overlayEnabled ? '<rect x="5" y="5" width="14" height="14" rx="2" />' : '<path d="m6 4 14 8-14 8Z" />'
  reconnect.disabled = busy || !config.overlayEnabled || config.simulateDanmaku
  const clickThrough = document.getElementById('quickClickThrough') as HTMLInputElement
  clickThrough.checked = config.danmakuScrollDirection === 'edge' || config.clickThrough
  clickThrough.disabled = config.danmakuScrollDirection === 'edge'
  clickThrough.title = clickThrough.disabled ? '边缘沉浸模式自动穿透鼠标' : '鼠标穿透'
  ;(document.getElementById('quickTopmost') as HTMLInputElement).checked = config.overlayAlwaysOnTop
  const preview = document.getElementById('stylePreview')!
  const font = Math.max(14, Math.min(22, config.fontSize * .7)), scale = font / config.fontSize
  preview.style.setProperty('--preview-font', `${font}px`)
  preview.style.setProperty('--preview-line', String(config.lineHeight))
  preview.style.setProperty('--preview-spacing', `${config.letterSpacing * scale}px`)
  preview.style.setProperty('--preview-avatar', `${Math.max(18, Math.min(44, config.avatarSize * scale))}px`)
  preview.style.setProperty('--preview-text', config.commonTextColor)
  preview.style.setProperty('--preview-username', config.usernameTextColor)
  preview.style.setProperty('--preview-nickname-scale', String(config.nicknameScale))
  document.documentElement.classList.toggle('reduce-motion', !config.motionEnabled)
  preview.style.setProperty('--preview-gift', config.giftTextColor)
  const rgb = [1, 3, 5].map(index => parseInt(config.danmakuBgColor.slice(index, index + 2), 16))
  const alpha = config.danmakuScrollDirection === 'edge' ? config.danmakuBgOpacity
    : 1 - (1 - config.overlayBackgroundOpacity) * (1 - config.danmakuBgOpacity)
  preview.style.setProperty('--preview-background', `rgba(${rgb.join(',')},${alpha})`)
  preview.style.opacity = String(config.opacity)
  preview.querySelector<HTMLElement>('.preview-avatar')!.hidden = !config.chatModules.includes('avatar')
  preview.querySelector<HTMLElement>('.preview-gift')!.hidden = !config.widgetModules.includes('highlight')
}

function saveConfig(partial: Partial<AppConfig>): Promise<void> {
  saveCount++
  saveQueue = saveQueue.then(async () => {
    try {
      current = await api.setConfig(partial)
      saveError = ''
      if (saveCount === 1) { renderConfig(current); renderConnection(lastConnectionStatus) }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error)
      detail.textContent = saveError; detail.dataset.error = 'true'
      try { renderConfig(await api.getConfig()) } catch { /* 保留现有界面 */ }
    } finally { saveCount-- }
  })
  return saveQueue
}

function persistRoom(): Promise<void> {
  const value = room.value.trim()
  if (current && value === current.roomId) return saveQueue
  return saveConfig({ roomId: value })
}

bindTitlebarChrome(async () => { await persistRoom(); await saveQueue; return !saveError })
room.addEventListener('blur', () => { void persistRoom() })
room.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); if (!current?.overlayEnabled) toggle.click(); else void persistRoom() }
})

toggle.addEventListener('click', async () => {
  if (busy) return
  busy = true; toggle.disabled = true
  try {
    await persistRoom()
    const config = await api.getConfig()
    if (!config.overlayEnabled && !config.simulateDanmaku && !room.value.trim()) {
      detail.textContent = '请先输入房间号或直播间链接。'; detail.dataset.error = 'true'; room.focus(); return
    }
    await saveConfig({ roomId: room.value.trim(), overlayEnabled: !config.overlayEnabled })
  } catch (error) { detail.textContent = String(error); detail.dataset.error = 'true' }
  finally { busy = false; toggle.disabled = false; if (current) renderConfig(current) }
})

reconnect.addEventListener('click', async () => {
  if (busy) return
  busy = true; reconnect.disabled = true
  try { await persistRoom(); await api.reconnectDouyu() }
  catch (error) { detail.textContent = String(error); detail.dataset.error = 'true' }
  finally { busy = false; if (current) renderConfig(current) }
})

for (const [id, field] of [['quickClickThrough', 'clickThrough'], ['quickTopmost', 'overlayAlwaysOnTop']] as const) {
  const input = document.getElementById(id) as HTMLInputElement
  input.addEventListener('change', () => { void saveConfig({ [field]: input.checked }) })
}
document.getElementById('openSettings')!.addEventListener('click', () => {
  void (async () => { await persistRoom(); await saveQueue; if (!saveError) await api.openSettingsWindow() })()
})
document.getElementById('openHistory')!.addEventListener('click', () => {
  void (async () => { await persistRoom(); await saveQueue; if (!saveError) await api.openSettingsWindow('history') })()
})

function renderCatalog(catalog: GiftCatalogStatus): void {
  document.getElementById('giftPriceHint')!.textContent = catalog.state === 'ready' ? `礼物价格自动更新 · 已确认 ${catalog.pricedCount} 种` : catalog.state === 'loading' ? '正在获取斗鱼礼物价格…' : catalog.state === 'error' ? '礼物价格暂未更新，稍后自动重试' : '连接后自动获取斗鱼礼物价格'
}
function renderUpdate(result: UpdateCheckResult): void {
  lastUpdateUrl = result.ok && result.hasUpdate && result.openUrl ? result.openUrl : ''
  updateHint.hidden = !lastUpdateUrl
  updateHint.textContent = lastUpdateUrl ? `v${result.latestVersion} 可下载` : ''
}
updateHint.addEventListener('click', () => { if (lastUpdateUrl) void api.openExternal(lastUpdateUrl) })

api.onConfig(config => { current = config; if (!saveCount) renderConfig(config) })
api.onDouyuStatus(renderConnection)
api.onGiftCatalogStatus(renderCatalog)
api.onUpdateInfo(renderUpdate)
api.onHomeLogo(dataUrl => { (document.getElementById('homeLogo') as HTMLImageElement).src = dataUrl })
void api.getConfig().then(config => { renderConfig(config); if (!config.overlayEnabled) renderConnection({ state: 'idle' }) }).catch(error => {
  detail.textContent = `设置加载失败：${String(error)}`; detail.dataset.error = 'true'
})
// 版本号不等待网络更新检查，离线启动也能立即显示。
void api.getAppVersion().then(version => { document.getElementById('appVersion')!.textContent = `v${version}` })
void api.getGiftCatalogStatus().then(renderCatalog)
