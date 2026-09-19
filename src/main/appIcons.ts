import { app, nativeImage, type BrowserWindow, type NativeImage, type Tray } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getRuntimeCacheDirectory } from './dataPaths'
import { fileURLToPath } from 'node:url'
import { BoundedFileCache, AVATAR_CACHE_BYTES } from './cacheFiles'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 与原先托盘占位图一致，文件缺失时作为兜底 */
const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAA8AAAAPCAYAAAA71pVKAAAAGklEQVQoz2NkYGD4z0ABYBw1ClGECKH8P0gA0wQJ0V4N7K0AAAAASUVORK5CYII='

function tryLoadIconFromPath(p: string): NativeImage | null {
  if (!existsSync(p)) return null
  try {
    const buf = readFileSync(p)
    const img = nativeImage.createFromBuffer(buf)
    return img.isEmpty() ? null : img
  } catch {
    return null
  }
}

/**
 * 默认图标查找顺序：
 * 1. 打包：`process.resourcesPath/icon.png`（由 electron-builder extraResources 注入）
 * 2. 开发：项目根目录 `resources/icon.png`
 */
export function getDefaultIconImage(): NativeImage {
  const packaged = app.isPackaged ? join(process.resourcesPath, 'icon.png') : ''
  const dev = join(__dirname, '../../resources/icon.png')
  for (const p of [packaged, dev]) {
    if (!p) continue
    const img = tryLoadIconFromPath(p)
    if (img) return img
  }
  return nativeImage.createFromDataURL(`data:image/png;base64,${FALLBACK_PNG_BASE64}`)
}

interface DouyuRoomInfoBody {
  code?: number
  data?: {
    owner_avatar?: string
  }
}

function normalizeAvatarUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  const path = s.replace(/^\/+/, '')
  return `https://apic.douyucdn.cn/upload/${path}`
}

let avatarCache: BoundedFileCache | null = null
let avatarGeneration = 0
export async function invalidateAvatarCache(): Promise<void> { avatarGeneration++; await avatarCache?.invalidate() }

function getAvatarCache(): BoundedFileCache {
  if (!avatarCache) {
    avatarCache = new BoundedFileCache(getRuntimeCacheDirectory(), 'avatars', AVATAR_CACHE_BYTES, 7 * 24 * 60 * 60 * 1000, 64)
    void avatarCache.prune()
  }
  return avatarCache
}

export async function fetchAnchorAvatarAsIcon(rid: string): Promise<NativeImage | null> {
  if (!/^\d{1,12}$/.test(rid)) return null
  const generation = avatarGeneration
  const cache = getAvatarCache()
  const cached = await cache.read(`${rid}.png`)
  if (cached) {
    const image = nativeImage.createFromBuffer(cached)
    if (!image.isEmpty()) return image
  }

  // 主面板头像读取房间接口的 owner_avatar，应用和托盘使用星幕品牌图标。
  const roomInfoUrl = `https://wxapp.douyucdn.cn/Live/Room/info/${encodeURIComponent(rid)}`
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

  const roomInfoRes = await fetch(roomInfoUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'User-Agent': ua }
  })
  if (!roomInfoRes.ok) return null

  const json = (await roomInfoRes.json()) as DouyuRoomInfoBody
  if (json.code !== 0 || !json.data?.owner_avatar) return null

  const avatarUrl = normalizeAvatarUrl(json.data.owner_avatar)
  if (!avatarUrl) return null

  const imgRes = await fetch(avatarUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': ua }
  })
  if (!imgRes.ok) return null

  const buf = Buffer.from(await imgRes.arrayBuffer())
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null

  try {
    if (generation === avatarGeneration) await cache.write(`${rid}.png`, buf)
  } catch (e) {
    console.error('[app-icons] cache write failed', e)
  }

  return img
}

function resizeForTray(img: NativeImage): NativeImage {
  const { width, height } = img.getSize()
  const target = 32
  if (width <= target && height <= target) return img
  return img.resize({ width: target, height: target, quality: 'good' })
}

