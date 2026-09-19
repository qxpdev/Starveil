import { parseDouyuFields } from './protocol'
export { parseDouyuFields } from './protocol'
import { HighEnergyReader, parseHighEnergyEvent } from './highEnergy'
import WebSocket from 'ws'
import { inflateSync } from 'node:zlib'
import type { DouyuGiftKind, GiftCatalogType } from '../shared/types'

const MSG_TYPE_SEND = 689

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function getRandom(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 斗鱼发送分包（对齐小淳 WebSocket_Packet + 常见 dy_encode：双 length + 689 + UTF-8 正文 + 尾 0x00）
 * 首 uint32 = 从第 4 字节到包尾的总字节数（含 duplicate、type、body、尾 0）
 */
export function buildDouyuPacket(text: string): Buffer {
  const msgBytes = Buffer.from(text, 'utf8')
  const dataLen = msgBytes.length + 9
  const total = 4 + dataLen
  const buf = Buffer.alloc(total)
  buf.writeUInt32LE(dataLen, 0)
  buf.writeUInt32LE(dataLen, 4)
  buf.writeUInt32LE(MSG_TYPE_SEND, 8)
  msgBytes.copy(buf, 12)
  buf.writeUInt8(0, 12 + msgBytes.length)
  return buf
}

export function tryParseChatChunk(raw: string): ChatMessage | null {
  const t = raw.replace(/^\uFEFF/, '').replace(/\0+$/, '')
  if (!/(?:^|\/)type@=chatmsg(?:\/|$)/.test(t)) return null
  // 统一解析昵称、正文和用户资料字段。
  return tryParseChat(parseDouyuFields(t))
}

export interface ChatMessage {
  /** 官方高能记录的正文，与普通 dms 过滤规则分开处理。 */
  isHighEnergy?: boolean
  messageId?: string
  roomId?: string
  /** 斗鱼 uid，用于去重统计发言人数。 */
  userId?: string
  nick: string
  text: string
  /** 颜色等级，对应弹幕 `col` 字段 */
  col?: string
  /** 斗鱼 `dms` 字段；缺失时常为机器人等非真人弹幕 */
  dms?: string
  /** 斗鱼 `ic` 字段：头像标识或完整 URL */
  avatar?: string
  /** 斗鱼 `level` 字段：用户等级 */
  level?: string
  /** 斗鱼 `bnn` 字段：粉丝牌名称 */
  fansName?: string
  /** 斗鱼 `bl` 字段：粉丝牌等级 */
  fansLevel?: string
  isDiamond?: boolean
  isNoble?: boolean
  nobleLevel?: number
  isRoomAdmin?: boolean
  isSuper?: boolean
  isVip?: boolean
}

/** 已支持的斗鱼礼物事件类型。普通礼物为 dgb，其余为斗鱼的特殊礼物/升级广播。 */
export const DOUYU_GIFT_MESSAGE_TYPES = [
  'dgb',
  'anbc',
  'rnewbc',
  'blab',
  'fansupgradebroadcast',
  'dfobc',
  'dfrbc'
] as const

const DOUYU_GIFT_MESSAGE_TYPE_SET = new Set<string>(DOUYU_GIFT_MESSAGE_TYPES)

export interface GiftMessage {
  messageId?: string
  userId?: string
  /** 斗鱼 type 字段，便于主进程区分普通礼物与特殊广播。 */
  type: string
  giftKind: DouyuGiftKind
  nick: string
  giftName: string
  giftCount?: number
  giftHits?: number
  giftEffectId?: string
  giftBannerId?: string
  giftSkinId?: string
  giftId?: string
  /** gpf=1 时 giftId 已规范为 pid；不再回退到抽奖道具的 gfid。 */
  giftCatalogType?: GiftCatalogType
  /** 道具广播原始 gfid；需由官方目录确认用途，不能直接当抽奖来源或奖励价格。 */
  sourceGiftId?: string
  /** 旧协议在 gfid 不存在于礼物表时尝试的 pid。 */
  fallbackGiftId?: string
  /** 特殊广播携带的目标房间，用于过滤非本房间消息。 */
  roomId?: string
  giftImage?: string
  avatar?: string
  level?: string
  fansName?: string
  fansLevel?: string
  isDiamond?: boolean
  isNoble?: boolean
  nobleLevel?: number
  isRoomAdmin?: boolean
  isSuper?: boolean
  isVip?: boolean
}

/** uenter 进场消息的最小字段集。 */
export interface EnterMessage {
  userId?: string
  nick: string
  avatar?: string
  level?: string
  nobleLevel?: number
}

/** noble_num_info / oni 贵宾数量。 */
export interface RoomDataMessage {
  type: 'noble_num_info' | 'oni'
  roomId?: string
  nobleCount: number
}

function fieldValue(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields[key]
    if (value != null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function fieldFlag(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no'
}

export function tryParseChat(fields: Record<string, string>): ChatMessage | null {
  if (fields.type !== 'chatmsg') return null
  const nick = fieldValue(fields, 'nn', 'nickname')
  const text = fieldValue(fields, 'txt', 'text')
  const colRaw = fieldValue(fields, 'col')
  const dmsRaw = fieldValue(fields, 'dms')
  if (!text && !nick) return null
  const msg: ChatMessage = { nick, text }
  const messageId = fieldValue(fields, 'cid')
  const roomId = fieldValue(fields, 'rid')
  if (messageId && messageId !== '0') msg.messageId = messageId
  if (roomId) msg.roomId = roomId
  const userId = fieldValue(fields, 'uid')
  if (userId) msg.userId = userId
  if (colRaw) msg.col = colRaw
  if (dmsRaw) msg.dms = dmsRaw
  const avatar = fieldValue(fields, 'ic', 'avatar')
  const level = fieldValue(fields, 'level', 'lv')
  const fansName = fieldValue(fields, 'bnn', 'fansName')
  const fansLevel = fieldValue(fields, 'bl', 'fansLevel')
  if (avatar) msg.avatar = avatar
  if (level) msg.level = level
  if (fansName) msg.fansName = fansName
  if (fansLevel) msg.fansLevel = fansLevel
  msg.isDiamond = fieldFlag(fieldValue(fields, 'diaf', 'isDiamond'))
  const nobleLevel = numericField(fields, 'nl', 'nobleLevel')
  if (nobleLevel !== undefined && nobleLevel > 0) msg.nobleLevel = Math.min(9, nobleLevel)
  msg.isNoble = Boolean(msg.nobleLevel) || fieldFlag(fieldValue(fields, 'nc', 'isNoble'))
  msg.isRoomAdmin = fieldValue(fields, 'rg', 'roomAdmin') === '4'
  msg.isSuper = fieldValue(fields, 'pg', 'isSuper') === '5'
  const ail = fieldValue(fields, 'ail', 'vip')
  msg.isVip = ail.includes('453/') || ail.includes('454/') || fieldFlag(fieldValue(fields, 'isVip'))
  return msg
}

function numericField(fields: Record<string, string>, ...keys: string[]): number | undefined {
  const raw = fieldValue(fields, ...keys)
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.min(1_000_000_000, Math.floor(n))
}

function giftNameForType(fields: Record<string, string>, type: string): string {
  const explicit = fieldValue(fields, 'gfn', 'giftName', 'giftname', 'gn')
  if (explicit) return explicit
  switch (type) {
    case 'dfobc':
      return '开通钻粉'
    case 'dfrbc':
      return '续费钻粉'
    case 'anbc':
      return `开通${nobleName(fieldValue(fields, 'nl'))}`
    case 'rnewbc':
      return `续费${nobleName(fieldValue(fields, 'nl'))}`
    case 'blab':
      return `粉丝牌升到${fieldValue(fields, 'bl', 'level')}级`
    case 'fansupgradebroadcast':
      return `粉丝牌升到${fieldValue(fields, 'otherContent', 'bl', 'level')}级`
    default:
      return fieldValue(fields, 'name') || (fieldValue(fields, 'gfid', 'pid') ? '礼物' : '')
  }
}

const NOBLE_NAMES: Record<string, string> = {
  '1': '骑士',
  '2': '子爵',
  '3': '伯爵',
  '4': '公爵',
  '5': '国王',
  '6': '皇帝',
  '7': '游侠',
  '8': '超级皇帝',
  '9': '幻神'
}

function nobleName(value: string): string {
  return NOBLE_NAMES[value] ?? '贵族'
}

function giftKindForType(type: string, knownGift: boolean): DouyuGiftKind {
  if (type === 'dfobc' || type === 'dfrbc') return 'diamond'
  if (type === 'anbc' || type === 'rnewbc') return 'noble'
  if (type === 'blab' || type === 'fansupgradebroadcast') return 'fans'
  return knownGift ? 'gift' : 'unknown'
}

/** 从已拆分的斗鱼字段解析礼物/特殊广播。 */
export function tryParseGift(fields: Record<string, string>): GiftMessage | null {
  const type = fieldValue(fields, 'type').toLowerCase()
  if (!DOUYU_GIFT_MESSAGE_TYPE_SET.has(type)) return null

  const nick = fieldValue(fields, 'nn', 'nick', 'nickname', 'unk', 'userName', 'username')
  const giftName = giftNameForType(fields, type)
  const flag = fieldValue(fields, 'gpf')
  const giftCatalogType = flag === '1' ? 'prop' : flag === '0' ? 'gift' : undefined
  const primaryId = fieldValue(fields, giftCatalogType === 'prop' ? 'pid' : 'gfid')
  const secondaryId = giftCatalogType ? '' : fieldValue(fields, 'pid')
  // pid=0 与缺少 pid 一样，不能给它补价或回退到投入道具。
  const giftId = primaryId === '0' ? '' : primaryId
  const fallbackGiftId = secondaryId === '0' ? '' : secondaryId
  // dgb 通常一定有 gfn；即使服务端只发 gfid，也保留一条可读的礼物事件。
  if (!giftName && !giftId && !nick) return null

  const msg: GiftMessage = {
    type,
    giftKind: giftKindForType(type, Boolean(giftId || fallbackGiftId)),
    nick,
    giftName: giftName || '礼物'
  }
  const userId = fieldValue(fields, 'uid', 'suid')
  if (userId) msg.userId = userId
  if (giftCatalogType) msg.giftCatalogType = giftCatalogType
  const sourceGiftId = fieldValue(fields, 'gfid')
  if (giftCatalogType === 'prop' && /^\d{1,18}$/.test(sourceGiftId) && sourceGiftId !== '0') msg.sourceGiftId = sourceGiftId
  const messageId = fieldValue(fields, 'cid', 'bcid')
  // 部分广播复用批次 ID；连击序号属于身份的一部分，不能把下一次赠送吃掉。
  if (messageId && messageId !== '0') {
    msg.messageId = [messageId, userId, giftCatalogType || '', giftId, fallbackGiftId, fields.hits || '', fields.gfcnt || ''].join(':')
  }
  const count = numericField(fields, 'gfcnt', 'giftCount', 'count', 'num')
  const hits = numericField(fields, 'hits', 'giftHits')
  if (count !== undefined) msg.giftCount = count
  else if (type === 'dgb') msg.giftCount = 1
  if (hits !== undefined) msg.giftHits = hits
  // 官方 BarrageGroup.handleSendData：eic=effectId，bnidv2=bannerEId，skinid=skinId。
  for (const [field, key] of [['eic', 'giftEffectId'], ['bnidv2', 'giftBannerId'], ['skinid', 'giftSkinId']] as const) {
    const value = fieldValue(fields, field)
    if (/^\d{1,18}$/.test(value)) msg[key] = value
  }
  if (giftId) msg.giftId = giftId
  if (fallbackGiftId && fallbackGiftId !== giftId) msg.fallbackGiftId = fallbackGiftId
  const targetRoomId =
    type === 'anbc' || type === 'rnewbc'
      ? fieldValue(fields, 'drid')
      : fieldValue(fields, 'rid')
  if (targetRoomId) msg.roomId = targetRoomId

  const giftImage = fieldValue(fields, 'gpic', 'giftpic', 'giftImage')
  if (giftImage) msg.giftImage = giftImage
  const avatar = fieldValue(fields, 'ic', 'avatar')
  const level = fieldValue(fields, 'level', 'lv')
  const fansName = fieldValue(fields, 'bnn', 'fansName')
  const fansLevel = fieldValue(fields, 'bl', 'fansLevel')
  if (avatar) msg.avatar = avatar
  if (level) msg.level = level
  if (fansName) msg.fansName = fansName
  if (fansLevel) msg.fansLevel = fansLevel
  msg.isDiamond =
    type === 'dfobc' ||
    type === 'dfrbc' ||
    fieldFlag(fieldValue(fields, 'diaf', 'isDiamond'))
  const nobleLevel = numericField(fields, 'nl', 'nobleLevel')
  if (nobleLevel !== undefined && nobleLevel > 0) msg.nobleLevel = Math.min(9, nobleLevel)
  msg.isNoble = Boolean(msg.nobleLevel) || fieldFlag(fieldValue(fields, 'nc', 'isNoble'))
  msg.isRoomAdmin = fieldValue(fields, 'rg', 'roomAdmin') === '4'
  msg.isSuper = fieldValue(fields, 'pg', 'isSuper') === '5'
  const ail = fieldValue(fields, 'ail', 'vip')
  msg.isVip = ail.includes('453/') || ail.includes('454/') || fieldFlag(fieldValue(fields, 'isVip'))
  return msg
}

/** 从 uenter 事件提取进场资料。 */
export function tryParseEnter(fields: Record<string, string>): EnterMessage | null {
  if (fieldValue(fields, 'type') !== 'uenter') return null
  const nick = fieldValue(fields, 'nn', 'nickname')
  if (!nick) return null
  const result: EnterMessage = { nick }
  const userId = fieldValue(fields, 'uid')
  const avatar = fieldValue(fields, 'ic', 'avatar')
  const level = fieldValue(fields, 'level', 'lv')
  const nobleLevel = numericField(fields, 'nl')
  if (userId) result.userId = userId
  if (avatar) result.avatar = avatar
  if (level) result.level = level
  if (nobleLevel !== undefined && nobleLevel > 0) result.nobleLevel = Math.min(9, nobleLevel)
  return result
}

/** 从数据消息提取贵宾数。 */
export function tryParseRoomData(fields: Record<string, string>): RoomDataMessage | null {
  const type = fieldValue(fields, 'type')
  if (type !== 'noble_num_info' && type !== 'oni') return null
  const nobleCount = numericField(fields, 'vn')
  if (nobleCount === undefined) return null
  const roomId = fieldValue(fields, 'rid')
  return {
    type,
    ...(roomId ? { roomId } : {}),
    nobleCount
  }
}

/** 兼容单个原始文本块（含 type@=…/ 字段）。 */
export function tryParseGiftChunk(raw: string): GiftMessage | null {
  const t = raw.replace(/^\uFEFF/, '').replace(/\0+$/, '')
  if (!/(?:^|\/)type@=[^/]+(?:\/|$)/i.test(t)) return null
  return tryParseGift(parseDouyuFields(t))
}

export function parseLoginRes(
  fields: Record<string, string>
): { ok: boolean; detail: string } | null {
  if ((fields.type ?? '').trim() !== 'loginres') return null
  const ret = (fields.ret ?? fields.res ?? '').trim()
  const rid = fields.roomid ?? fields.rid ?? ''
  const tail = [ret && `ret=${ret}`, rid && `roomid=${rid}`].filter(Boolean).join(' ')
  if (!ret) return { ok: true, detail: tail || 'loginres(无 ret 字段)' }
  const lower = ret.toLowerCase()
  if (lower === 'ok' || ret === '0') return { ok: true, detail: tail }
  if (lower === 'fail' || ret === '1') return { ok: false, detail: tail || '登录被拒绝' }
  return { ok: true, detail: tail }
}

export interface DouyuWsClientOptions {
  roomId: string
  onChat: (msg: ChatMessage) => void
  onGift?: (msg: GiftMessage) => void
  onEnter?: (msg: EnterMessage) => void
  onRoomData?: (msg: RoomDataMessage) => void
  onError?: (err: Error) => void
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void
  onLoginRes?: (ok: boolean, detail: string) => void
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data as ArrayBuffer)
}

function maybeDecompress(body: Buffer): string {
  if (body.length >= 2 && body[0] === 0x78 && (body[1] === 0x9c || body[1] === 0x01 || body[1] === 0xda)) {
    try {
      return inflateSync(body).toString('utf8')
    } catch {
      /* fallthrough */
    }
  }
  return body.toString('utf8')
}

/**
 * 斗鱼弹幕 WebSocket（未登录代理），对齐小淳 Ex_WebSocket_UnLogin + 二进制分包解析。
 */
export class DouyuWsClient {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectCount = 0
  private readonly maxReconnect = 12
  private destroyed = false
  private recvBuf = Buffer.alloc(0)
  private highEnergy: HighEnergyReader | null = null

  constructor(private readonly options: DouyuWsClientOptions) {}

  start(): void {
    this.highEnergy?.stop()
    this.highEnergy = new HighEnergyReader(this.options.onChat, fetch, error => console.warn('[douyu-high-energy]', error.message))
    this.destroyed = false
    this.recvBuf = Buffer.alloc(0)
    this.connect()
  }

  private dispatchTextPayload(text: string): void {
    const chunks = text.split('\0')
    for (const chunk of chunks) {
      const c = chunk.replace(/^\uFEFF/, '')
      if (c.length <= 12) continue
      const fields = parseDouyuFields(c)
      const login = parseLoginRes(fields)
      if (login) {
        this.options.onLoginRes?.(login.ok, login.detail)
        continue
      }
      const highEnergy = parseHighEnergyEvent(fields, this.options.roomId)
      if (highEnergy) { this.highEnergy?.accept(highEnergy); continue }
      const gift = tryParseGift(fields)
      if (gift) {
        this.options.onGift?.(gift)
        continue
      }
      const chat = tryParseChatChunk(c) ?? tryParseChat(fields)
      if (chat) {
        this.options.onChat(chat)
        continue
      }
      const enter = tryParseEnter(fields)
      if (enter) {
        this.options.onEnter?.(enter)
        continue
      }
      const roomData = tryParseRoomData(fields)
      if (roomData) this.options.onRoomData?.(roomData)
    }
  }

  /**
   * 下行：首 uint32 为「从第 4 字节到包尾」长度，总包长 = 4 + 该值（与 dy_encode 一致）
   */
  private feedBinary(buf: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, buf])
    const MAX = 2 * 1024 * 1024
    while (this.recvBuf.length >= 4) {
      const L = this.recvBuf.readUInt32LE(0)
      if (L < 9 || L > MAX) {
        const asText = this.recvBuf.toString('utf8')
        if (asText.includes('type@=')) {
          this.dispatchTextPayload(asText)
        }
        this.recvBuf = Buffer.alloc(0)
        return
      }
      const total = 4 + L
      if (this.recvBuf.length < total) return
      const packet = this.recvBuf.subarray(0, total)
      this.recvBuf = this.recvBuf.subarray(total)
      if (packet.length < 13) continue
      let body = packet.subarray(12, packet.length)
      while (body.length && body[body.length - 1] === 0) {
        body = body.subarray(0, body.length - 1)
      }
      let text = body.toString('utf8')
      if (!/type@=/i.test(text) && body.length > 8) {
        const inflated = maybeDecompress(body)
        if (/type@=/i.test(inflated)) text = inflated
      }
      if (text.length) this.dispatchTextPayload(text)
    }
  }

  /** 拆掉当前 socket 且不再触发其 close 里的重连（保证全局最多一条 WS） */
  private disposeWebSocketSilently(): void {
    this.clearTimer()
    const old = this.ws
    this.ws = null
    if (!old) return
    old.removeAllListeners()
    // CONNECTING 时 close() 会走 ws 内部 abortHandshake，并在 nextTick 上 emit('error')；
    // removeAllListeners 已去掉所有监听，若不先挂回吸收，会触发主进程未捕获异常（如拖动设置项触发 refreshSources -> stop）。
    const swallowHandshakeAbort = (): void => {}
    old.once('error', swallowHandshakeAbort)
    try {
      old.close()
    } catch {
      /* ignore */
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private connect(): void {
    if (this.destroyed) return
    this.clearReconnectTimer()
    this.recvBuf = Buffer.alloc(0)
    this.disposeWebSocketSilently()

    this.options.onStatus?.('connecting')
    const port = 8500 + getRandom(2, 5)
    const url = `wss://danmuproxy.douyu.com:${port}`
    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      headers: {
        'User-Agent': CHROME_UA,
        Origin: 'https://www.douyu.com',
        Referer: 'https://www.douyu.com/'
      }
    })
    this.ws = ws

    ws.on('open', () => {
      this.reconnectCount = 0
      this.options.onStatus?.('open')
      const rid = this.options.roomId
      ws.send(buildDouyuPacket(`type@=loginreq/roomid@=${rid}/`))
      ws.send(buildDouyuPacket(`type@=joingroup/rid@=${rid}/gid@=-9999/`))
      this.timer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(buildDouyuPacket('type@=mrkl/'))
        }
      }, 40_000)
    })

    ws.on('message', (data: WebSocket.RawData) => {
      const b = rawDataToBuffer(data)
      this.feedBinary(b)
    })

    ws.on('error', (err) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.closeSocketOnly()
    })

    ws.on('close', () => {
      this.clearTimer()
      this.options.onStatus?.('closed')
      if (!this.destroyed) this.scheduleReconnect()
    })
  }

  private closeSocketOnly(): void {
    this.clearTimer()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.reconnectCount >= this.maxReconnect) {
      return
    }
    this.reconnectCount++
    const delay = Math.min(3000 * Math.pow(1.5, this.reconnectCount - 1), 60_000)
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  stop(): void {
    this.highEnergy?.stop()
    this.highEnergy = null
    this.destroyed = true
    this.recvBuf = Buffer.alloc(0)
    this.clearReconnectTimer()
    this.disposeWebSocketSilently()
  }
}
