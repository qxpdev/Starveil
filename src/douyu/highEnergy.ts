import type { ChatMessage } from './client'
import { parseDouyuList } from './protocol'

interface HighEnergyReference {
  id: string
  roomId: string
  userId?: string
  nick: string
  avatar?: string
  content?: string
}

export interface HighEnergyEvent {
  action: 'snapshot' | 'add' | 'remove'
  records: HighEnergyReference[]
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return record(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function identifier(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value)
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : ''
}

/**
 * 官网 HighEnergyServices.userList/anchorList:
 * voice_trlt / anchor_voice_trlt 的 mtype=2 为新增，list 为两层 STT 数组。
 * mtype=1 是已有记录快照，其他类型是撤下记录；都不能重播为新弹幕。
 */
export function parseHighEnergyEvent(fields: Record<string, string>, roomId: string): HighEnergyEvent | null {
  if (fields.type !== 'voice_trlt' && fields.type !== 'anchor_voice_trlt') return null
  const action = fields.mtype === '2' ? 'add' : fields.mtype === '1' ? 'snapshot' : 'remove'
  const records: HighEnergyReference[] = []
  if (fields.rid && fields.rid !== roomId) return { action, records }
  for (const item of parseDouyuList(fields.list || '')) {
    const id = identifier(item.vrId)
    if (!id || (item.rid && item.rid !== roomId)) continue
    records.push({ id, roomId, nick: text(item.un), userId: identifier(item.uid) || undefined,
      avatar: text(item.uat) || undefined, content: text(item.content) || undefined })
  }
  return { action, records }
}

/** batchVoiceDetail 返回的 content 才是发送正文，不把语音 URL、昵称或礼物名当正文。 */
export function highEnergyChat(detail: unknown, reference: HighEnergyReference): ChatMessage | null {
  const data = record(detail)
  if (identifier(data.voiceRecordId) !== reference.id) return null
  const roomId = identifier(data.rid ?? data.roomId)
  if (roomId && roomId !== reference.roomId) return null
  const content = text(data.content)
  if (!content || content.length > 10_000) return null
  return {
    messageId: 'high-energy:' + reference.roomId + ':' + reference.id,
    roomId: reference.roomId,
    userId: identifier(data.uid) || reference.userId,
    nick: text(data.userNick) || reference.nick || '观众',
    avatar: text(data.userIcon) || reference.avatar,
    text: content,
    isHighEnergy: true
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('高能正文接口 HTTP ' + response.status)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 512 * 1024) throw new Error('高能正文响应过大')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel() }
}

/** 仅在新广播缺少正文时读取官方详情；访客 CSRF 仅存内存，不使用或保存登录资料。 */
export class HighEnergyReader {
  private pending = new Map<string, HighEnergyReference>()
  private seen = new Set<string>()
  private removed = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller = new AbortController()
  private work: Promise<void> | null = null
  private csrf: { cookie: string; token: string; at: number } | null = null

  constructor(private onMessage: (message: ChatMessage) => void, private request: typeof fetch = fetch,
    private onError: (error: Error) => void = () => {}) {}

  accept(event: HighEnergyEvent): void {
    if (this.controller.signal.aborted) return
    for (const ref of event.records) {
      if (event.action !== 'add') {
        this.seen.add(ref.id)
        if (event.action === 'remove') { this.pending.delete(ref.id); this.removed.add(ref.id) }
        continue
      }
      if (this.seen.has(ref.id)) continue
      this.seen.add(ref.id)
      if (ref.content) {
        const chat = highEnergyChat({ voiceRecordId: ref.id, content: ref.content }, ref)
        if (chat) this.onMessage(chat)
      } else this.pending.set(ref.id, ref)
    }
    // 这些只是待补正文的请求，不占屏幕位置，也不阻塞普通消息。
    while (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!)
    while (this.seen.size > 2000) {
      const id = this.seen.values().next().value!
      this.seen.delete(id); this.removed.delete(id)
    }
    if (this.pending.size && !this.timer && !this.work) this.timer = setTimeout(() => { void this.flush() }, 80)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.work) return this.work
    if (this.controller.signal.aborted || !this.pending.size) return Promise.resolve()
    const references = [...this.pending.values()].slice(0, 40)
    for (const ref of references) this.pending.delete(ref.id)
    this.work = this.resolve(references).catch(error => {
      if (!this.controller.signal.aborted) this.onError(error instanceof Error ? error : new Error(String(error)))
    }).finally(() => {
      this.work = null
      if (this.pending.size && !this.controller.signal.aborted) this.timer = setTimeout(() => { void this.flush() }, 80)
    })
    return this.work
  }

  private async resolve(references: HighEnergyReference[]): Promise<void> {
    const origin = 'https://www.douyu.com'
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: origin + '/pages/high-energy-barrage',
      'X-Requested-With': 'XMLHttpRequest' }
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)])
    if (!this.csrf || Date.now() - this.csrf.at > 300_000) {
      const response = await this.request(origin + '/curl/csrfNlApi/getCsrfCookie', { headers, signal, redirect: 'error' })
      const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]!)
      const token = cookies.find(value => value.startsWith('acf_ccn='))?.slice(8)
      await boundedJson(response)
      if (!token) throw new Error('高能正文接口暂未提供访客校验信息')
      this.csrf = { cookie: cookies.join('; '), token: decodeURIComponent(token), at: Date.now() }
    }
    const response = await this.request(origin + '/japi/revenuenc/web/voiceDanmu/play/batchVoiceDetail', {
      method: 'POST', redirect: 'error', signal,
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: this.csrf.cookie },
      body: new URLSearchParams({ rid: references[0]!.roomId, recordIdList: references.map(ref => ref.id).join(','), ctn: this.csrf.token })
    })
    if (response.status === 403) this.csrf = null
    const result = record(await boundedJson(response))
    if (Number(result.error) !== 0) throw new Error('斗鱼暂未返回高能弹幕正文')
    const records = record(result.data).recordList
    if (!Array.isArray(records)) return
    const requested = new Map(references.map(ref => [ref.id, ref]))
    for (const detail of records.slice(0, 100)) {
      const ref = requested.get(identifier(record(detail).voiceRecordId))
      if (!ref || this.removed.has(ref.id) || this.controller.signal.aborted) continue
      const chat = highEnergyChat(detail, ref)
      if (chat) { requested.delete(ref.id); this.onMessage(chat) }
    }
  }

  stop(): void {
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.seen.clear()
    this.removed.clear()
    this.csrf = null
  }
}
