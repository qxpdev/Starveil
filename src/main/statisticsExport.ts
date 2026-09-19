import ExcelJS from 'exceljs'
import { renameSync, unlinkSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { APP_NAME } from './appMetadata'
import { STATISTICS_RULES, giftAccountingLabel, summarizeUsers, type DailyStatistics, type SavedChat } from '../shared/statistics'

const MONEY_FORMAT = '"¥"#,##0.00;[Red]("¥"#,##0.00);"¥"0.00'
const COUNT_FORMAT = '#,##0;[Red](#,##0);"–"'

function styleSheet(sheet: ExcelJS.Worksheet, widths: number[]): void {
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: Math.min(2, widths.length - 1) }]
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: widths.length } }
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width })
  sheet.eachRow((row, index) => {
    row.height = index === 1 ? 44 : 30
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: index === 1 ? 'FFFFFFFF' : 'FF24463E' }, bold: index === 1 }
      const numeric = typeof cell.value === 'number' || cell.type === ExcelJS.ValueType.Formula
      cell.alignment = { vertical: 'middle', horizontal: numeric ? 'right' : 'left', indent: 1, wrapText: index === 1 }
      if (index === 1 || index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 1 ? 'FF087C82' : 'FFF1F7F5' } }
    })
  })
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: '1:1' }
  sheet.headerFooter.oddFooter = `${APP_NAME} 统计 · &P / &N`
}

/** 名称始终以字符串写入，只有应用自身构造的金额表达式使用公式。 */
export function createStatisticsWorkbook(days: DailyStatistics[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = APP_NAME
  workbook.created = new Date()
  workbook.calcProperties.fullCalcOnLoad = true
  const summary = workbook.addWorksheet('每日汇总')
  summary.addRow(['日期', '直播间 ID', '弹幕条数', '发言人数（日内去重）', '礼物数量', '已确认礼物价值（元）', '待补价数量',
    '全房间排除：疑似机器人', '全房间排除：其他房间', '全房间排除：缺房间标识', '全房间排除：空正文', '缺用户 ID 条数', '疑似机器人过滤',
    '已记录消费（元）', '消费待补价数量', '用户归属'])
  const users = workbook.addWorksheet('用户汇总')
  users.addRow(['用户 UID', '昵称', '弹幕条数', '收到礼物数量', '已确认礼物价值（元）', '已记录消费（元）', '礼物价值待补价数量', '消费待补价数量'])
  for (const user of summarizeUsers(days)) users.addRow([user.userId, user.nick, user.danmakuCount, user.giftCount,
    user.giftValue, user.spending, user.unknownGiftCount, user.unknownSpendingCount])
  const gifts = workbook.addWorksheet('礼物明细')
  gifts.addRow(['日期', '直播间 ID', '用户 UID', '昵称', '礼物 ID', '目录类型', '礼物名称', '数量',
    '收到单价（元）', '收到价值（元）', '消费单价（元）', '本次消费（元）', '价格来源', '记账说明', '来源活动'])
  const sourceNames = { platform: '平台确认', manual: '手动补价', free: '免费礼物', unknown: '待补价' }
  for (const day of days) {
    const date = new Date(`${day.date}T00:00:00Z`)
    summary.addRow([date, day.roomId, day.stats.danmakuCount, day.stats.danmakuUsers, day.stats.giftCount, day.stats.giftValue,
      day.stats.unknownGiftCount || 0, day.exclusions.suspectedRobot, day.exclusions.otherRoom,
      day.exclusions.missingRoom, day.exclusions.emptyText, day.stats.unidentifiedChatCount || 0,
      day.robotFilterModes.length > 1 ? '当日曾切换' : day.robotFilterModes[0] === true ? '开启' : day.robotFilterModes[0] === false ? '关闭' : '无聊天记录',
      day.gifts.reduce((sum, gift) => sum + Math.round((gift.spending || 0) * 100), 0) / 100,
      day.gifts.reduce((sum, gift) => sum + (gift.spending == null ? gift.count : 0), 0),
      day.hasLegacyDetails ? '含旧版未记录归属的数据' : '已保存'])
    for (const gift of day.gifts) {
      const rowNumber = gifts.rowCount + 1
      const value = gift.unitPrice == null || gift.isLottery ? null : { formula: `ROUND(H${rowNumber}*I${rowNumber},2)`, result: gift.value! }
      const spendingUnit = gift.spending == null ? null : gift.spending / gift.count
      const spending = spendingUnit == null ? null : { formula: `ROUND(H${rowNumber}*K${rowNumber},2)`, result: gift.spending! }
      gifts.addRow([date, day.roomId, gift.userId ?? '', gift.nick || (gift.userId === undefined ? '旧版未记录用户' : '未知用户'),
        gift.giftId, gift.isLottery ? '抽奖投入' : gift.catalogType === 'prop' ? '奖励／背包道具' : '普通礼物', gift.name,
        gift.count, gift.unitPrice, value, spendingUnit, spending,
        gift.isLottery ? (gift.spending == null ? '投入价格待确认' : '平台投入价格') : sourceNames[gift.priceSource],
        giftAccountingLabel(gift), gift.sourceName || (gift.sourceGiftId ? `来源 ID ${gift.sourceGiftId}` : '')])
    }
  }
  styleSheet(summary, [19, 17, 14, 21, 14, 24, 16, 22, 21, 23, 19, 20, 22, 23, 20, 30])
  styleSheet(users, [24, 26, 15, 20, 24, 23, 23, 23])
  styleSheet(gifts, [19, 17, 24, 26, 18, 21, 28, 12, 18, 22, 18, 22, 22, 32, 25])
  summary.getColumn(1).numFmt = gifts.getColumn(1).numFmt = 'yyyy-mm-dd'
  summary.getColumn(2).numFmt = gifts.getColumn(2).numFmt = gifts.getColumn(3).numFmt = gifts.getColumn(5).numFmt = users.getColumn(1).numFmt = '@'
  for (let column = 3; column <= 12; column++) summary.getColumn(column).numFmt = column === 6 ? MONEY_FORMAT : COUNT_FORMAT
  summary.getColumn(14).numFmt = MONEY_FORMAT
  summary.getColumn(15).numFmt = COUNT_FORMAT
  for (let column = 3; column <= 8; column++) users.getColumn(column).numFmt = column === 5 || column === 6 ? MONEY_FORMAT : COUNT_FORMAT
  gifts.getColumn(8).numFmt = COUNT_FORMAT
  for (let column = 9; column <= 12; column++) gifts.getColumn(column).numFmt = MONEY_FORMAT
  for (const sheet of [users, gifts]) sheet.eachRow((row, index) => {
    if (index === 1) return
    row.height = 40
    for (const cell of [row.getCell(sheet === users ? 2 : 4), ...(sheet === gifts ? [row.getCell(7), row.getCell(14), row.getCell(15)] : [])]) {
      cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 }
    }
  })
  const chats = workbook.addWorksheet('弹幕记录')
  chats.addRow(['时间（本机时区）', '直播间 ID', '用户 UID', '昵称', '弹幕正文'])
  styleSheet(chats, [25, 18, 24, 26, 88])
  const rules = workbook.addWorksheet('统计口径')
  rules.addRow(['项目', '说明'])
  for (const row of STATISTICS_RULES) rules.addRow([...row])
  styleSheet(rules, [22, 115])
  rules.eachRow((row, index) => {
    if (index > 1) { row.height = 52; row.getCell(2).alignment = { vertical: 'middle', wrapText: true } }
  })
  rules.autoFilter = undefined
  return workbook
}

