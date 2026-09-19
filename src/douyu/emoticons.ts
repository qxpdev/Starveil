import { safeEmoticonUrl, type DouyuEmoticon, type EmoticonSource } from '../shared/emoticons'
import { STANDARD_EMOTICONS } from './emoticonCatalog'

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord {
  if (typeof value === 'string') { try { return record(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

export function standardEmoticons(): DouyuEmoticon[] {
  return STANDARD_EMOTICONS.map(([code, url]) => ({ code, url, source: 'standard' }))
}

/** 与官网 dfans/emojis 及 roomemoji/list 的字段一致。空目录不会当作错误。 */
export function parseRoomEmoticons(dfans: unknown, room: unknown): DouyuEmoticon[] {
  const items: DouyuEmoticon[] = []
  const add = (list: unknown, source: EmoticonSource, codeKey: string, urlKey: string): void => {
    if (!Array.isArray(list)) return
    for (const raw of list.slice(0, 1000)) {
      const value = record(raw), code = String(value[codeKey] ?? ''), url = safeEmoticonUrl(value[urlKey])
      if (url && /^[^\s[\]]{1,80}$/.test(code)) items.push({ code, url, source })
    }
  }
  const diamonds = record(record(dfans).data)
  add(diamonds.emoList, 'diamond', 'text', 'pic')
  add(diamonds.commEmoList, 'shared', 'text', 'pic')
  add(record(diamonds.popularEmojis).list, 'meme', 'name', 'webPic')
  add(record(record(room).data).emoList, 'room', 'eid', 'pic')
  return items
}

export async function fetchEmoticonResponse(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error',
    headers: { Referer: 'https://www.douyu.com/', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } })
  if (!response.ok || !response.body) throw new Error(`表情目录请求失败：${response.status}`)
  const reader = response.body.getReader()
  const buffers: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > 1024 * 1024) throw new Error('表情目录过大')
      buffers.push(value)
    }
  } finally { await reader.cancel() }
  const body = record(JSON.parse(Buffer.concat(buffers).toString('utf8')))
  if (Number(body.error) !== 0) throw new Error('斗鱼表情目录暂不可用')
  return body
}
