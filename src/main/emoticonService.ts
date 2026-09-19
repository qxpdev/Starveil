import { BoundedFileCache, EMOTICON_CACHE_BYTES } from './cacheFiles'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fetchEmoticonResponse, parseRoomEmoticons, standardEmoticons } from '../douyu/emoticons'
import { emoticonMap, type EmoticonCatalog, type DouyuEmoticon } from '../shared/emoticons'

const MAX_AGE_MS = 6 * 60 * 60 * 1000

export class EmoticonService {
  private readonly cache: BoundedFileCache
  private generation = 0
  private room = ''
  private items: DouyuEmoticon[] = standardEmoticons()
  private loading: Promise<void> | null = null
  private retryAfter = 0
  constructor(root: string, private readonly publish: (catalog: EmoticonCatalog) => void, cacheDirectory = join(root, 'cache')) {
    mkdirSync(cacheDirectory, { recursive: true })
    this.cache = new BoundedFileCache(cacheDirectory, 'emoticons', EMOTICON_CACHE_BYTES, 7 * 24 * 60 * 60 * 1000, 32)
    void this.cache.prune()
  }

  snapshot(): EmoticonCatalog { return { roomId: this.room, items: this.items } }

  async invalidateCache(): Promise<void> {
    this.generation++
    await this.cache.invalidate()
    this.loading = null
    this.retryAfter = 0
  }

  async activate(roomId: string): Promise<void> {
    const room = /^\d{1,12}$/.test(roomId) ? roomId : ''
    if (this.room !== room) {
      this.generation++
      this.room = room
      this.items = standardEmoticons()
      this.loading = null
      this.retryAfter = 0
      this.publish(this.snapshot())
    }
    if (!room || Date.now() < this.retryAfter) return
    if (this.loading) return this.loading
    const generation = this.generation
    const update = (items: DouyuEmoticon[]): void => {
      if (generation !== this.generation) return
      this.items = [...standardEmoticons(), ...items]
      this.publish(this.snapshot())
    }
    this.loading = (async () => {
      const key = `room-${room}.json`
      const cached = await this.cache.read(key)
      if (generation !== this.generation) return
      if (cached) {
        try {
          const parsed = JSON.parse(cached.toString('utf8')) as { items?: DouyuEmoticon[]; updatedAt?: number }
          if (parsed && Array.isArray(parsed.items)) {
            update([...emoticonMap(parsed.items).values()])
            const updatedAt = Math.min(Date.now(), Number(parsed.updatedAt) || 0)
            this.retryAfter = updatedAt + MAX_AGE_MS
            if (Date.now() < this.retryAfter) return
          }
        } catch { /* 损坏缓存重新获取 */ }
      }
      const results = await Promise.allSettled([
        fetchEmoticonResponse(`https://www.douyu.com/japi/interact/comm/dfans/emojis?rid=${room}`),
        fetchEmoticonResponse(`https://www.douyu.com/japi/livebiznc/web/roomemoji/list?rid=${room}`)
      ])
      if (generation !== this.generation) return
      const items = [
        ...(results[0].status === 'fulfilled' ? parseRoomEmoticons(results[0].value, null)
          : this.items.filter(item => item.source !== 'room' && item.source !== 'standard')),
        ...(results[1].status === 'fulfilled' ? parseRoomEmoticons(null, results[1].value)
          : this.items.filter(item => item.source === 'room'))
      ]
      update(items)
      const complete = results.every(result => result.status === 'fulfilled')
      this.retryAfter = Date.now() + (complete ? MAX_AGE_MS : 60_000)
      if (complete) await this.cache.write(key, JSON.stringify({ updatedAt: Date.now(), items })).catch(() => {})
    })().finally(() => { if (generation === this.generation) this.loading = null })
    return this.loading
  }
}
