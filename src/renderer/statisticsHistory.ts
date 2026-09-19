import { localDateKey, normalizeStatisticsQuery, STATISTICS_RULES, giftAccountingLabel,
  type DailyStatistics, type StatisticsQuery, type StatisticsResult, type ChatHistoryResult } from '../shared/statistics'
import { parseManualGiftPrice } from '../shared/manualGiftPrices'
import type { GiftPricePatch } from '../shared/types'

const count = (value: number): string => value.toLocaleString('zh-CN')
const money = (value: number): string => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className; element.textContent = text
  return element
}

export function installStatisticsHistory(): { waitForSave: () => Promise<boolean> } {
  const api = window.settingsApi
  const page = document.querySelector<HTMLElement>('[data-page="history"]')!
  const start = document.getElementById('historyStart') as HTMLInputElement
  const end = document.getElementById('historyEnd') as HTMLInputElement
  const room = document.getElementById('historyRoom') as HTMLSelectElement
  const userFilter = document.getElementById('historyUser') as HTMLInputElement
  const keyword = document.getElementById('historyChatKeyword') as HTMLInputElement
  const userRows = document.getElementById('historyUserRows')!
  const chatRows = document.getElementById('historyChatRows')!
  const rows = document.getElementById('historyRows')!
  const status = document.getElementById('historyActionStatus')!
  const exportButton = document.getElementById('exportHistory') as HTMLButtonElement
  const refreshButton = document.getElementById('refreshHistory') as HTMLButtonElement
  const expanded = new Set<string>()
  let result: StatisticsResult | null = null
  let request = 0
  let signature = ''
  let savingPrice: Promise<boolean> | null = null
  let exporting = false
  let relativeDays: number | null = null
  let view: 'daily' | 'users' | 'chats' = 'daily'
  let userPage = 0
  let chatOffset = 0
  let chatRequest = 0
  let chatSignature = ''
  let lastChatRefresh = 0
  let chatLoading = false
  let inputTimer: ReturnType<typeof setTimeout> | null = null
  let recording = { dailyStatisticsEnabled: true, saveDanmakuHistory: false }

  function showStatus(text: string, error = false): void { status.textContent = text; status.dataset.error = String(error) }
  function query(): StatisticsQuery {
    if (relativeDays && end.value !== localDateKey()) setRange(relativeDays)
    const user = userFilter.value.trim()
    return normalizeStatisticsQuery({ startDate: start.value, endDate: end.value, roomId: room.value,
      ...(/^\d{1,20}$/.test(user) && user !== '0' ? { userId: user } : { user }) })
  }
  function resetPages(): void { userPage = 0; chatOffset = 0; chatSignature = ''; chatRequest++ }
  function selectView(next: typeof view): void {
    view = next
    for (const button of page.querySelectorAll<HTMLButtonElement>('[data-history-view]')) {
      button.setAttribute('aria-selected', String(button.dataset.historyView === next))
    }
    for (const [name, id] of [['daily', 'historyDailyPanel'], ['users', 'historyUsersPanel'], ['chats', 'historyChatsPanel']]) {
      document.getElementById(id!)!.hidden = name !== next
    }
    if (next === 'chats') void refreshChats(true)
    if (next === 'users') renderUsers()
  }
  function focusUser(userId: string): void {
    if (!userId) return
    userFilter.value = userId
    resetPages()
    selectView('chats')
    void refresh(true)
  }
  function renderUsers(): void {
    const users = result?.users || []
    const pages = Math.max(1, Math.ceil(users.length / 100))
    userPage = Math.min(userPage, pages - 1)
    const fragment = document.createDocumentFragment()
    for (const user of users.slice(userPage * 100, (userPage + 1) * 100)) {
      const row = node('tr'), identity = node('td')
      const name = node('button', 'history-user-link', user.nick || '未知用户')
      name.type = 'button'; name.disabled = !user.userId
      name.addEventListener('click', () => focusUser(user.userId))
      identity.append(name, node('span', 'history-user-id', user.userId ? `UID ${user.userId}` : '未提供 UID，无法确认同一用户'))
      row.append(identity, node('td', 'numeric', count(user.danmakuCount)))
      const value = node('td', 'numeric', `¥${money(user.giftValue)}`)
      if (user.unknownGiftCount) value.append(node('span', 'history-pending', `${count(user.unknownGiftCount)} 件待补价`))
      const spent = node('td', 'numeric history-spending', `¥${money(user.spending)}`)
      if (user.unknownSpendingCount) spent.append(node('span', 'history-pending', `${count(user.unknownSpendingCount)} 件消费待补价`))
      const action = node('td'), button = node('button', 'button quiet history-expand', '弹幕')
      button.type = 'button'; button.disabled = !user.userId; button.setAttribute('aria-label', `查看 ${user.nick} 的弹幕`)
      button.addEventListener('click', () => focusUser(user.userId)); action.append(button)
      row.append(value, spent, action); fragment.append(row)
    }
    userRows.replaceChildren(fragment)
    document.getElementById('historyUsersEmpty')!.hidden = users.length > 0
    document.getElementById('usersPageLabel')!.textContent = `${count(users.length)} 位用户 · ${userPage + 1} / ${pages}`
    ;(document.getElementById('usersPrevious') as HTMLButtonElement).disabled = userPage === 0
    ;(document.getElementById('usersNext') as HTMLButtonElement).disabled = userPage + 1 >= pages
  }

  function renderChats(next: ChatHistoryResult): void {
    const signature = JSON.stringify([next, keyword.value, recording])
    if (signature === chatSignature) return
    chatSignature = signature
    const fragment = document.createDocumentFragment()
    const needle = keyword.value.trim().toLocaleLowerCase()
    for (const chat of next.messages) {
      const row = node('li', 'history-chat-record'), meta = node('div', 'history-chat-meta')
      meta.append(node('time', '', new Date(chat.time).toLocaleString('zh-CN', { hour12: false })),
        node('strong', '', chat.nick), node('span', '', `UID ${chat.userId || '未提供'} · 房间 ${chat.roomId}`))
      const text = node('p', 'history-chat-text')
      if (!needle) text.textContent = chat.text
      else {
        let offset = 0
        const lower = chat.text.toLocaleLowerCase()
        for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, offset)) {
          text.append(document.createTextNode(chat.text.slice(offset, at)), node('mark', '', chat.text.slice(at, at + needle.length)))
          offset = at + needle.length
        }
        text.append(document.createTextNode(chat.text.slice(offset)))
      }
      row.append(meta, text); fragment.append(row)
    }
    chatRows.replaceChildren(fragment)
    document.getElementById('historyChatHint')!.textContent = next.notice || (next.total
      ? `找到 ${count(next.total)} 条已保存的弹幕，按接收时间从新到旧排列。${recording.dailyStatisticsEnabled && recording.saveDanmakuHistory ? '' : '当前未开启正文记录，已有弹幕仍可查询。'}`
      : recording.dailyStatisticsEnabled && recording.saveDanmakuHistory ? '这个筛选范围内没有保存的弹幕。开启前与离线期间的正文无法补回。'
        : '当前未开启正文记录。可在上方开启“每日统计”和“保存弹幕正文”，之后收到的弹幕会保存在本机。')
    const pageCount = Math.max(1, Math.ceil(next.total / 100))
    document.getElementById('chatsPageLabel')!.textContent = `${Math.floor(chatOffset / 100) + 1} / ${pageCount}`
    ;(document.getElementById('chatsPrevious') as HTMLButtonElement).disabled = chatOffset === 0
    ;(document.getElementById('chatsNext') as HTMLButtonElement).disabled = !next.hasMore
  }

  async function refreshChats(force = false): Promise<void> {
    if (view !== 'chats' || !force && (chatLoading || Date.now() - lastChatRefresh < 10_000)) return
    const sequence = ++chatRequest
    chatLoading = true; lastChatRefresh = Date.now()
    try {
      const next = await api.getChatHistory({ ...query(), keyword: keyword.value.trim(), offset: chatOffset, limit: 100 })
      if (sequence === chatRequest) renderChats(next)
    } catch (error) { if (sequence === chatRequest) showStatus(error instanceof Error ? error.message : String(error), true) }
    finally { if (sequence === chatRequest) chatLoading = false }
  }
  function setRange(days: number): void {
    resetPages()
    relativeDays = days
    const date = new Date()
    end.value = days ? localDateKey(date.getTime()) : ''
    date.setDate(date.getDate() - Math.max(0, days - 1))
    start.value = days ? localDateKey(date.getTime()) : ''
    for (const button of page.querySelectorAll<HTMLButtonElement>('[data-history-days]')) button.setAttribute('aria-pressed', String(Number(button.dataset.historyDays) === days))
  }

  async function savePrice(patch: GiftPricePatch): Promise<boolean> {
    if (savingPrice) return savingPrice
    showStatus('正在保存补价…')
    for (const button of rows.querySelectorAll<HTMLButtonElement>('.history-gift-price button')) button.disabled = true
    savingPrice = (async () => {
      try {
        await api.setGiftPrice(patch)
        showStatus(patch.priceYuan == null ? '已清除手动补价，历史金额已重新计算。' : '补价已保存，相关历史金额已重新计算。')
        signature = ''
        await refresh(true)
        return true
      } catch (error) { showStatus(error instanceof Error ? error.message : String(error), true); return false }
      finally {
        savingPrice = null
        for (const button of rows.querySelectorAll<HTMLButtonElement>('.history-gift-price button')) button.disabled = false
      }
    })()
    return savingPrice
  }

  function details(day: DailyStatistics): HTMLElement {
    const panel = node('div', 'history-detail')
    panel.append(node('h3', '', `${day.date} · 房间 ${day.roomId}`))
    const exclusions = node('div', 'history-exclusions')
    const names = { suspectedRobot: '疑似机器人', otherRoom: '其他房间', missingRoom: '缺房间标识', emptyText: '空正文' }
    for (const key of Object.keys(names) as (keyof typeof names)[]) exclusions.append(node('span', '', `${names[key]}：${count(day.exclusions[key])}`))
    panel.append(node('p', 'history-detail-caption', '当日整个直播间已排除的聊天消息（不随用户筛选变化）'), exclusions)
    if (day.stats.unidentifiedChatCount) panel.append(node('p', 'history-detail-caption', `${count(day.stats.unidentifiedChatCount)} 条消息缺少用户 ID，计入条数但无法计入人数。`))
    panel.append(node('p', 'history-detail-caption', `疑似机器人过滤：${day.robotFilterModes.length > 1 ? '当日曾切换，仅影响开关切换后的消息' : day.robotFilterModes[0] === true ? '开启' : day.robotFilterModes[0] === false ? '关闭' : '尚无聊天记录'}`))
    const heading = node('h3', '', '收到的礼物')
    panel.append(heading)
    if (!day.gifts.length) panel.append(node('p', 'history-detail-caption', '这一天还没有收到礼物。'))
    for (const gift of day.gifts) {
      const item = node('div', 'history-gift')
      const info = node('div', 'history-gift-info')
      info.append(node('strong', '', `${gift.name} ×${count(gift.count)}`))
      const kind = gift.catalogType === 'prop' ? '奖励道具' : '普通礼物'
      const pricing = gift.isLottery ? `抽奖投入${gift.spending == null ? '价格待确认' : ` ¥${money(gift.spending)}`}；奖励收到后单独计入礼物价值` : gift.unitPrice == null ? '数量已计入，价格待确认' :
        `单价 ¥${money(gift.unitPrice)} · 合计 ¥${money(gift.value || 0)} · ${gift.priceSource === 'manual' ? '手动补价' : gift.priceSource === 'free' ? '免费礼物' : '平台确认'}`
      const sender = node('button', 'history-user-link history-gift-user', gift.nick || (gift.userId === undefined ? '旧版未记录用户' : '未知用户'))
      sender.type = 'button'; sender.disabled = !gift.userId
      sender.addEventListener('click', () => focusUser(gift.userId!))
      info.append(sender)
      if (gift.userId) info.append(node('span', 'history-user-id', `UID ${gift.userId}`))
      info.append(node('span', '', `${kind} ID ${gift.giftId || '未提供'} · ${pricing}`))
      info.append(node('span', '', `${giftAccountingLabel(gift)}${gift.sourceName ? ` · 来源：${gift.sourceName}` : ''}`))
      item.append(info)
      if (!gift.isLottery && (gift.priceSource === 'unknown' || gift.priceSource === 'manual')) {
        if (/^\d{1,18}$/.test(gift.giftId) && gift.giftId !== '0') {
          const form = node('form', 'history-gift-price')
          const input = node('input')
          input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '0.01'; input.placeholder = '单价 / 元'
          input.setAttribute('aria-label', `${gift.name}单价（元）`)
          if (gift.priceSource === 'manual' && gift.unitPrice != null) input.value = String(gift.unitPrice)
          const button = node('button', 'button', gift.priceSource === 'manual' ? '修改' : '补价')
          button.type = 'submit'
          const patch = { giftId: gift.giftId, catalogType: gift.catalogType, name: gift.name }
          form.addEventListener('submit', event => {
            event.preventDefault()
            const value = parseManualGiftPrice(input.value)
            if (value == null) { showStatus('请输入 0 至 1000000 元的单价，最多两位小数。', true); input.focus(); return }
            void savePrice({ ...patch, priceYuan: value })
          })
          form.append(input, button)
          if (gift.priceSource === 'manual') {
            const clear = node('button', 'button quiet', '清除')
            clear.type = 'button'; clear.addEventListener('click', () => { void savePrice({ ...patch, priceYuan: null }) })
            form.append(clear)
          }
          item.append(form)
        } else item.append(node('span', 'history-detail-caption', '平台未提供有效 ID，暂不能补价'))
      }
      panel.append(item)
    }
    return panel
  }

  function renderTable(): void {
    if (!result) return
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.historyKey : ''
    const content = document.createDocumentFragment()
    for (const day of result.days) {
      const key = `${day.date}:${day.roomId}`
      const row = node('tr')
      const identity = node('td', 'history-identity')
      identity.append(node('strong', '', day.date), node('span', '', `房间 ${day.roomId}`))
      row.append(identity, node('td', 'numeric', count(day.stats.danmakuCount)), node('td', 'numeric', count(day.stats.danmakuUsers)), node('td', 'numeric', count(day.stats.giftCount)))
      const value = node('td', 'numeric history-value')
      value.append(node('strong', '', `¥${money(day.stats.giftValue)}`))
      if (day.stats.unknownGiftCount) value.append(node('span', 'history-pending', `${count(day.stats.unknownGiftCount)} 个待补价`))
      row.append(value)
      const actions = node('td', 'history-row-action')
      const button = node('button', 'button quiet history-expand', expanded.has(key) ? '收起' : '查看')
      button.type = 'button'; button.dataset.historyKey = key
      button.setAttribute('aria-label', `${expanded.has(key) ? '收起' : '查看'} ${day.date} 房间 ${day.roomId} 明细`)
      button.setAttribute('aria-expanded', String(expanded.has(key)))
      button.addEventListener('click', () => { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); renderTable() })
      actions.append(button); row.append(actions); content.append(row)
      if (expanded.has(key)) {
        const detailRow = node('tr', 'history-detail-row')
        const cell = node('td'); cell.colSpan = 6; cell.append(details(day)); detailRow.append(cell); content.append(detailRow)
      }
    }
    rows.replaceChildren(content)
    if (focused) [...rows.querySelectorAll<HTMLButtonElement>('[data-history-key]')].find(button => button.dataset.historyKey === focused)?.focus({ preventScroll: true })
  }

  function render(next: StatisticsResult, force: boolean): void {
    const nextSignature = JSON.stringify(next.days)
    result = next
    const roomsKey = next.rooms.join(',')
    if (room.dataset.rooms !== roomsKey) {
      const selected = room.value
      room.replaceChildren(new Option('全部直播间', ''), ...next.rooms.map(id => new Option(`房间 ${id}`, id)))
      if (next.rooms.includes(selected)) room.value = selected
      room.dataset.rooms = roomsKey
    }
    const total = next.days.reduce((sum, day) => ({ chats: sum.chats + day.stats.danmakuCount, gifts: sum.gifts + day.stats.giftCount,
      valueFen: sum.valueFen + Math.round(day.stats.giftValue * 100), pending: sum.pending + (day.stats.unknownGiftCount || 0) }), { chats: 0, gifts: 0, valueFen: 0, pending: 0 })
    document.getElementById('historyChatTotal')!.textContent = count(total.chats)
    document.getElementById('historyGiftTotal')!.textContent = count(total.gifts)
    document.getElementById('historyValueTotal')!.textContent = `¥${money(total.valueFen / 100)}`
    document.getElementById('historyValueNote')!.textContent = total.pending ? `${count(total.pending)} 个礼物待补价` : '已确认金额'
    document.getElementById('historyScope')!.textContent = `${new Set(next.days.map(day => day.date)).size} 天 · ${next.days.length} 条房间记录；发言人数按每一天、每个房间去重。`
    document.getElementById('historyEmpty')!.hidden = next.days.length > 0
    document.getElementById('historyTableWrap')!.hidden = !next.days.length
    exportButton.disabled = exporting || !next.days.length
    const notice = document.getElementById('historyStorageNotice')!
    notice.textContent = next.notice || ''; notice.hidden = !next.notice
    document.getElementById('historyStorageHint')!.textContent = `保存在本机 · ${next.directory}`
    const editing = document.activeElement?.closest('.history-gift-price')
    if ((force || !editing) && signature !== nextSignature) { signature = nextSignature; renderTable(); renderUsers() }
  }

  async function refresh(force = false): Promise<void> {
    const sequence = ++request
    try {
      const next = await api.getStatistics(query())
      if (sequence === request) render(next, force)
      if (sequence === request) void refreshChats(force)
    } catch (error) { if (sequence === request) showStatus(error instanceof Error ? error.message : String(error), true) }
  }
  for (const button of page.querySelectorAll<HTMLButtonElement>('[data-history-days]')) button.addEventListener('click', () => {
    setRange(Number(button.dataset.historyDays)); showStatus(''); void refresh(true)
  })
  for (const input of [start, end, room]) input.addEventListener('change', () => {
    resetPages()
    if (input !== room) {
      relativeDays = null
      for (const button of page.querySelectorAll<HTMLButtonElement>('[data-history-days]')) button.setAttribute('aria-pressed', 'false')
    }
    showStatus(''); void refresh(true)
  })
  refreshButton.addEventListener('click', () => { void refresh(true) })
  for (const button of page.querySelectorAll<HTMLButtonElement>('[data-history-view]')) button.addEventListener('click', () => selectView(button.dataset.historyView as typeof view))
  for (const input of [userFilter, keyword]) input.addEventListener('input', () => {
    if (inputTimer) clearTimeout(inputTimer)
    inputTimer = setTimeout(() => { resetPages(); if (input === keyword) void refreshChats(true); else void refresh(true) }, 280)
  })
  document.getElementById('clearHistoryUser')!.addEventListener('click', () => { userFilter.value = ''; resetPages(); void refresh(true) })
  document.getElementById('usersPrevious')!.addEventListener('click', () => { userPage = Math.max(0, userPage - 1); renderUsers() })
  document.getElementById('usersNext')!.addEventListener('click', () => { userPage++; renderUsers() })
  document.getElementById('chatsPrevious')!.addEventListener('click', () => { chatOffset = Math.max(0, chatOffset - 100); void refreshChats(true) })
  document.getElementById('chatsNext')!.addEventListener('click', () => { chatOffset += 100; void refreshChats(true) })
  const onConfig = (config: typeof recording): void => { recording = config; if (view === 'chats') void refreshChats(true) }
  void api.getConfig().then(onConfig).catch(() => {})
  api.onConfig(onConfig)
  exportButton.addEventListener('click', () => {
    if (exporting) return
    void (async () => {
      exporting = true; exportButton.disabled = true; exportButton.textContent = '正在导出…'
      try {
        if (savingPrice && !await savingPrice) return
        const exported = await api.exportStatistics({ ...query(), ...(view === 'chats' ? { keyword: keyword.value.trim() } : {}) })
        if (!exported.canceled) showStatus(`已导出：${exported.filePath}`)
      } catch (error) { showStatus(error instanceof Error ? error.message : String(error), true) }
      finally { exporting = false; exportButton.disabled = !result?.days.length; exportButton.textContent = '导出 Excel' }
    })()
  })
  const rules = document.getElementById('historyRules')!
  for (const [label, description] of STATISTICS_RULES) {
    const item = node('div', 'history-rule'); item.append(node('dt', '', label), node('dd', '', description)); rules.append(item)
  }
  document.addEventListener('settings-section-changed', () => { if (!page.hidden) void refresh() })
  api.onGiftCatalogStatus(() => { if (!page.hidden && !savingPrice) void refresh() })
  const timer = setInterval(() => { if (!page.hidden && document.visibilityState === 'visible' && !savingPrice) void refresh() }, 4_000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  setRange(7)
  void refresh()
  return { waitForSave: () => savingPrice || Promise.resolve(true) }
}
