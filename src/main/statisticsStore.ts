import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, GiftMessage } from '../douyu/client'
import { isKnownFreeGiftName, resolveGiftMetadata, type DouyuGiftMeta } from '../douyu/roomInfo'
import { giftCatalogKey } from '../shared/giftMetadata'
import type { ManualGiftPrices } from '../shared/manualGiftPrices'
import { chatExclusionReason } from '../shared/chatPolicy'
import { localDateKey, normalizeStatisticsQuery, matchesStatisticsUser, summarizeUsers,
  type DailyStatistics, type StatisticsQuery, type StatisticsResult, type UserStatistics } from '../shared/statistics'
import { atomicWrite } from './configStore'
import { withManualGiftPrices } from './giftPricing'
import { SessionStats, type StatisticsState } from './sessionStats'
import { ChatHistoryStore } from './chatHistoryStore'

interface DailyRecord {
  date: string
  roomId: string
  updatedAt: number
  robotFilterModes: Set<boolean>
  stats: SessionStats
}
interface StoredDay {
  version: 1
  date: string
  records: { roomId: string; updatedAt: number; robotFilterModes: boolean[]; state: StatisticsState }[]
}

/** 本机日历日归档；写入时保留上一份有效备份，模拟消息不调用本存储。 */
export class StatisticsStore {
  readonly chats: ChatHistoryStore
  private records = new Map<string, DailyRecord>()
  private dirtyDates = new Set<string>()
  private blockedDates = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private platform = new Map<string, DouyuGiftMeta>()
  private manual: ManualGiftPrices = {}
  private recoveryNotices: string[] = []
  private writeNotice: string | null = null
  private savedAt: number | null = null

  constructor(readonly directory: string, private readonly now: () => number = Date.now,
    private readonly onWriteError?: (message: string) => void) {
    this.chats = new ChatHistoryStore(join(directory, 'danmaku'), now)
  }

