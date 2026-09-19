import { protocol } from 'electron'
import { officialGiftVideoUrl } from '../shared/giftMedia'
import { readGiftVideoBytes } from '../shared/vap'
import { GiftVideoMemoryCache } from './giftMediaCache'

const videos = new GiftVideoMemoryCache(async (url, signal) => readGiftVideoBytes(await fetch(url, {
  signal, credentials: 'omit', redirect: 'error', headers: { Referer: 'https://www.douyu.com/' }
})))

export function giftVideoCacheBytes(): number { return videos.bytes }
export function clearGiftVideoCache(): void { videos.clear() }

export function registerGiftMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'xingmu-gift', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
  } }])
}

/** 官方 CDN 只向 douyu.com 开放 CORS；主进程只转发白名单 MP4，视频仅保留有界内存缓存。 */
export function installGiftMediaProtocol(): void {
  protocol.handle('xingmu-gift', async request => {
    const address = new URL(request.url)
    const source = address.hostname === 'media' && request.method === 'GET'
      ? officialGiftVideoUrl(address.searchParams.get('url')) : undefined
    if (!source) return new Response(null, { status: 400 })
    try {
      // 先完整校验这一个有界视频，再跨 Electron 协议返回，避免上游流在回调结束后中断。
      const bytes = await videos.get(source, AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]))
      return new Response(bytes, { headers: {
        'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.byteLength)
      } })
    } catch { return new Response(null, { status: 502 }) }
  })
}