export async function exportStatisticsWorkbook(filePath: string, days: DailyStatistics[], chats?: AsyncIterable<SavedChat>): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const workbook = createStatisticsWorkbook(days)
    let index = 1
    const newChatSheet = (): ExcelJS.Worksheet => {
      if (index === 1) return workbook.getWorksheet('弹幕记录')!
      const sheet = workbook.addWorksheet(index === 1 ? '弹幕记录' : `弹幕记录 ${index}`)
      sheet.addRow(['时间（本机时区）', '直播间 ID', '用户 UID', '昵称', '弹幕正文'])
      return sheet
    }
    const finishChatSheet = (sheet: ExcelJS.Worksheet): void => {
      styleSheet(sheet, [25, 18, 24, 26, 88])
      sheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss'
      sheet.getColumn(2).numFmt = sheet.getColumn(3).numFmt = '@'
      sheet.eachRow((row, n) => {
        if (n === 1) return
        row.height = Math.min(409, Math.max(42, Math.ceil(String(row.getCell(5).value || '').length / 44) * 16 + 12))
        row.getCell(4).alignment = row.getCell(5).alignment = { vertical: 'middle', wrapText: true, indent: 1 }
      })
    }
    let messages = newChatSheet()
    if (chats) for await (const message of chats) {
      if (messages.rowCount >= 1_000_000) { finishChatSheet(messages); index++; messages = newChatSheet() }
      const localTime = new Date(message.time - new Date(message.time).getTimezoneOffset() * 60_000)
      messages.addRow([localTime, message.roomId, message.userId, message.nick, message.text])
    }
    finishChatSheet(messages)
    await workbook.xlsx.writeFile(temporary)
    renameSync(temporary, filePath)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