/** 与 min 边长的比例，接近常见 App 图标圆角观感 */
const DISPLAY_CORNER_RADIUS_RATIO = 0.22

function pointInRoundedRect(px: number, py: number, w: number, h: number, r: number): boolean {
  const maxR = Math.floor(Math.min(w, h) / 2)
  const rr = Math.min(r, maxR)
  if (rr <= 0) return px >= 0 && py >= 0 && px < w && py < h
  if (px < 0 || py < 0 || px >= w || py >= h) return false
  if (px >= rr && px < w - rr) return true
  if (py >= rr && py < h - rr) return true
  if (px < rr && py < rr) {
    const dx = px - rr
    const dy = py - rr
    return dx * dx + dy * dy <= rr * rr
  }
  if (px >= w - rr && py < rr) {
    const dx = px - (w - rr)
    const dy = py - rr
    return dx * dx + dy * dy <= rr * rr
  }
  if (px < rr && py >= h - rr) {
    const dx = px - rr
    const dy = py - (h - rr)
    return dx * dx + dy * dy <= rr * rr
  }
  if (px >= w - rr && py >= h - rr) {
    const dx = px - (w - rr)
    const dy = py - (h - rr)
    return dx * dx + dy * dy <= rr * rr
  }
  return false
}

/**
 * 给 PNG/位图加圆角透明区域（任务栏/托盘/窗口图标 OS 不会自动圆角，需在像素层裁切）。
 */
function roundNativeImageCorners(img: NativeImage, radiusRatio: number): NativeImage {
  const { width: w, height: h } = img.getSize()
  if (w <= 0 || h <= 0 || img.isEmpty()) return img

  const rPx = Math.round(Math.min(w, h) * radiusRatio)
  if (rPx <= 0) return img

  let src: Buffer
  try {
    src = img.toBitmap({ scaleFactor: 1 })
  } catch {
    return img
  }

  const rowBytes = src.length / h
  if (!Number.isInteger(rowBytes) || rowBytes < w * 4) return img

  const out = Buffer.from(src)
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes
    for (let x = 0; x < w; x++) {
      if (pointInRoundedRect(x, y, w, h, rPx)) continue
      const i = row + x * 4
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      out[i + 3] = 0
    }
  }

  try {
    return nativeImage.createFromBitmap(out, { width: w, height: h, scaleFactor: 1 })
  } catch {
    return img
  }
}

/** 托盘：缩放至 32px 并加圆角透明边（与任务栏图标观感一致） */
export function trayImageFromSource(img: NativeImage): NativeImage {
  return roundNativeImageCorners(resizeForTray(img), DISPLAY_CORNER_RADIUS_RATIO)
}

function windowIconFromSource(img: NativeImage): NativeImage {
  return roundNativeImageCorners(img, DISPLAY_CORNER_RADIUS_RATIO)
}

/** 主界面 logo 用（约 2× CSS 56px，便于高分屏） */
const HOME_LOGO_EXPORT_PX = 112

/**
 * 将当前应用/房间图标以 PNG data URL 推送到主窗口（圆角由页面 CSS 处理）。
 */
export function pushHomeLogoToRenderer(
  win: BrowserWindow | null,
  image: NativeImage,
  ipcChannel: string
): void {
  if (!win || win.isDestroyed()) return
  const target = HOME_LOGO_EXPORT_PX
  const { width: w, height: h } = image.getSize()
  const sized =
    w <= target && h <= target ? image : image.resize({ width: target, height: target, quality: 'good' })
  try {
    const buf = sized.toPNG()
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
    win.webContents.send(ipcChannel, dataUrl)
  } catch (e) {
    console.error('[home-logo]', e)
  }
}

export function applyTrayAndWindowIcons(
  tray: Tray | null,
  windows: (BrowserWindow | null)[],
  image: NativeImage
): void {
  const trayImg = trayImageFromSource(image)
  const windowImg = windowIconFromSource(image)
  for (const w of windows) {
    if (w && !w.isDestroyed()) w.setIcon(windowImg)
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(trayImg)
  }
}
