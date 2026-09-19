export type EmoticonSource = 'standard' | 'diamond' | 'meme' | 'room' | 'shared'
export interface DouyuEmoticon { code: string; url: string; source: EmoticonSource }
export interface EmoticonCatalog { roomId: string; items: DouyuEmoticon[] }
export type EmoticonPart = { text: string; emoticon?: DouyuEmoticon }

/** 目录只接受斗鱼 HTTPS 图片；不把弹幕正文解释为 HTML 或任意网址。 */
export function safeEmoticonUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value.replace(/^http:/i, 'https:'))
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.douyucdn.cn') || url.username || url.password || url.port) return ''
    return url.href
  } catch { return '' }
}

export function emoticonMap(items: readonly DouyuEmoticon[]): Map<string, DouyuEmoticon> {
  const catalog = new Map<string, DouyuEmoticon>()
  for (const item of items.slice(0, 2000)) {
    if (!item || typeof item.code !== 'string' || !/^[^\s[\]]{1,80}$/.test(item.code)) continue
    const url = safeEmoticonUrl(item.url)
    if (!url) continue
    const clean = { ...item, url }
    if (!catalog.has(item.code)) catalog.set(item.code, clean)
    if (/^dy\d+$/.test(item.code)) catalog.set(item.code.slice(2), clean)
  }
  return catalog
}

export function splitEmoticons(text: string, catalog: ReadonlyMap<string, DouyuEmoticon>, enabled = true): EmoticonPart[] {
  if (!enabled || !text.includes('[')) return [{ text }]
  const parts: EmoticonPart[] = []
  let start = 0, count = 0
  for (const match of text.matchAll(/\[([^\s[\]]{1,90})\]/g)) {
    const token = match[1]!
    const code = token.startsWith('emot:dy') ? token.slice(7) : token
    const emoticon = catalog.get(token) || catalog.get(code)
    if (!emoticon) continue
    if (count++ >= 64) break
    if (match.index! > start) parts.push({ text: text.slice(start, match.index) })
    parts.push({ text: match[0], emoticon })
    start = match.index! + match[0].length
  }
  if (start < text.length || !parts.length) parts.push({ text: text.slice(start) })
  return parts
}
