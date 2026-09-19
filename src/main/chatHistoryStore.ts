import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { ChatMessage } from '../douyu/client'
import { localDateKey, matchesStatisticsUser, normalizeStatisticsQuery,
  type ChatHistoryQuery, type ChatHistoryResult, type SavedChat } from '../shared/statistics'

/** 按天追加正文，查询流式扫描，避免把长期弹幕日志常驻内存或每次全量重写。 */
export class ChatHistoryStore {
  private pending = new Map<string, SavedChat[]>()
  private notice: string | null = null
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {}

  get saveNotice(): string | null { return this.notice }

  record(roomId: string, message: ChatMessage): void {
    const time = this.now()
    const date = localDateKey(time)
    const records = this.pending.get(date) || []
    records.push({ id: message.messageId
      ? createHash('sha256').update(`${roomId}:${message.messageId}`).digest('base64url') : randomUUID(),
    time, roomId, userId: message.userId && message.userId !== '0' ? message.userId : '',
    nick: message.nick || '未知用户', text: message.text })
    this.pending.set(date, records)
  }

  flush(): boolean {
    if (!this.pending.size) return true
    try {
      mkdirSync(this.directory, { recursive: true })
      for (const [date, messages] of this.pending) {
        // 前导换行隔离异常断电留下的不完整末行，原记录不被覆盖。
        appendFileSync(join(this.directory, `${date}.jsonl`), `\n${messages.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
        this.pending.delete(date)
      }
      this.notice = null
      return true
    } catch (error) {
      this.notice = `弹幕正文尚未保存：${error instanceof Error ? error.message : String(error)}`
      return false
    }
  }

  read(input: ChatHistoryQuery = {}): AsyncGenerator<SavedChat> {
    const query = normalizeStatisticsQuery(input)
    if (input.keyword != null && (typeof input.keyword !== 'string' || input.keyword.length > 200)) throw new Error('弹幕关键词最多 200 个字符。')
    const keyword = input.keyword?.trim().toLocaleLowerCase()
    this.flush()
    const seen = new Set<string>()
    const accepts = (item: SavedChat): boolean => {
      if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.time) || item.time < 0 ||
        typeof item.roomId !== 'string' || typeof item.userId !== 'string' || typeof item.nick !== 'string' || typeof item.text !== 'string') return false
      if (query.roomId && item.roomId !== query.roomId || !matchesStatisticsUser(item.userId, item.nick, query) ||
        keyword && !item.text.toLocaleLowerCase().includes(keyword) || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    }
    const inRange = (date: string): boolean => (!query.startDate || date >= query.startDate) && (!query.endDate || date <= query.endDate)
    const dates = existsSync(this.directory) ? readdirSync(this.directory)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && inRange(name.slice(0, 10))).sort() : []
    // 调用时固定文件末尾和待保存消息，导出过程中到达的弹幕留到下一次。
    // 与同步取得的每日汇总共享截止点，也避免长文件扫描追赶持续追加的数据。
    const files = dates.map(name => {
      const file = join(this.directory, name)
      return { file, size: statSync(file).size }
    }).filter(item => item.size > 0)
    // 保存失败时仍能查询本次内存中尚未落盘的消息，并给出明确提示。
    const pending = [...this.pending].flatMap(([date, messages]) => inRange(date) ? [...messages] : [])
    return (async function* () {
      for (const { file, size } of files) {
        const stream = createReadStream(file, { encoding: 'utf8', end: size - 1 })
        const lines = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const line of lines) {
            if (!line.trim()) continue
            let item: SavedChat
            try { item = JSON.parse(line) as SavedChat } catch { continue }
            if (accepts(item)) yield item
          }
        } finally { lines.close(); stream.destroy() }
      }
      for (const message of pending) if (accepts(message)) yield { ...message }
    })()
  }

  async query(input: ChatHistoryQuery = {}): Promise<ChatHistoryResult> {
    const limit = input.limit == null ? 100 : input.limit
    const offset = input.offset == null ? 0 : input.offset
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('弹幕分页参数无效。')
    // 返回最新记录。环形缓冲只保留当前页及其之前需要跳过的记录。
    const capacity = offset + limit
    const buffer: SavedChat[] = []
    let total = 0
    for await (const item of this.read(input)) { buffer[total % capacity] = item; total++ }
    const messages: SavedChat[] = []
    for (let index = total - 1 - offset; index >= Math.max(0, total - offset - limit); index--) {
      const item = buffer[index % capacity]
      if (item) messages.push(item)
    }
    return { messages, total, hasMore: total > offset + limit, notice: this.notice }
  }
}
