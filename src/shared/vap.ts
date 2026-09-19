/** VAP 的透明区域保存在 MP4 vapc box 中；不猜测左右分屏，也不把黑色当透明色。 */
export interface VapInfo {
  width: number
  height: number
  videoWidth: number
  videoHeight: number
  rgb: [number, number, number, number]
  alpha: [number, number, number, number]
  duration: number
}

export const MAX_GIFT_VIDEO_BYTES = 16 * 1024 * 1024
export const MAX_GIFT_VIDEO_SECONDS = 15

/** 同时核验声明大小和实际字节数，服务端缺少或误报 Content-Length 也不能无限占用内存。 */
export async function readGiftVideoBytes(response: Response): Promise<ArrayBuffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_GIFT_VIDEO_BYTES) {
    await response.body?.cancel()
    throw new Error('礼物动画不可用或超过单项限制')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_GIFT_VIDEO_BYTES) throw new Error('礼物动画超过单项限制')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes.buffer
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 4096
}

function frame(value: unknown, width: number, height: number): value is VapInfo['rgb'] {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isInteger(n) && n >= 0) &&
    value[2] > 0 && value[3] > 0 && value[0] + value[2] <= width && value[1] + value[3] <= height
}

export function parseVapInfo(buffer: ArrayBuffer): VapInfo | null {
  if (buffer.byteLength > MAX_GIFT_VIDEO_BYTES) return null
  const view = new DataView(buffer)
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 8 <= view.byteLength) {
    let size = view.getUint32(offset), header = 8
    const type = decoder.decode(new Uint8Array(buffer, offset + 4, 4))
    if (size === 1) {
      if (offset + 16 > view.byteLength) return null
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12)
      header = 16
    } else if (size === 0) size = view.byteLength - offset
    if (!Number.isSafeInteger(size) || size < header || offset + size > view.byteLength) return null
    if (type === 'vapc') {
      if (size - header > 128 * 1024) return null
      try {
        const data = record(JSON.parse(decoder.decode(new Uint8Array(buffer, offset + header, size - header))))
        const info = record(data.info)
        // VAPX 需要额外用户头像/文字合成；未支持时回退图片，不能播放缺素材的半成品。
        if (![1, 2].includes(Number(info.v)) || Number(info.isVapx || 0) !== 0 || Number(info.orien || 0) !== 0) return null
        const { w, h, videoW, videoH, fps, f } = info
        if (!dimension(w) || !dimension(h) || !dimension(videoW) || !dimension(videoH) ||
            videoW * videoH > 8_388_608 || typeof fps !== 'number' || fps <= 0 || fps > 60 ||
            typeof f !== 'number' || !Number.isInteger(f) || f <= 0 || f / fps > MAX_GIFT_VIDEO_SECONDS ||
            !frame(info.rgbFrame, videoW, videoH) || !frame(info.aFrame, videoW, videoH)) return null
        return { width: w, height: h, videoWidth: videoW, videoHeight: videoH,
          rgb: info.rgbFrame, alpha: info.aFrame, duration: f / fps }
      } catch { return null }
    }
    offset += size
  }
  return null
}
