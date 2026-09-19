import type { ChatExclusions } from './chatPolicy'
import type { GiftCatalogType, OverlayStatsPayload } from './types'

export interface StatisticsQuery { startDate?: string; endDate?: string; roomId?: string; user?: string; userId?: string; keyword?: string }
export interface ChatHistoryQuery extends StatisticsQuery { keyword?: string; offset?: number; limit?: number }
export interface SavedChat {
  id: string
  time: number
  roomId: string
  userId: string
  nick: string
  text: string
}
export interface ChatHistoryResult { messages: SavedChat[]; total: number; hasMore: boolean; notice: string | null }
export interface UserStatistics {
  userId: string
  nick: string
  danmakuCount: number
  giftCount: number
  giftValue: number
  spending: number
  unknownGiftCount: number
  unknownSpendingCount: number
}
export interface DailyGiftSummary {
  giftId: string
  catalogType?: GiftCatalogType
  name: string
  count: number
  unitPrice: number | null
  value: number | null
  priceSource: 'platform' | 'manual' | 'unknown' | 'free'
  isLottery: boolean
  userId?: string
  nick?: string
  sourceGiftId?: string
  sourceName?: string
  isLotteryReward?: boolean
  /** 普通礼物或抽奖投入金额；奖励和背包道具不推定本次购买消费。 */
  spending?: number | null
}
export interface DailyStatistics {
  date: string
  roomId: string
  updatedAt: number
  stats: OverlayStatsPayload
  exclusions: ChatExclusions
  robotFilterModes: boolean[]
  gifts: DailyGiftSummary[]
  users?: UserStatistics[]
  /** 旧版未保存用户归属，无法用昵称或 UID 追溯。 */
  hasLegacyDetails?: boolean
}
export interface StatisticsResult {
  days: DailyStatistics[]
  rooms: string[]
  directory: string
  savedAt: number | null
  notice: string | null
  users: UserStatistics[]
}
export interface StatisticsExportResult { canceled: boolean; filePath?: string }

export const STATISTICS_RULES = [
  ['日期与房间', '按本机日期和真实直播间 ID 记录；同日重启继续累计，跨日自动分开。'],
  ['弹幕条数', '只统计来自当前房间的 chatmsg。其他房间、无房间标识、空正文分别排除；进场、贵族、全站广播不计入弹幕。'],
  ['疑似机器人', '开启过滤时，无有效 dms 字段的消息不计入。dms 是智能弹幕字段，不能保证识别所有真人或机器人。过滤开关变更只影响后续消息。'],
  ['发言人数', '按同一天、同一直播间的用户 ID 去重；缺少有效用户 ID 的弹幕计条数但不猜测人数。各日人数不可相加当作跨日唯一人数。'],
  ['去重与显示', '使用平台事件 ID 去重。黑名单、合并显示、字号、显示时长和队列裁剪只影响画面，不改变已接收的有效聊天统计。'],
  ['礼物数量', '只统计本直播间的实际赠送事件 dgb，按本次数量计算，不乘累计连击数；免费礼物计数量、价值为零。'],
  ['抽奖与活动', '抽奖投入单独记录消费，不重复计入收到的礼物价值；实际奖励按自己的 ID 及数量计价。投入行不是等待价格的奖励行，未取得对应广播时不猜测开奖结果。'],
  ['用户消费', '按用户 UID 归属，消费为已记录的普通送礼金额加抽奖投入；奖励和背包道具不重复作为本次购买。仅为本机收到广播的已知金额，不是平台账单，也不是主播提现收入。'],
  ['礼物价值', '未知单价留空，不当作零元；金额仅为已确认的礼物价值，不代表主播到手收入。历史已确认的平台单价保留，待定或手动价格可补齐。'],
  ['记录范围', '开启每日统计后记录新消息，关闭后停止新增；已有历史保留。旧版未保存的用户归属与正文、离线或断线数据无法补回。模拟测试不写入历史。'],
  ['弹幕查证', '另行开启保存弹幕正文后，保存已通过来源过滤的聊天时间、UID、昵称和正文，可按用户和关键词查询；显示折叠不丢弃查证记录。'],
  ['本地保存', '仅保存在本机配置目录的 statistics 文件夹，正文按日期追加到 danmaku 子目录。导出包含所选日期、直播间和用户的记录。']
] as const

export function localDateKey(time = Date.now()): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function normalizeStatisticsQuery(query: StatisticsQuery = {}): StatisticsQuery {
  const result: StatisticsQuery = {}
  for (const field of ['startDate', 'endDate'] as const) {
    const value = query?.[field]
    if (!value) continue
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw new Error('请选择有效的开始和结束日期。')
    }
    result[field] = value
  }
  if (result.startDate && result.endDate && result.startDate > result.endDate) throw new Error('开始日期不能晚于结束日期。')
  if (query?.roomId) {
    if (typeof query.roomId !== 'string' || !/^\d{1,18}$/.test(query.roomId)) throw new Error('直播间筛选无效。')
    result.roomId = query.roomId
  }
  if (query?.userId) {
    if (typeof query.userId !== 'string' || !/^\d{1,20}$/.test(query.userId) || query.userId === '0') throw new Error('用户 UID 筛选无效。')
    result.userId = query.userId
  }
  if (query?.user) {
    if (typeof query.user !== 'string' || query.user.length > 100) throw new Error('用户筛选最多 100 个字符。')
    if (query.user.trim()) result.user = query.user.trim()
  }
  return result
}

export function matchesStatisticsUser(userId: string | undefined, nick: string | undefined, query: StatisticsQuery): boolean {
  if (query.userId && userId !== query.userId) return false
  if (!query.user) return true
  return userId === query.user || Boolean(nick?.toLocaleLowerCase().includes(query.user.toLocaleLowerCase()))
}

export function giftAccountingLabel(gift: DailyGiftSummary): string {
  if (gift.isLottery) return '投入另列，奖励单独计入'
  if (gift.unitPrice == null) return '数量已计入，价值待补齐'
  return gift.isLotteryReward ? '奖励已计入' : '已计入'
}

export function summarizeUsers(days: readonly DailyStatistics[]): UserStatistics[] {
  const users = new Map<string, UserStatistics>()
  // 查询通常按日期倒序返回；按时间累计，避免旧昵称覆盖最近的昵称。
  const chronological = [...days].sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt - b.updatedAt)
  for (const day of chronological) for (const item of day.users || []) {
    const key = item.userId || 'unknown'
    const user = users.get(key) || { userId: item.userId, nick: item.nick, danmakuCount: 0, giftCount: 0,
      giftValue: 0, spending: 0, unknownGiftCount: 0, unknownSpendingCount: 0 }
    if (item.nick) user.nick = item.nick
    user.danmakuCount += item.danmakuCount
    user.giftCount += item.giftCount
    user.giftValue = (Math.round(user.giftValue * 100) + Math.round(item.giftValue * 100)) / 100
    user.spending = (Math.round(user.spending * 100) + Math.round(item.spending * 100)) / 100
    user.unknownGiftCount += item.unknownGiftCount
    user.unknownSpendingCount += item.unknownSpendingCount
    users.set(key, user)
  }
  return [...users.values()].sort((a, b) => b.spending - a.spending || b.giftValue - a.giftValue || b.danmakuCount - a.danmakuCount)
}