  load(): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      const dates = [...new Set(readdirSync(this.directory).flatMap(name => {
        const match = /^(\d{4}-\d{2}-\d{2})\.json(?:\.bak)?$/.exec(name)
        return match ? [match[1]!] : []
      }))].sort()
      for (const date of dates) {
        const file = join(this.directory, `${date}.json`)
        let restoredFrom = ''
        for (const candidate of [file, `${file}.bak`]) {
          if (!existsSync(candidate)) continue
          try {
            const records = this.parseDay(readFileSync(candidate, 'utf8'), date)
            for (const record of records) this.records.set(`${date}:${record.roomId}`, record)
            restoredFrom = candidate
            break
          } catch { /* 主文件不可用时尝试备份 */ }
        }
        if (!restoredFrom) {
          this.blockedDates.add(date)
          this.recoveryNotices.push(`${date} 的历史及备份无法读取，原文件已保留；该日新增记录暂不能保存，请检查统计目录。`)
        } else if (restoredFrom !== file) {
          try {
            // 保留损坏原件成功后才允许回写，避免覆盖唯一的排查依据。
            if (existsSync(file)) copyFileSync(file, `${file}.damaged-${this.now()}`)
            this.recoveryNotices.push(`${date} 已从备份恢复。`)
            this.markDirty(date)
          } catch {
            this.blockedDates.add(date)
            this.recoveryNotices.push(`${date} 已读取备份，但无法另存损坏原件；该日新增记录暂不能保存，请检查统计目录。`)
          }
        }
      }
    } catch (error) { this.reportWriteError(error) }
  }

  private parseDay(text: string, date: string): DailyRecord[] {
    const day: StoredDay = JSON.parse(text.replace(/^\uFEFF/, ''))
    normalizeStatisticsQuery({ startDate: date })
    if (day?.version !== 1 || day.date !== date || !Array.isArray(day.records)) throw new Error('历史日期格式损坏')
    const rooms = new Set<string>()
    return day.records.map(item => {
      if (!item || typeof item.roomId !== 'string' || !/^\d{1,18}$/.test(item.roomId) || rooms.has(item.roomId) ||
        !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0 ||
        !Array.isArray(item.robotFilterModes) || !item.robotFilterModes.every(mode => typeof mode === 'boolean')) throw new Error('历史房间记录损坏')
      rooms.add(item.roomId)
      return { date, roomId: item.roomId, updatedAt: item.updatedAt,
        robotFilterModes: new Set(item.robotFilterModes), stats: SessionStats.restore(item.state, Infinity) }
    })
  }

  private getRecord(roomId: string): DailyRecord {
    if (!/^\d{1,18}$/.test(roomId)) throw new Error('统计需要真实直播间 ID')
    const date = localDateKey(this.now())
    const key = `${date}:${roomId}`
    let record = this.records.get(key)
    if (!record) {
      const stats = new SessionStats(Infinity)
      stats.begin(`live:${roomId}`)
      record = { date, roomId, updatedAt: this.now(), robotFilterModes: new Set(), stats }
      this.records.set(key, record)
    }
    return record
  }

  recordChat(roomId: string, message: ChatMessage, filterSuspectedRobots: boolean, saveText = false): void {
    if (this.alreadyRecorded(roomId, 'chat', message.messageId)) return
    const record = this.getRecord(roomId)
    const reason = chatExclusionReason(message, roomId, filterSuspectedRobots)
    const accepted = reason ? record.stats.recordExcluded(message, reason) : record.stats.recordChat(message)
    if (!accepted) return
    if (!reason && saveText) this.chats.record(roomId, message)
    record.robotFilterModes.add(filterSuspectedRobots)
    record.updatedAt = this.now()
    this.markDirty(record.date)
  }

  recordGift(roomId: string, gift: GiftMessage): void {
    if (gift.type !== 'dgb' || gift.roomId !== roomId) return
    if (this.alreadyRecorded(roomId, 'gift', gift.messageId)) return
    const record = this.getRecord(roomId)
    if (!record.stats.recordGift(gift)) return
    this.reprice(record)
    record.updatedAt = this.now()
    this.markDirty(record.date)
  }

  private alreadyRecorded(roomId: string, kind: 'chat' | 'gift', id?: string): boolean {
    if (!id) return false
    for (const record of this.records.values()) {
      if (record.roomId === roomId && record.stats.hasRecorded(kind, id)) return true
    }
    return false
  }

  /** 已确认的平台历史价格不随以后活动变价改写；未知和手动价格仍可补齐。 */
  updatePricing(platform: ReadonlyMap<string, DouyuGiftMeta>, manual: ManualGiftPrices): void {
    this.platform = new Map(platform)
    this.manual = manual
    for (const record of this.records.values()) {
      if (this.reprice(record)) {
        record.updatedAt = this.now()
        this.markDirty(record.date)
      }
    }
  }

  private reprice(record: DailyRecord): boolean {
    const previous = record.stats.getCatalog()
    const catalog = new Map<string, DouyuGiftMeta>()
    for (const gift of record.stats.getGiftBuckets()) {
      const keys = [gift.giftId ? giftCatalogKey(gift.giftId, gift.giftCatalogType) : '',
        !gift.giftCatalogType ? gift.fallbackGiftId || '' : '', gift.sourceGiftId || ''].filter(Boolean)
      for (const key of keys) {
        const old = previous.get(key)
        const incoming = this.platform.get(key)
        const confirmed = old && old.priceSource !== 'manual' && (old.priceYuan != null || old.isFree || old.isLottery)
        let chosen = incoming?.isLottery ? incoming : confirmed ? old : incoming || old
        if (chosen?.isLottery && old?.isLottery && old.lotteryPriceYuan != null) chosen = { ...chosen, lotteryPriceYuan: old.lotteryPriceYuan }
        if (chosen?.priceSource === 'manual') chosen = { ...chosen, priceYuan: null, isFree: isKnownFreeGiftName(chosen.name), priceSource: undefined }
        if (chosen) catalog.set(key, { ...chosen, image: '' })
      }
    }
    const effective = withManualGiftPrices(catalog, this.manual)
    // 手动表可能含其他历史记录里的礼物；仅保留本日已收到的引用。
    const keys = new Set(record.stats.getGiftBuckets().flatMap(gift => [
      gift.giftId ? giftCatalogKey(gift.giftId, gift.giftCatalogType) : '', !gift.giftCatalogType ? gift.fallbackGiftId || '' : '', gift.sourceGiftId || ''
    ]))
    for (const key of effective.keys()) if (!keys.has(key)) effective.delete(key)
    if (JSON.stringify([...previous]) === JSON.stringify([...effective])) return false
    record.stats.updateCatalog(effective, true)
    return true
  }

  private markDirty(date: string): void {
    this.dirtyDates.add(date)
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, 2_000)
      this.timer.unref()
    }
  }

  private reportWriteError(error: unknown): void {
    const message = `统计历史未保存：${error instanceof Error ? error.message : String(error)}`
    if (this.writeNotice !== message) this.onWriteError?.(message)
    this.writeNotice = message
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const previousChatNotice = this.chats.saveNotice
    const chatSaved = this.chats.flush()
    if (!chatSaved) {
      if (this.chats.saveNotice && previousChatNotice !== this.chats.saveNotice) this.onWriteError?.(this.chats.saveNotice)
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, 5_000)
      this.timer.unref()
    }
    if (!this.dirtyDates.size) return chatSaved
    try {
      mkdirSync(this.directory, { recursive: true })
    } catch (error) { this.reportWriteError(error); return false }
    const failures: string[] = []
    for (const date of this.dirtyDates) {
      try {
        if (this.blockedDates.has(date)) throw new Error(`${date} 的历史文件损坏，已保留原件；新增统计仍在内存中。`)
        const day: StoredDay = { version: 1, date, records: [...this.records.values()]
          .filter(record => record.date === date).map(record => ({ roomId: record.roomId,
            updatedAt: record.updatedAt, robotFilterModes: [...record.robotFilterModes], state: record.stats.exportState() })) }
        const text = `${JSON.stringify(day)}\n`
        const file = join(this.directory, `${date}.json`)
        let backup = text
        if (existsSync(file)) {
          try { const raw = readFileSync(file, 'utf8'); this.parseDay(raw, date); backup = raw }
          catch { /* 不把损坏主文件复制到备份 */ }
        }
        atomicWrite(`${file}.bak`, backup)
        atomicWrite(file, text)
        this.dirtyDates.delete(date)
        this.savedAt = this.now()
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (failures.length) { this.reportWriteError(new Error(failures.join(' '))); return false }
    this.writeNotice = null
    return chatSaved
  }

  pendingGiftReferences(roomId?: string): { giftIds: string[]; propIds: string[] } {
    const giftIds = new Set<string>(), propIds = new Set<string>()
    for (const record of this.records.values()) {
      if (roomId && record.roomId !== roomId) continue
      const catalog = record.stats.getCatalog()
      for (const gift of record.stats.getGiftBuckets()) {
        const meta = resolveGiftMetadata(gift, catalog)
        if ((!meta || !meta.isFree && (meta.isLottery ? meta.lotteryPriceYuan == null : meta.priceYuan == null || meta.priceSource === 'manual')) && gift.giftId) {
          (gift.giftCatalogType === 'prop' ? propIds : giftIds).add(gift.giftId)
        }
        if (gift.sourceGiftId && !catalog.has(gift.sourceGiftId)) giftIds.add(gift.sourceGiftId)
      }
    }
    return { giftIds: [...giftIds], propIds: [...propIds] }
  }

  query(input: StatisticsQuery = {}): StatisticsResult {
    const query = normalizeStatisticsQuery(input)
    const days: DailyStatistics[] = [...this.records.values()]
      .filter(record => (!query.startDate || record.date >= query.startDate) &&
        (!query.endDate || record.date <= query.endDate) && (!query.roomId || query.roomId === record.roomId))
      .sort((a, b) => b.date.localeCompare(a.date) || a.roomId.localeCompare(b.roomId))
      .map(record => {
        const catalog = record.stats.getCatalog()
        const day: DailyStatistics = { date: record.date, roomId: record.roomId, updatedAt: record.updatedAt,
          stats: record.stats.snapshot(), exclusions: record.stats.getExclusions(), robotFilterModes: [...record.robotFilterModes],
          gifts: record.stats.getGiftBuckets().map(gift => {
            const meta = resolveGiftMetadata(gift, catalog)
            const source = gift.sourceGiftId ? catalog.get(gift.sourceGiftId) : undefined
            const free = Boolean(meta?.isFree || isKnownFreeGiftName(gift.name))
            const unitPrice = meta?.isLottery ? null : free ? 0 : meta?.priceYuan ?? null
            const spendingUnit = meta?.isLottery ? meta.lotteryPriceYuan ?? null : gift.giftCatalogType === 'prop' ? 0 : unitPrice
            return { giftId: meta?.id || gift.giftId || gift.fallbackGiftId || '', catalogType: meta?.catalogType || gift.giftCatalogType,
              name: meta?.name || gift.name, count: gift.count, unitPrice,
              value: unitPrice == null ? null : Math.round(unitPrice * 100) * gift.count / 100,
              priceSource: meta?.priceSource === 'manual' ? 'manual' : free ? 'free' : unitPrice == null ? 'unknown' : 'platform',
              isLottery: Boolean(meta?.isLottery), userId: gift.userId, nick: gift.nick,
              sourceGiftId: gift.sourceGiftId, sourceName: source?.isLottery ? source.name : undefined,
              isLotteryReward: gift.giftCatalogType === 'prop' && Boolean(source?.isLottery),
              spending: spendingUnit == null ? null : Math.round(spendingUnit * 100) * gift.count / 100 }
          }) }
        const users = new Map<string, UserStatistics>()
        const getUser = (userId: string, nick: string): UserStatistics => {
          let user = users.get(userId)
          if (!user) {
            user = { userId, nick, danmakuCount: 0, giftCount: 0, giftValue: 0, spending: 0, unknownGiftCount: 0, unknownSpendingCount: 0 }
            users.set(userId, user)
          } else if (nick) user.nick = nick
          return user
        }
        for (const item of record.stats.getChatUsers()) getUser(item.userId, item.nick).danmakuCount += item.count
        for (const gift of day.gifts) {
          if (gift.userId === undefined) continue
          const user = getUser(gift.userId, gift.nick || '未知用户')
          if (!gift.isLottery) {
            user.giftCount += gift.count
            if (gift.value == null) user.unknownGiftCount += gift.count
            else user.giftValue = (Math.round(user.giftValue * 100) + Math.round(gift.value * 100)) / 100
          }
          if (gift.spending == null) user.unknownSpendingCount += gift.count
          else user.spending = (Math.round(user.spending * 100) + Math.round(gift.spending * 100)) / 100
        }
        day.hasLegacyDetails = day.gifts.some(gift => gift.userId === undefined) ||
          [...users.values()].reduce((total, user) => total + user.danmakuCount, 0) < day.stats.danmakuCount
        day.users = [...users.values()].filter(user => matchesStatisticsUser(user.userId, user.nick, query))
        if (query.user || query.userId) {
          const matchingIds = new Set(day.users.map(user => user.userId))
          day.gifts = day.gifts.filter(gift => gift.userId !== undefined && matchingIds.has(gift.userId))
          const summary = day.users.reduce((sum, user) => ({
            danmakuCount: sum.danmakuCount + user.danmakuCount, giftCount: sum.giftCount + user.giftCount,
            giftValue: (Math.round(sum.giftValue * 100) + Math.round(user.giftValue * 100)) / 100,
            unknownGiftCount: sum.unknownGiftCount + user.unknownGiftCount
          }), { danmakuCount: 0, giftCount: 0, giftValue: 0, unknownGiftCount: 0 })
          day.stats = { ...day.stats, ...summary, danmakuUsers: day.users.filter(user => user.userId && user.danmakuCount).length, unidentifiedChatCount: 0 }
        }
        return day
      })
      .filter(day => !(query.user || query.userId) || day.users!.length > 0)
    return { days, rooms: [...new Set([...this.records.values()].map(record => record.roomId))].sort(),
      users: summarizeUsers(days),
      directory: this.directory, savedAt: this.savedAt,
      notice: [this.writeNotice, this.chats.saveNotice, ...this.recoveryNotices].filter(Boolean).join(' ') || null }
  }
}
