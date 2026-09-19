import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { ConfigStore, parseConfigFile } from '../src/main/configStore'
import { SessionStats } from '../src/main/sessionStats'
import { DEFAULT_CONFIG, mergeConfig } from '../src/shared/config'
import { DouyuWsClient, buildDouyuPacket, parseDouyuFields, tryParseChat, tryParseGift } from '../src/douyu/client'
import { giftCatalogFromList, mergeSettledCatalogs, isKnownFreeGiftName, addRequestedGiftIds, propMetadataFromResponse, fetchDouyuPropCatalog, dreamBusGiftReferences, lotteryCatalogFromResponse, type DouyuGiftMeta } from '../src/douyu/roomInfo'
import { giftCatalogKey, resolveGiftMetadata } from '../src/shared/giftMetadata'
import { clampOverlayBounds, clampAndSnapOverlayBounds, defaultOverlayBounds, remapOverlayBounds } from '../src/shared/overlayGeometry'
import { hexToHsv, hsvToHex, normalizeHexColor } from '../src/shared/color'
import { parseManualGiftPrice, normalizeManualGiftPrices } from '../src/shared/manualGiftPrices'
import { withManualGiftPrices, listGiftPricing } from '../src/main/giftPricing'
import { acquireInstanceGuard, instanceEndpoint } from '../src/main/singleInstance'
import { chatExclusionReason } from '../src/shared/chatPolicy'
import { StatisticsStore } from '../src/main/statisticsStore'
import { createStatisticsWorkbook, exportStatisticsWorkbook } from '../src/main/statisticsExport'
import { localDateKey, normalizeStatisticsQuery } from '../src/shared/statistics'
import { GiftPresentationStore, LOTTERY_JOIN_MS, LOTTERY_REWARD_WAIT_MS } from '../src/shared/giftPresentation'
import { advanceFlowMotion, incomingBatchSize, retargetFlowMotion } from '../src/shared/motion'
import { giftValueTier } from '../src/shared/giftAppearance'
import type { DanmakuPayload } from '../src/shared/types'

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'douyu-case-'))
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function meta(id: string, priceYuan: number | null, name = '测试礼物', isFree = false): DouyuGiftMeta {
  return { id, name, priceYuan, image: '', isFree }
}

function gift(id = 'g1', count = 3, event = 'event-1') {
  return { type: 'dgb', userId: '123', messageId: event, giftKind: 'gift' as const,
    giftId: id, giftName: '测试礼物', giftCount: count, giftHits: 999, nick: '观众' }
}

test('设置在重建存储实例后保留，包括零字距、禁用开关和新字体选项', (t) => {
  const dir = directory(t)
  const cfg = mergeConfig({ roomId: '24422', fontSize: 56, avatarSize: 64, letterSpacing: 0,
    lineHeight: 1.8, lanePadding: 0, showFreeGifts: false, overlayAlwaysOnTop: false,
    markedTimeSec: 7, statusAlwaysVisible: false })
  new ConfigStore(dir).save(cfg)
  assert.deepEqual(new ConfigStore(dir).load(), cfg)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).fontSize, 56)
})

test('损坏的主配置从上一份有效备份恢复，不静默归零', (t) => {
  const dir = directory(t)
  const store = new ConfigStore(dir)
  store.save(mergeConfig({ fontSize: 32 }))
  store.save(mergeConfig({ fontSize: 48 }))
  writeFileSync(store.filePath, '{"fontSize":')
  const recovered = new ConfigStore(dir)
  assert.equal(recovered.load().fontSize, 32)
  assert.match(recovered.info.notice || '', /备份/)
  assert.equal(JSON.parse(readFileSync(store.filePath, 'utf8')).fontSize, 32)
})

test('升级导入旧配置后移动 EXE 不再依赖旧目录，原文件保留', (t) => {
  const dir = directory(t)
  const old = join(dir, 'old.json')
  writeFileSync(old, JSON.stringify({ fontSize: 37, letterSpacing: 2 }))
  const target = join(dir, 'account')
  assert.equal(new ConfigStore(target, [old]).load().fontSize, 37)
  assert.ok(existsSync(old))
  assert.equal(new ConfigStore(target, [join(dir, 'moved-exe', 'config.json')]).load().fontSize, 37)
})

test('配置写入失败时仍保留已保存设置，错误明确返回', (t) => {
  const dir = directory(t)
  const store = new ConfigStore(dir)
  store.save(mergeConfig({ fontSize: 31 }))
  rmSync(`${store.filePath}.bak`)
  mkdirSync(`${store.filePath}.bak`)
  assert.throws(() => store.save(mergeConfig({ fontSize: 70 })), /设置未保存/)
  assert.equal(new ConfigStore(dir).load().fontSize, 31)
  assert.match(store.info.notice || '', /未保存/)
})

test('不可用的数据目录不会虚报保存成功', (t) => {
  const file = join(directory(t), 'not-a-directory')
  writeFileSync(file, 'occupied')
  assert.throws(() => new ConfigStore(file).save(mergeConfig(undefined)), /设置未保存/)
})

test('拒绝损坏配置结构，兼容 BOM 和旧版字段', () => {
  assert.throws(() => parseConfigFile('null'))
  assert.throws(() => parseConfigFile('[]'))
  assert.equal(parseConfigFile('\uFEFF{"fontSize":32}').fontSize, 32)
  assert.equal(mergeConfig({ fontSize: 200, avatarSize: 0, lineHeight: 0 }).fontSize, 96)
  assert.equal(mergeConfig({ lineHeight: 0 }).lineHeight, 1)
})

test('旧高亮分钟值升级为秒，保存重开不会重复换算或丢失常驻开关', (t) => {
  const dir = directory(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ overlayEnabled: false, markedTimeMin: 5 }))
  const store = new ConfigStore(dir)
  const migrated = store.load()
  assert.equal(migrated.markedTimeSec, 300)
  assert.equal(migrated.statusAlwaysVisible, true)
  assert.equal('markedTimeMin' in migrated, false)
  store.save(migrated)
  assert.equal(new ConfigStore(dir).load().markedTimeSec, 300)
  store.save(mergeConfig({ ...migrated, markedTimeSec: 7, statusAlwaysVisible: false }))
  const reloaded = new ConfigStore(dir).load()
  assert.equal(reloaded.markedTimeSec, 7)
  assert.equal(reloaded.statusAlwaysVisible, false)
  assert.equal('markedTimeMin' in JSON.parse(readFileSync(store.filePath, 'utf8')), false)
})

test('秒字段优先于旧分钟字段，零时长仍不限时，非法时长有边界', () => {
  assert.equal(mergeConfig({ markedTimeMin: 0 }).markedTimeSec, 0)
  assert.equal(mergeConfig({ markedTimeMin: '2' }).markedTimeSec, 120)
  assert.equal(mergeConfig({ markedTimeSec: 0, markedTimeMin: 5 }).markedTimeSec, 0)
  assert.equal(mergeConfig({ markedTimeSec: 7, markedTimeMin: 5 }).markedTimeSec, 7)
  assert.equal(mergeConfig({ markedTimeMin: 'invalid' }).markedTimeSec, DEFAULT_CONFIG.markedTimeSec)
  assert.equal(mergeConfig({ markedTimeSec: -1 }).markedTimeSec, 0)
  assert.equal(mergeConfig({ markedTimeSec: 10_000 }).markedTimeSec, 1_800)
})

test('弹幕按事件 ID 去重，重复正文不漏计，同一 UID 换昵称不增加人数', () => {
  const stats = new SessionStats()
  stats.begin('live:24422')
  for (const message of [{ messageId: 'a', userId: '1' }, { messageId: 'a', userId: '1' },
    { messageId: 'b', userId: '1' }, { messageId: 'c', userId: '2' }]) stats.recordChat(message)
  assert.equal(stats.snapshot().danmakuCount, 3)
  assert.equal(stats.snapshot().danmakuUsers, 2)
})

test('缺失 UID 不伪造一个共同观众，缺失消息 ID 的独立事件仍逐条计数', () => {
  const stats = new SessionStats()
  stats.recordChat({})
  stats.recordChat({ userId: '0' })
  stats.recordChat({ userId: '12' })
  stats.recordChat({ userId: '12' })
  assert.equal(stats.snapshot().danmakuCount, 4)
  assert.equal(stats.snapshot().danmakuUsers, 1)
  assert.equal(stats.snapshot().unidentifiedChatCount, 2)
})

test('重连同房间不重置统计，切换房间和模拟模式隔离统计', () => {
  const stats = new SessionStats()
  stats.begin('live:24422')
  stats.recordChat({ userId: '1', messageId: 'x' })
  assert.equal(stats.begin('live:24422'), false)
  assert.equal(stats.snapshot().danmakuCount, 1)
  stats.begin('live:5232')
  assert.equal(stats.snapshot().danmakuCount, 0)
  stats.begin('simulate')
  assert.equal(stats.snapshot().source, 'simulate')
})

test('未知礼物先计数量，目录补齐后自动补金额且不再增加数量', () => {
  const stats = new SessionStats()
  stats.recordGift(gift())
  assert.equal(stats.snapshot().giftCount, 3)
  assert.equal(stats.snapshot().unknownGiftCount, 3)
  stats.updateCatalog(new Map([['g1', meta('g1', 10.25)]]))
  assert.equal(stats.snapshot().giftValue, 30.75)
  assert.equal(stats.snapshot().unknownGiftCount, 0)
  stats.updateCatalog(new Map([['g1', meta('g1', 10.25)]]))
  assert.equal(stats.snapshot().giftCount, 3)
  assert.equal(stats.snapshot().giftValue, 30.75)
})

test('免费礼物计件不计金额，连击 hits 不乘入数量，重复广播只计一次', () => {
  const stats = new SessionStats()
  stats.updateCatalog(new Map([['g1', meta('g1', 0.1, '粉丝荧光棒', true)], ['g2', meta('g2', 2000)]]))
  stats.recordGift(gift('g1', 200, 'free'))
  stats.recordGift(gift('g2', 2, 'paid'))
  stats.recordGift(gift('g2', 2, 'paid'))
  assert.equal(stats.snapshot().giftCount, 202)
  assert.equal(stats.snapshot().giftValue, 4000)
})

test('礼物的每一分钱保留，金额大于 100 元也不舍弃小数', () => {
  const stats = new SessionStats()
  stats.updateCatalog(new Map([['g1', meta('g1', 0.1)]]))
  for (let i = 0; i < 1234; i++) stats.recordGift(gift('g1', 1, String(i)))
  assert.equal(stats.snapshot().giftValue, 123.4)
})

test('活动缺价不能覆盖正式价格，正式付费价格能纠正旧目录的零价', () => {
  const maps = [new Map([['g1', meta('g1', 0, '礼物', true)]]),
    new Map([['g1', meta('g1', 99.99)]]), new Map([['g1', meta('g1', null)]])]
  const merged = mergeSettledCatalogs(maps.map((value) => ({ status: 'fulfilled' as const, value })))
  assert.equal(merged.get('g1')?.priceYuan, 99.99)
  assert.equal(merged.get('g1')?.isFree, false)
  assert.equal(giftCatalogFromList([{ id: 'x', name: '新礼物' }]).get('x')?.priceYuan, null)
  assert.equal(giftCatalogFromList([{ id: 'x', name: '新礼物' }]).get('x')?.isFree, false)
  assert.equal(isKnownFreeGiftName('赞助火箭'), false)
  assert.equal(isKnownFreeGiftName('赞'), true)
  assert.equal(isKnownFreeGiftName('100鱼丸'), true)
})

test('礼物备用 ID 可补价，刷新缺价不抹除已确认金额', () => {
  const stats = new SessionStats()
  stats.recordGift({ ...gift('missing'), fallbackGiftId: 'base' })
  stats.updateCatalog(new Map([['base', meta('base', 5)]]))
  stats.updateCatalog(new Map([['base', meta('base', null)]]))
  assert.equal(stats.snapshot().giftValue, 15)
})

test('协议保留房间与事件身份，下一次连击仍是独立礼物事件', () => {
  const a = tryParseGift(parseDouyuFields('type@=dgb/rid@=24422/uid@=7/gfid@=1/gfcnt@=3/hits@=3/bcid@=batch/nn@=观众/'))!
  const b = tryParseGift(parseDouyuFields('type@=dgb/rid@=24422/uid@=7/gfid@=1/gfcnt@=3/hits@=6/bcid@=batch/nn@=观众/'))!
  assert.equal(a.roomId, '24422')
  assert.equal(a.userId, '7')
  assert.notEqual(a.messageId, b.messageId)
  const chat = tryParseChat(parseDouyuFields('type@=chatmsg/rid@=24422/uid@=7/cid@=123/nn@=观众/txt@=你好@S世界/'))!
  assert.equal(chat.messageId, '123')
  assert.equal(chat.text, '你好/世界')
})

test('二进制分片、粘包、压缩包和重复包的协议计数一致', () => {
  const stats = new SessionStats()
  const client = new DouyuWsClient({ roomId: '24422', onChat: (m) => { stats.recordChat(m) }, onGift: (g) => { stats.recordGift(g) } })
  const text = 'type@=chatmsg/rid@=24422/uid@=7/cid@=chat-1/nn@=观众/txt@=中文弹幕/'
  const payload = deflateSync(Buffer.from(text + '\0'))
  const compressed = Buffer.alloc(payload.length + 12)
  compressed.writeUInt32LE(payload.length + 8, 0)
  compressed.writeUInt32LE(payload.length + 8, 4)
  compressed.writeUInt32LE(690, 8)
  payload.copy(compressed, 12)
  const frames = Buffer.concat([buildDouyuPacket(text), compressed,
    buildDouyuPacket('type@=dgb/rid@=24422/uid@=7/bcid@=gift-1/gfid@=g1/gfcnt@=4/hits@=500/nn@=观众/')])
  const feed = (client as unknown as { feedBinary: (b: Buffer) => void }).feedBinary.bind(client)
  feed(frames.subarray(0, 5))
  feed(frames.subarray(5, 27))
  feed(frames.subarray(27))
  assert.equal(stats.snapshot().danmakuCount, 1)
  assert.equal(stats.snapshot().danmakuUsers, 1)
  assert.equal(stats.snapshot().giftCount, 4)
})

test('1080p、2K、4K 与 100/150/200% 缩放均在逻辑工作区内，尺寸不重复乘 DPI', () => {
  for (const [width, height, scale] of [[1920, 1080, 1], [2560, 1440, 1], [2560, 1440, 1.5], [3840, 2160, 1.5], [3840, 2160, 2]]) {
    const area = { x: 0, y: 0, width: Math.round(width / scale), height: Math.round(height / scale) - 30 }
    const bounds = defaultOverlayBounds(area)
    assert.equal(bounds.width, 360)
    assert.equal(bounds.x + bounds.width, area.width)
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= area.height)
  }
})

test('任务栏出现/隐藏与屏幕分辨率切换保持右下贴边', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1050 }
  const full = { ...work, height: 1080 }
  const bounds = { x: 1560, y: 410, width: 360, height: 640 }
  const fullscreen = remapOverlayBounds(bounds, work, full)
  assert.equal(fullscreen.y + fullscreen.height, 1080)
  assert.deepEqual(remapOverlayBounds(fullscreen, full, work), bounds)
  const fourK = remapOverlayBounds(bounds, work, { x: 0, y: 0, width: 3840, height: 2130 })
  assert.equal(fourK.x + fourK.width, 3840)
  assert.equal(fourK.y + fourK.height, 2130)
})

test('副屏负坐标、越界缩放和四边吸附都约束到对应屏幕', () => {
  const area = { x: -2560, y: -100, width: 2560, height: 1400 }
  const corrected = clampAndSnapOverlayBounds({ x: -9000, y: -9000, width: 8000, height: 8000 }, area)
  assert.deepEqual(corrected, area)
  assert.deepEqual(clampAndSnapOverlayBounds({ x: -2556, y: -96, width: 360, height: 640 }, area), { x: -2560, y: -100, width: 360, height: 640 })
})

test('拖动时靠近边缘仍然自由跟手，松手后只在 6px 范围吸附', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1050 }
  const near = { x: 5, y: 7, width: 360, height: 640 }
  assert.deepEqual(clampOverlayBounds(near, area), near)
  assert.deepEqual(clampAndSnapOverlayBounds(near, area), { ...near, x: 0 })
  const outsideMagnet = { ...near, x: 15 }
  assert.deepEqual(clampAndSnapOverlayBounds(outsideMagnet, area), outsideMagnet)
  assert.deepEqual(remapOverlayBounds(near, area, area), near)
})

test('颜色选择器往返转换不改变颜色，非法输入不变成黑色', () => {
  for (const color of ['#ffffff', '#000000', '#56e3f9', '#f7b500', '#087f83', '#010203', '#fdfeff', '#ff0000']) {
    assert.equal(hsvToHex(hexToHsv(color)), color)
  }
  assert.equal(normalizeHexColor(' #AbC '), '#aabbcc')
  assert.equal(normalizeHexColor('xyz'), null)
  assert.equal(normalizeHexColor('#12345'), null)
})

test('旧配置的字符串开关、透明度和模拟间隔统一校验', () => {
  const config = parseConfigFile(JSON.stringify({ overlayEnabled: 'false', simulateDanmaku: 'off', filterRobotDanmaku: 'false', opacity: 'invalid', simulateIntervalMs: 'invalid', overlayEdgeSnap: 'false' }))
  assert.equal(config.overlayEnabled, false)
  assert.equal(config.simulateDanmaku, false)
  assert.equal(config.filterRobotDanmaku, false)
  assert.equal(config.overlayEdgeSnap, false)
  assert.equal(config.opacity, 1)
  assert.equal(config.simulateIntervalMs, DEFAULT_CONFIG.simulateIntervalMs)
  assert.equal(mergeConfig({ simulateIntervalMs: 0, opacity: 9 }).simulateIntervalMs, 200)
  assert.equal(mergeConfig({ opacity: 9 }).opacity, 1)
})

test('新礼物只按实际 ID 动态补查，去重并拒绝协议分隔符注入', () => {
  assert.equal(addRequestedGiftIds('room-gifts--', []), 'room-gifts--')
  assert.equal(addRequestedGiftIds('room-gifts--', ['90001', '90001', '90002', 'x-123', '', '2_3']), 'room-gifts-90001_90002-')
  assert.equal(addRequestedGiftIds('room-gifts--', Array.from({ length: 250 }, (_, index) => String(index))).split('_').length, 200)
})

test('未知礼物手动补价重算已收数量，修改和清除后同步重算，数量不重复增加', () => {
  const stats = new SessionStats()
  stats.recordGift(gift('990001', 3, 'a'))
  stats.recordGift(gift('990001', 2, 'b'))
  assert.equal(stats.snapshot().unknownGiftCount, 5)
  assert.equal(listGiftPricing(new Map(), {}, stats.getGiftBuckets())[0]?.count, 5)
  const manual = { '990001': { name: '活动礼物', priceYuan: 6.66 } }
  const patched = withManualGiftPrices(new Map(), manual)
  stats.updateCatalog(patched, true)
  assert.equal(stats.snapshot().giftCount, 5)
  assert.equal(stats.snapshot().giftValue, 33.3)
  assert.equal(stats.snapshot().unknownGiftCount, 0)
  assert.equal(listGiftPricing(patched, manual, stats.getGiftBuckets())[0]?.source, 'manual')
  stats.updateCatalog(withManualGiftPrices(new Map(), { '990001': { name: '活动礼物', priceYuan: 10 } }), true)
  assert.equal(stats.snapshot().giftValue, 50)
  stats.updateCatalog(withManualGiftPrices(new Map(), {}), true)
  assert.equal(stats.snapshot().giftValue, 0)
  assert.equal(stats.snapshot().unknownGiftCount, 5)
  assert.equal(stats.snapshot().giftCount, 5)
})

test('平台正式价格及备用 ID 优先于手动补价，免费礼物不被手动金额覆盖', () => {
  const manual = { '990001': { name: '新礼物', priceYuan: 99 }, '824': { name: '粉丝荧光棒', priceYuan: 5 } }
  const platform = new Map([['990001', meta('990001', 12)], ['824', meta('824', .1, '粉丝荧光棒', true)]])
  const result = withManualGiftPrices(platform, manual)
  assert.equal(result.get('990001')?.priceYuan, 12)
  assert.equal(result.get('824')?.isFree, true)
  const stats = new SessionStats()
  stats.recordGift({ ...gift('unknown', 2), fallbackGiftId: '990001' })
  stats.updateCatalog(new Map([...result, ['unknown', { ...meta('unknown', 88), priceSource: 'manual' as const }]]), true)
  assert.equal(stats.snapshot().giftValue, 24)
})

test('手动补价独立持久化，拒绝空白、负数、超额、非法 ID 与过多小数', t => {
  const prices = { '990001': { name: '新礼物', priceYuan: 6.66 }, '990002': { name: '免费', priceYuan: 0 } }
  const store = new ConfigStore(directory(t))
  store.save(mergeConfig({ manualGiftPrices: prices }))
  assert.deepEqual(store.load().manualGiftPrices, prices)
  for (const value of ['', ' ', null, undefined, -1, 'NaN', '1.999', 1000001]) assert.equal(parseManualGiftPrice(value), null)
  assert.equal(parseManualGiftPrice('0'), 0)
  assert.deepEqual(normalizeManualGiftPrices({ bad: { priceYuan: 1 }, '12': { priceYuan: '' } }), {})
})

// 目录字段取自 2026-09-06 官方 prop/v5/web/single；广播为按官方 gpf/pid 规则构造的回放。
function propResponse(id: string, price: number, name = '破局挣缚') {
  return { error: 0, data: { id: Number(id), name, price, priceType: 2, isValuable: 1,
    devote: price / 10, intimate: price / 10, picUrlPrefix: 'https://gfs-op.douyucdn.cn/dygift',
    focusPic: [{ src: '/test/reward.gif', type: 'image/gif' }] } }
}

function propGift(id: string, count: number, batch: string, gfid = '24346') {
  return tryParseGift(parseDouyuFields(`type@=dgb/rid@=11921577/uid@=7/gpf@=1/gfid@=${gfid}/pid@=${id}/gfcnt@=${count}/hits@=20/bcid@=${batch}/nn@=观众/`))!
}

test('奖励按 gpf=1 的 pid 查价，不使用有价的主礼物 gfid，且缺 pid 不猜中奖结果', () => {
  const parsed = propGift('3385', 2, 'draw-1')
  assert.equal(parsed.giftCatalogType, 'prop')
  assert.equal(parsed.giftId, '3385')
  assert.equal(parsed.fallbackGiftId, undefined)
  assert.equal(parsed.sourceGiftId, '24346')
  assert.equal(parsed.giftCount, 2)
  const catalog = new Map([['24346', meta('24346', .5)], ['3385', meta('3385', 999)]])
  assert.equal(resolveGiftMetadata(parsed, catalog), undefined)
  const missing = tryParseGift(parseDouyuFields('type@=dgb/gpf@=1/gfid@=24346/gfcnt@=1/nn@=观众/'))!
  assert.equal(missing.giftId, undefined)
  assert.equal(resolveGiftMetadata(missing, catalog), undefined)
  const zero = propGift('0', 1, 'missing-pid')
  assert.equal(zero.giftId, undefined)
  assert.equal(zero.fallbackGiftId, undefined)
  assert.equal(resolveGiftMetadata(zero, catalog), undefined)
})

test('官方道具价格按分换元，贡献值和奖池展示值不能当人民币，免费占位价归零', () => {
  const paid = propMetadataFromResponse(propResponse('3385', 10000), '3385')!
  assert.equal(paid.priceYuan, 100)
  assert.equal(paid.catalogType, 'prop')
  assert.equal(paid.image, 'https://gfs-op.douyucdn.cn/dygift/test/reward.gif')
  const free = propResponse('268', 10, '粉丝荧光棒')
  free.data.isValuable = 0
  assert.equal(propMetadataFromResponse(free)?.priceYuan, 0)
  assert.equal(propMetadataFromResponse(free)?.isFree, true)
  assert.equal(propMetadataFromResponse({ error: 0, data: JSON.stringify(propResponse('3385', 10000).data) })?.priceYuan, 100)
})

test('抽奖投入不重复计数计价，只累计实际奖励；相同批次不同奖励与重复结果分开处理', () => {
  const stats = new SessionStats()
  const base = giftCatalogFromList([{ id: 24346, name: '无字经书', basicInfo: { giftType: 17 }, priceInfo: { price: 50 } }])
  const reward = propMetadataFromResponse(propResponse('3385', 10000))!
  const small = propMetadataFromResponse(propResponse('3382', 10, '捆仙索'))!
  const catalog = new Map([...base, ['prop:3385', reward] as const, ['prop:3382', small] as const])
  stats.updateCatalog(catalog)
  stats.recordGift(tryParseGift(parseDouyuFields('type@=dgb/gpf@=0/gfid@=24346/gfcnt@=20/bcid@=input/nn@=观众/'))!)
  assert.equal(stats.snapshot().giftCount, 0)
  assert.equal(stats.snapshot().giftValue, 0)
  assert.equal(stats.snapshot().unknownGiftCount, 0)
  const a = propGift('3385', 2, 'same-batch')
  const b = propGift('3382', 2, 'same-batch')
  assert.notEqual(a.messageId, b.messageId)
  stats.recordGift(a)
  stats.recordGift(a)
  stats.recordGift(b)
  assert.equal(stats.snapshot().giftCount, 4)
  assert.equal(stats.snapshot().giftValue, 200.2)
  assert.deepEqual(listGiftPricing(catalog, {}, stats.getGiftBuckets()), [])
})

test('正式目录补齐抽奖类型后撤销临时待确认数量，旧背包价和手动价都不能覆盖抽奖类型', () => {
  const stats = new SessionStats()
  stats.recordGift({ ...gift('24346', 20), giftCatalogType: 'gift' })
  assert.equal(stats.snapshot().unknownGiftCount, 20)
  const base = giftCatalogFromList([{ id: 24346, name: '无字经书', basicInfo: { giftType: 17 }, priceInfo: { price: 50 } }])
  const catalogs = mergeSettledCatalogs([new Map([['24346', meta('24346', .5)]]), base].map(value => ({ status: 'fulfilled', value })))
  const effective = withManualGiftPrices(catalogs, { '24346': { name: '无字经书', priceYuan: 999 } })
  assert.equal(effective.get('24346')?.isLottery, true)
  assert.equal(effective.get('24346')?.priceYuan, null)
  stats.updateCatalog(effective)
  assert.equal(stats.snapshot().giftCount, 0)
  assert.equal(stats.snapshot().giftValue, 0)
  assert.equal(stats.snapshot().unknownGiftCount, 0)
})

test('新奖品缺价先记实际数量，按新 pid 补目录后回填金额，不覆盖上期奖品', () => {
  const stats = new SessionStats()
  stats.updateCatalog(new Map([['prop:3385', propMetadataFromResponse(propResponse('3385', 10000))!]]))
  stats.recordGift(propGift('3385', 2, 'previous'))
  stats.recordGift(propGift('990099', 3, 'new'))
  assert.equal(stats.snapshot().giftCount, 5)
  assert.equal(stats.snapshot().giftValue, 200)
  assert.equal(stats.snapshot().unknownGiftCount, 3)
  stats.updateCatalog(new Map([['prop:990099', propMetadataFromResponse(propResponse('990099', 600, '新一期奖励'))!]]))
  assert.equal(stats.snapshot().giftValue, 218)
  assert.equal(stats.snapshot().unknownGiftCount, 0)
  assert.equal(stats.snapshot().giftCount, 5)
})

test('同号普通礼物与道具分开统计和持久化补价，平台道具价格只替换对应补价', t => {
  const stats = new SessionStats()
  stats.recordGift({ ...gift('3385', 1, 'ordinary'), giftCatalogType: 'gift' })
  stats.recordGift(propGift('3385', 2, 'reward'))
  const manual = { '3385': { name: '普通礼物', priceYuan: 5 }, 'prop:3385': { name: '抽奖奖励', priceYuan: 100 } }
  const store = new ConfigStore(directory(t))
  store.save(mergeConfig({ manualGiftPrices: manual }))
  assert.deepEqual(store.load().manualGiftPrices, manual)
  const effective = withManualGiftPrices(new Map(), manual)
  stats.updateCatalog(effective, true)
  assert.equal(stats.snapshot().giftValue, 205)
  const pricing = listGiftPricing(effective, manual, stats.getGiftBuckets())
  assert.equal(pricing.length, 2)
  assert.equal(pricing.find(item => item.catalogType === 'prop')?.count, 2)
  const corrected = withManualGiftPrices(new Map([['prop:3385', propMetadataFromResponse(propResponse('3385', 12000))!]]), manual)
  stats.updateCatalog(corrected, true)
  assert.equal(stats.snapshot().giftValue, 245)
  stats.updateCatalog(withManualGiftPrices(new Map(), { '3385': manual['3385'] }), true)
  assert.equal(stats.snapshot().giftValue, 5)
  assert.equal(stats.snapshot().unknownGiftCount, 2)
  assert.equal(giftCatalogKey('3385', 'prop'), 'prop:3385')
  assert.deepEqual(normalizeManualGiftPrices({ '0': { priceYuan: 5 }, 'prop:0': { priceYuan: 100 } }), {})
})

test('道具接口错误、ID 不符和无法识别的币种均不伪造价格，未知不等于免费', () => {
  assert.equal(propMetadataFromResponse({ error: 1, data: propResponse('3385', 10000).data }), undefined)
  assert.equal(propMetadataFromResponse(propResponse('3385', 10000), '3384'), undefined)
  assert.equal(propMetadataFromResponse({ error: 0, data: '{bad' }), undefined)
  for (const price of [null, '', true, -1, 'NaN']) {
    const result = propMetadataFromResponse({ error: 0, data: { ...propResponse('3385', 10000).data, price } })!
    assert.equal(result.priceYuan, null)
    assert.equal(result.isFree, false)
  }
  assert.equal(propMetadataFromResponse({ error: 0, data: { ...propResponse('3385', 10000).data, priceType: 99 } })?.priceYuan, null)
})

test('新道具按收到的 ID 自动请求，去重、限制并发，单项失败不漏掉其他奖励', async t => {
  const original = globalThis.fetch
  const requested: string[] = []
  let active = 0, peak = 0
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, 'https://gift.douyucdn.cn/api/prop/v5/web/single')
    const id = url.searchParams.get('pid')!
    requested.push(id)
    active++; peak = Math.max(active, peak)
    try {
      await new Promise(resolve => setTimeout(resolve, 5))
      if (id === '990002') throw new Error('temporary network error')
      return new Response(JSON.stringify(propResponse(id, 600)))
    } finally { active-- }
  }
  const result = await fetchDouyuPropCatalog(['990001', '990002', '990003', '990004', '990005', '990006', '990001', '0', '12&pid=3385'])
  assert.equal(new Set(requested).size, 6)
  assert.equal(requested.length, 6)
  assert.ok(peak <= 4)
  assert.equal(result.size, 5)
  assert.equal(result.get('prop:990006')?.priceYuan, 6)
  assert.equal(result.has('prop:990002'), false)
})

test('固定配置目录的实例锁拒绝第二次启动并唤回，释放后可重新启动', async t => {
  const dir = directory(t)
  let activations = 0
  const first = await acquireInstanceGuard(dir, () => { activations++ })
  assert.ok(first)
  try {
    assert.equal(await acquireInstanceGuard(dir, () => {}), null)
    assert.equal(activations, 1)
    if (process.platform === 'win32') assert.equal(instanceEndpoint(dir), instanceEndpoint(dir.toUpperCase()))
  } finally { await first.close() }
  const restarted = await acquireInstanceGuard(dir, () => {})
  assert.ok(restarted)
  await restarted.close()
})


test('聊天来源和疑似机器人先过滤；dms=0 合法，粉丝牌房间不作为发送房间', () => {
  const chat = { roomId: '11921577', text: '晚上好', dms: '0' }
  assert.equal(chatExclusionReason(chat, '11921577', true), null)
  assert.equal(chatExclusionReason({ ...chat, roomId: '888' }, '11921577', true), 'otherRoom')
  assert.equal(chatExclusionReason({ ...chat, roomId: undefined }, '11921577', false), 'missingRoom')
  assert.equal(chatExclusionReason({ ...chat, dms: undefined }, '11921577', true), 'suspectedRobot')
  assert.equal(chatExclusionReason({ ...chat, dms: undefined }, '11921577', false), null)
  assert.equal(chatExclusionReason({ ...chat, text: '  ' }, '11921577', true), 'emptyText')
  const parsed = tryParseChat({ type: 'chatmsg', rid: '11921577', brid: '888', nn: '观众', txt: '晚上好', dms: '3' })!
  assert.equal(chatExclusionReason(parsed, '11921577', true), null)
  assert.equal(tryParseChat({ type: 'comm_chatmsg', rid: '11921577', txt: '转发别的直播间消息' }), null)
  assert.equal(tryParseChat({ type: 'lt_ai_danmu', rid: '11921577', txt: 'AI 专用消息' }), null)
})

test('每日历史重启续记、跨午夜和换房隔离，旧事件不重复，缺 UID 不伪造人数', (t) => {
  const dir = directory(t)
  let now = new Date(2026, 8, 6, 23, 59, 0).getTime()
  const firstDate = localDateKey(now)
  const store = new StatisticsStore(dir, () => now)
  store.load()
  const chat = { roomId: '11', userId: 'private-user-101', nick: '昵称不保存', text: '正文不保存', dms: '1' }
  store.recordChat('11', { ...chat, messageId: 'c1' }, true)
  store.recordChat('11', { ...chat, messageId: 'c2' }, true)
  store.recordChat('11', { ...chat, messageId: 'c2' }, true)
  store.recordChat('11', { ...chat, messageId: 'robot', dms: undefined, userId: 'robot-user' }, true)
  store.recordChat('11', { ...chat, messageId: 'foreign', roomId: '99' }, true)
  store.recordChat('11', { ...chat, messageId: 'unknown-room', roomId: undefined }, true)
  assert.equal(store.flush(), true)
  const raw = readFileSync(join(dir, firstDate + '.json'), 'utf8')
  assert.ok(raw.includes('private-user-101') && raw.includes('昵称不保存'))
  assert.ok(!raw.includes('正文不保存'), '没有打开正文记录时，仅保存查证所需的用户归属')
  const reopened = new StatisticsStore(dir, () => now)
  reopened.load()
  reopened.recordChat('11', { ...chat, messageId: 'c1' }, true)
  reopened.recordChat('11', { ...chat, messageId: 'c3', userId: 'private-user-202' }, true)
  reopened.recordChat('11', { ...chat, messageId: 'c4', userId: undefined }, true)
  const first = reopened.query().days[0]!
  assert.equal(first.stats.danmakuCount, 4)
  assert.equal(first.stats.danmakuUsers, 2)
  assert.equal(first.stats.unidentifiedChatCount, 1)
  assert.deepEqual(first.exclusions, { suspectedRobot: 1, otherRoom: 1, missingRoom: 1, emptyText: 0 })
  now += 120_000
  reopened.recordChat('11', { ...chat, messageId: 'c1' }, true)
  assert.equal(reopened.query().days.length, 1)
  reopened.recordChat('11', { ...chat, messageId: 'next-day' }, true)
  reopened.recordChat('22', { ...chat, roomId: '22', messageId: 'another-room' }, false)
  assert.equal(reopened.query().days.length, 3)
  assert.equal(reopened.query({ roomId: '11', startDate: localDateKey(now) }).days[0]!.stats.danmakuCount, 1)
  assert.equal(reopened.query({ endDate: firstDate }).days.length, 1)
  assert.equal(reopened.flush(), true)
})

test('历史礼物按奖励 ID 记账，补价修改和清除回算，平台历史金额不随以后涨价改写', (t) => {
  const dir = directory(t)
  let now = new Date(2026, 8, 6, 12).getTime()
  const store = new StatisticsStore(dir, () => now)
  store.load()
  const giftEvent = { ...gift('3385', 2, 'award-event'), roomId: '11', giftCatalogType: 'prop' as const, giftName: '破局挣缚' }
  store.updatePricing(new Map([['24346', { ...meta('24346', null, '无字经书'), isLottery: true }]]), {})
  store.recordGift('11', { ...gift('24346', 20, 'lottery-event'), roomId: '11', giftCatalogType: 'gift', giftName: '无字经书' })
  store.recordGift('11', giftEvent)
  store.recordGift('11', { ...giftEvent, roomId: '22', messageId: 'foreign-gift' })
  assert.equal(store.query().days[0]!.stats.giftCount, 2)
  assert.equal(store.query().days[0]!.stats.unknownGiftCount, 2)
  store.updatePricing(new Map(), { 'prop:3385': { name: '破局挣缚', priceYuan: 10 } })
  assert.equal(store.query().days[0]!.stats.giftValue, 20)
  store.updatePricing(new Map(), { 'prop:3385': { name: '破局挣缚', priceYuan: 12.34 } })
  assert.equal(store.query().days[0]!.stats.giftValue, 24.68)
  store.updatePricing(new Map(), {})
  assert.equal(store.query().days[0]!.stats.giftValue, 0)
  assert.equal(store.query().days[0]!.stats.unknownGiftCount, 2)
  const platform = new Map([['prop:3385', { ...meta('3385', 100, '破局挣缚'), catalogType: 'prop' as const }]])
  store.updatePricing(platform, {})
  assert.equal(store.query().days[0]!.stats.giftValue, 200)
  assert.equal(store.flush(), true)
  const reopened = new StatisticsStore(dir, () => now)
  reopened.load(); reopened.recordGift('11', giftEvent)
  assert.equal(reopened.query().days[0]!.stats.giftCount, 2)
  now += 86_400_000
  platform.get('prop:3385')!.priceYuan = 150
  reopened.updatePricing(platform, {})
  reopened.recordGift('11', { ...giftEvent, messageId: 'tomorrow-award' })
  const days = reopened.query().days
  assert.equal(days[0]!.stats.giftValue, 300)
  assert.equal(days[1]!.stats.giftValue, 200)
  assert.equal(days[1]!.gifts.find(item => item.giftId === '24346')!.isLottery, true)
  assert.equal(reopened.flush(), true)
})

test('损坏历史从有效备份恢复；无可用备份时保留原文件并明确报错', (t) => {
  const dir = directory(t)
  const now = new Date(2026, 8, 6, 12).getTime(), date = localDateKey(now)
  const store = new StatisticsStore(dir, () => now)
  store.load()
  const chat = { roomId: '11', nick: '观众', text: '测试', userId: '1', dms: '1' }
  store.recordChat('11', { ...chat, messageId: 'c1' }, true); store.flush()
  store.recordChat('11', { ...chat, messageId: 'c2' }, true); store.flush()
  writeFileSync(join(dir, date + '.json'), '{damaged')
  const recovered = new StatisticsStore(dir, () => now)
  recovered.load()
  assert.equal(recovered.query().days[0]!.stats.danmakuCount, 1)
  assert.match(recovered.query().notice || '', /备份/)
  assert.equal(recovered.flush(), true)
  assert.ok(existsSync(join(dir, date + '.json.damaged-' + now)))
  writeFileSync(join(dir, date + '.json'), '{original-broken')
  writeFileSync(join(dir, date + '.json.bak'), '{backup-broken')
  const broken = new StatisticsStore(dir, () => now)
  broken.load(); broken.recordChat('11', { ...chat, messageId: 'new' }, true)
  assert.equal(broken.flush(), false)
  assert.match(broken.query().notice || '', /未保存|无法读取/)
  assert.equal(readFileSync(join(dir, date + '.json'), 'utf8'), '{original-broken')
})

test('统计文件写入失败不虚报成功；时间筛选拒绝不存在日期和倒置区间', (t) => {
  const dir = directory(t)
  const now = new Date(2026, 8, 6, 12).getTime()
  const store = new StatisticsStore(dir, () => now)
  store.load()
  store.recordChat('11', { roomId: '11', nick: '观众', text: '测试', dms: '1' }, true)
  mkdirSync(join(dir, localDateKey(now) + '.json.bak'))
  assert.equal(store.flush(), false)
  assert.match(store.query().notice || '', /未保存/)
  assert.throws(() => normalizeStatisticsQuery({ startDate: '2026-02-30' }))
  assert.throws(() => normalizeStatisticsQuery({ startDate: '2026-09-06', endDate: '2026-09-05' }))
  assert.throws(() => normalizeStatisticsQuery({ roomId: '../abc' }))
})

test('单日损坏或原件无法另存时保留备份，不阻塞其他日期保存', (t) => {
  const dir = directory(t)
  let now = new Date(2026, 8, 6, 12).getTime()
  const date = localDateKey(now)
  const initial = new StatisticsStore(dir, () => now)
  initial.load()
  const chat = { roomId: '11', nick: '观众', text: '测试', dms: '1', userId: '1' }
  initial.recordChat('11', { ...chat, messageId: 'first' }, true)
  assert.equal(initial.flush(), true)
  const file = join(dir, date + '.json')
  rmSync(file)
  mkdirSync(file) // 同名目录模拟主文件无法读取、无法另存，但备份仍有效。
  const backup = readFileSync(file + '.bak', 'utf8')
  const restored = new StatisticsStore(dir, () => now)
  restored.load()
  assert.equal(restored.query().days[0]!.stats.danmakuCount, 1)
  assert.match(restored.query().notice || '', /无法另存/)
  restored.recordChat('11', { ...chat, messageId: 'blocked-day' }, true)
  now += 24 * 60 * 60 * 1000
  restored.recordChat('11', { ...chat, messageId: 'next-day' }, true)
  assert.equal(restored.flush(), false)
  assert.equal(readFileSync(file + '.bak', 'utf8'), backup)
  const nextDayFile = join(dir, localDateKey(now) + '.json')
  assert.equal(JSON.parse(readFileSync(nextDayFile, 'utf8')).records[0].state.danmakuCount, 1)
})

test('Excel 导出可重新读取，ID 保留文本，未知单价留空，礼物名称不能注入公式', async (t) => {
  const dir = directory(t)
  const store = new StatisticsStore(join(dir, 'stats'))
  store.load()
  store.recordChat('11', { roomId: '11', nick: '观众', text: '测试', dms: '1', userId: '1' }, true)
  store.recordGift('11', { ...gift('00123', 3, 'g1'), roomId: '11', giftName: '=1+1' })
  store.recordGift('11', { ...gift('99999', 2, 'g2'), roomId: '11', giftName: '未知活动奖励' })
  store.updatePricing(new Map([['00123', meta('00123', 12.34, '=1+1')]]), {})
  const days = store.query().days
  const file = join(dir, 'daily.xlsx')
  await exportStatisticsWorkbook(file, days)
  const workbook = createStatisticsWorkbook([])
  await workbook.xlsx.readFile(file)
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['每日汇总', '用户汇总', '礼物明细', '弹幕记录', '统计口径'])
  const summary = workbook.getWorksheet('每日汇总')!
  const gifts = workbook.getWorksheet('礼物明细')!
  assert.equal(summary.getCell('C2').value, 1)
  assert.equal(summary.getCell('F2').value, 37.02)
  assert.equal(summary.getCell('G2').value, 2)
  assert.equal(gifts.getCell('E2').value, '00123')
  assert.equal(gifts.getCell('C2').value, '123')
  assert.equal(gifts.getCell('G2').value, '=1+1')
  assert.equal(gifts.getCell('J2').formula, 'ROUND(H2*I2,2)')
  assert.equal(gifts.getCell('J2').result, 37.02)
  assert.equal(gifts.getCell('I3').value, null)
  assert.equal(gifts.getCell('J3').value, null)
  assert.equal(summary.views[0]!.state, 'frozen')
  assert.equal(store.flush(), true)
})

test('身份比例与动效配置可持久化并限制极值，不依赖 EXE 所在路径', (t) => {
  const dir = directory(t)
  const config = mergeConfig({ fansMedalScale: 1.25, userLevelScale: 0.8, nicknameScale: 1.5, motionEnabled: false })
  new ConfigStore(dir).save(config)
  assert.deepEqual(new ConfigStore(dir).load(), config)
  assert.equal(mergeConfig({ fansMedalScale: 9 }).fansMedalScale, 1.8)
  assert.equal(mergeConfig({ userLevelScale: -1 }).userLevelScale, 0.6)
  assert.equal(mergeConfig(undefined).nicknameScale, 1)
})

test('游戏投入与奖励从官方活动配置识别，活动换 ID 后无需改代码，普通礼物不被误排除', () => {
  const references = dreamBusGiftReferences({ data: { gift_id: 24829, gift_name: '巴士礼包', gift_price: 100,
    stations: [{ stationId: 1 }], propList: [{ awardId: 3966, price: 200000 }, { awardId: 3969, price: 10 }] } })
  assert.equal(references.input?.isLottery, true)
  assert.equal(references.input?.priceYuan, null)
  assert.deepEqual(references.propIds, ['3966', '3969'])
  const next = dreamBusGiftReferences({ data: { gift_id: 99988, gift_name: '下一期礼包', stations: [1], propList: [{ awardId: 77777 }] } })
  assert.equal(next.input?.id, '99988')
  assert.deepEqual(next.propIds, ['77777'])
  assert.equal(dreamBusGiftReferences({ data: { gift_id: 20002, gift_name: '办卡' } }).input, null)
  const merged = mergeSettledCatalogs([
    { status: 'fulfilled', value: new Map([['24829', references.input!]]) },
    { status: 'fulfilled', value: giftCatalogFromList([{ id: 24829, name: '巴士礼包', basicInfo: { giftType: 0 }, priceInfo: { price: 100 } }]) }
  ])
  const stats = new SessionStats()
  stats.updateCatalog(merged)
  stats.recordGift({ ...gift('24829', 10), giftName: '巴士礼包', giftCatalogType: 'gift' })
  stats.recordGift(propGift('3966', 1, 'bus-reward', '24829'))
  stats.updateCatalog(new Map([['prop:3966', { ...meta('3966', 2000, '星河予你'), catalogType: 'prop' }]]))
  assert.equal(stats.snapshot().giftCount, 1)
  assert.equal(stats.snapshot().giftValue, 2000)
})

function drawCatalog() {
  const inputs = giftCatalogFromList([
    { id: 24346, name: '无字经书', basicInfo: { giftType: 17 }, priceInfo: { price: 50 } },
    { id: 99988, name: '新活动', basicInfo: { giftType: 17 }, priceInfo: { price: 100 } }
  ])
  inputs.get('24346')!.lotteryRewardIds = ['3382', '3383', '990099']
  inputs.get('99988')!.lotteryRewardIds = ['990099']
  inputs.set('prop:3382', { ...meta('3382', .1, '捆仙索'), catalogType: 'prop' })
  inputs.set('prop:3383', { ...meta('3383', .5, '小奖励'), catalogType: 'prop' })
  return inputs
}

function drawInput(uid = '7', giftId = '24346', count = 200): DanmakuPayload {
  return { kind: 'gift', userId: uid, nick: '观众', text: '抽奖', giftKind: 'unknown',
    giftId, giftCatalogType: 'gift', giftName: '待补全名称', giftCount: count }
}

function drawReward(id = '3382', count = 10, uid = '7', sourceGiftId = '24346'): DanmakuPayload {
  return { ...drawInput(uid, id, count), giftCatalogType: 'prop', sourceGiftId }
}

test('官方奖池换名和换 ID 可动态识别，投入单价独立保存，不以奖励贡献值推断价格', () => {
  const response = { error: 0, data: { '99123': { giftName: '下一期活动', giftPrice: 50,
    ratio: { '200': { award: [{ pid: 88001, value: 100000 }, { pid: 88002, value: 1 }] } } } } }
  const catalog = lotteryCatalogFromResponse(response)
  assert.equal(catalog.get('99123')?.lotteryPriceYuan, .5)
  assert.equal(catalog.get('99123')?.priceYuan, null)
  assert.deepEqual(catalog.get('99123')?.lotteryRewardIds, ['88001', '88002'])
  assert.equal(catalog.has('prop:88001'), false)
  assert.deepEqual(lotteryCatalogFromResponse({ error: 0, data: JSON.stringify(response.data) }), catalog)
  assert.equal(lotteryCatalogFromResponse({ error: 1, data: response.data }).size, 0)
  assert.equal(lotteryCatalogFromResponse({ error: 0, data: { '99123': { giftName: '只有名字', giftPrice: 50 } } }).size, 0)
  const merged = mergeSettledCatalogs([
    { status: 'fulfilled', value: new Map([['24829', { ...meta('24829', 1), isLottery: false }]]) },
    { status: 'fulfilled', value: new Map([['24829', { ...meta('24829', null), isLottery: true, lotteryRewardIds: ['3969'] }]]) }
  ])
  assert.equal(merged.get('24829')?.lotteryPriceYuan, 1)
  assert.equal(merged.get('24829')?.priceYuan, null)
})

test('200 个 0.5 元的投入、多种奖品合成 100＝6，分项和数量保留', () => {
  const view = new GiftPresentationStore()
  view.updateCatalog(drawCatalog())
  view.add(drawInput(), 1_000)
  view.add(drawReward(), 1_100)
  view.add(drawReward('3383'), 1_200)
  const rows = view.snapshot()
  assert.equal(rows.length, 1)
  const payload = rows[0]!.payload
  assert.equal(payload.giftName, '无字经书')
  assert.equal(payload.giftPrice, undefined)
  assert.deepEqual(payload.lotterySummary, { inputCount: 200, inputValue: 100, rewardCount: 20,
    rewardValue: 6, unpricedRewardCount: 0,
    rewards: [{ name: '捆仙索', count: 10, value: 1 }, { name: '小奖励', count: 10, value: 5 }] })
  assert.equal(view.snapshot(false).length, 1, '关闭同种礼物折叠仍保留完整的一组开奖')
})

test('奖励先到、目录晚到时可重新合并，重复补目录不重复增加数量', () => {
  const view = new GiftPresentationStore()
  view.add(drawReward(), 1_000)
  view.add(drawInput(), 1_100)
  view.add(drawReward('3383'), 1_200)
  const firstKey = view.snapshot()[0]!.key
  assert.equal(view.snapshot().length, 3)
  for (let i = 0; i < 3; i++) view.updateCatalog(drawCatalog())
  const rows = view.snapshot()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.key, firstKey)
  assert.equal(rows[0]!.payload.lotterySummary?.inputValue, 100)
  assert.equal(rows[0]!.payload.lotterySummary?.rewardValue, 6)
  assert.equal(rows[0]!.payload.lotterySummary?.rewardCount, 20)
})

test('缺少投入、缺价和免费结果都有独立状态，补价及清除仅重算金额', () => {
  const view = new GiftPresentationStore()
  const catalog = drawCatalog()
  view.updateCatalog(catalog)
  view.add(drawReward(), 1_000)
  view.add(drawReward('990099', 2), 1_100)
  let summary = view.snapshot()[0]!.payload.lotterySummary!
  assert.equal(summary.inputValue, null)
  assert.equal(summary.rewardValue, 1)
  assert.equal(summary.unpricedRewardCount, 2)
  const manual = { 'prop:990099': { name: '待补价奖励', priceYuan: 2.5 } }
  view.updateCatalog(withManualGiftPrices(catalog, manual))
  summary = view.snapshot()[0]!.payload.lotterySummary!
  assert.equal(summary.rewardValue, 6)
  assert.equal(summary.unpricedRewardCount, 0)
  view.updateCatalog(catalog)
  summary = view.snapshot()[0]!.payload.lotterySummary!
  assert.equal(summary.rewardValue, 1)
  assert.equal(summary.unpricedRewardCount, 2)
  catalog.set('prop:990099', { ...meta('990099', 0, '免费奖励'), isFree: true, catalogType: 'prop' })
  view.updateCatalog(catalog)
  summary = view.snapshot()[0]!.payload.lotterySummary!
  assert.equal(summary.rewardValue, 1)
  assert.equal(summary.rewardCount, 12)
  assert.equal(summary.unpricedRewardCount, 0)
})

test('不同用户、不同活动和超过连续时间的开奖结果不会混成一笔', () => {
  const view = new GiftPresentationStore()
  view.updateCatalog(drawCatalog())
  view.add(drawInput('7'), 1_000)
  view.add(drawInput('8'), 1_100)
  view.add(drawInput('7', '99988'), 1_200)
  view.add(drawReward(), 1_300)
  view.add(drawReward('3383', 10, '8'), 1_400)
  view.add(drawInput('7'), 1_400 + LOTTERY_JOIN_MS + 1)
  const rows = view.snapshot()
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map(row => row.payload.lotterySummary?.rewardValue), [1, 5, 0, 0])
  assert.equal(rows[2]!.payload.lotterySummary?.inputValue, 200)
})

test('奖池映射仅关联同用户的唯一近期投入；共享奖品、背包道具、同昵称缺 UID 不猜测归属', () => {
  const view = new GiftPresentationStore()
  const catalog = drawCatalog()
  view.updateCatalog(catalog)
  view.add(drawInput(), 1_000)
  view.add(drawReward('3382', 10, '7', ''), 1_100)
  assert.equal(view.snapshot().length, 1)
  view.add(drawInput('7', '99988'), 1_200)
  view.add(drawReward('990099', 1, '7', ''), 1_300)
  assert.equal(view.snapshot().length, 3)
  assert.equal(view.snapshot()[2]!.payload.lotterySummary, undefined)
  const bag = new GiftPresentationStore()
  bag.updateCatalog(catalog)
  bag.add(drawReward('3382', 10, '9', '824'), 1_000)
  assert.equal(bag.snapshot()[0]!.payload.lotterySummary, undefined)
  bag.add(drawInput(''), 1_100)
  bag.add(drawInput(''), 1_200)
  assert.equal(bag.snapshot().length, 3)
})

test('展示折叠和整卡裁剪不改变原始礼物记录，已撤下的卡片不会因补目录复活', () => {
  const view = new GiftPresentationStore()
  view.updateCatalog(drawCatalog())
  const a = drawReward('3382', 10, '7', '824')
  view.add(a, 1_000)
  view.add(a, 1_100)
  assert.equal(view.snapshot(false).length, 2)
  const folded = view.snapshot()
  assert.equal(folded.length, 1)
  assert.equal(folded[0]!.payload.giftCount, 20)
  assert.equal(a.giftCount, 10)
  view.discard(folded[0]!.sourceIds)
  view.updateCatalog(drawCatalog())
  assert.equal(view.snapshot().length, 0)
})

test('临界阻尼在频繁重排后平稳收敛，保持位置连续且不反弹', () => {
  let state = { offset: 120, velocity: 0, acceleration: 0 }
  let previous = state.offset
  for (let frame = 0; frame < 180; frame++) {
    if (frame === 6 || frame === 12) {
      const oldVelocity = state.velocity
      state = { ...state, offset: state.offset + 80 }
      assert.equal(state.velocity, oldVelocity)
      previous = state.offset
    }
    state = advanceFlowMotion(state, frame % 2 ? 1 / 60 : 1 / 120)
    assert.ok(state.offset >= 0 && state.offset <= previous)
    previous = state.offset
  }
  assert.deepEqual(state, { offset: 0, velocity: 0, acceleration: 0 })
  let negative = { offset: -100, velocity: 0, acceleration: 0 }
  for (let frame = 0; frame < 120; frame++) {
    const next = advanceFlowMotion(negative, 1 / 60)
    assert.ok(next.offset >= negative.offset && next.offset <= 0)
    negative = next
  }
  assert.deepEqual(negative, { offset: 0, velocity: 0, acceleration: 0 })
})

test('突发消息按可见容量分批，不让积压量挤满每帧或一次换掉整屏', () => {
  for (const capacity of [1, 3, 6, 12, 30]) {
    for (const pending of [1, 5, 100, 10000]) {
      const batch = incomingBatchSize(pending, capacity)
      assert.ok(batch >= 1 && batch <= 3)
      assert.ok(batch <= Math.max(1, Math.floor(capacity / 3)))
    }
  }
})

test('每日统计与正文开关独立保存，正文只保存开启后通过来源过滤的消息', async t => {
  const dir = directory(t)
  const config = mergeConfig({ dailyStatisticsEnabled: false, saveDanmakuHistory: true, lineHeight: 1, giftValueColors: false })
  new ConfigStore(join(dir, 'config')).save(config)
  assert.deepEqual(new ConfigStore(join(dir, 'config')).load(), config)
  assert.equal(mergeConfig(undefined).saveDanmakuHistory, false)
  const store = new StatisticsStore(join(dir, 'stats'))
  store.load()
  const chat = { roomId: '84452', userId: '1001', nick: '同名观众', text: '完整原文 <b>也保留</b>', dms: '1' }
  store.recordChat('84452', { ...chat, messageId: 'off' }, true, false)
  store.recordChat('84452', { ...chat, messageId: 'on' }, true, true)
  store.recordChat('84452', { ...chat, messageId: 'on' }, true, true)
  store.recordChat('84452', { ...chat, messageId: 'other', userId: '1002' }, true, true)
  store.recordChat('84452', { ...chat, messageId: 'robot', dms: undefined }, true, true)
  store.recordChat('84452', { ...chat, messageId: 'foreign', roomId: '99' }, true, true)
  assert.equal(store.flush(), true)
  assert.equal((await store.chats.query()).total, 2)
  const filtered = await store.chats.query({ roomId: '84452', userId: '1001', keyword: '完整原文' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.messages[0]!.text, chat.text)
  const reopened = new StatisticsStore(join(dir, 'stats'))
  reopened.load()
  reopened.recordChat('84452', { ...chat, messageId: 'on' }, true, true)
  assert.equal((await reopened.chats.query({ user: '同名观众' })).total, 2)
  assert.equal(reopened.query({ userId: '1001' }).users[0]!.danmakuCount, 2)
  assert.equal(reopened.flush(), true)
})

test('正文分页、日期房间与用户过滤可组合，导出完整原文且不能注入 Excel 公式', async t => {
  const dir = directory(t)
  let now = new Date(2026, 8, 7, 14).getTime()
  const store = new StatisticsStore(join(dir, 'stats'), () => now)
  store.load()
  for (let i = 0; i < 250; i++) {
    now++
    store.recordChat('84452', { roomId: '84452', userId: '12345678901234567890', nick: '=1+1',
      text: i === 249 ? '=HYPERLINK("x","原文")' : `弹幕 ${i}`, messageId: `page:${i}`, dms: '1' }, true, true)
  }
  assert.equal(store.flush(), true)
  const page = await store.chats.query({ roomId: '84452', userId: '12345678901234567890', offset: 100, limit: 100 })
  assert.equal(page.total, 250)
  assert.equal(page.messages[0]!.text, '弹幕 149')
  assert.equal(page.messages[99]!.text, '弹幕 50')
  assert.equal(page.hasMore, true)
  await assert.rejects(store.chats.query({ limit: 1000 }))
  const query = { roomId: '84452', userId: '12345678901234567890', keyword: 'HYPERLINK' }
  const file = join(dir, 'filtered.xlsx')
  await exportStatisticsWorkbook(file, store.query(query).days, store.chats.read(query))
  const book = createStatisticsWorkbook([])
  await book.xlsx.readFile(file)
  const sheet = book.getWorksheet('弹幕记录')!
  assert.equal(sheet.rowCount, 2)
  assert.equal(sheet.getCell('C2').value, query.userId)
  assert.equal(sheet.getCell('D2').value, '=1+1')
  assert.equal(sheet.getCell('E2').value, '=HYPERLINK("x","原文")')
  assert.equal(sheet.getCell('E2').formula, undefined)
  assert.ok(sheet.autoFilter)
})

test('用户送礼归属、投入消费与奖励价值分开累计，晚到价格回填同一用户且保留历史投入价', t => {
  const store = new StatisticsStore(directory(t))
  store.load()
  store.recordChat('84452', { roomId: '84452', userId: '7', nick: '原昵称', text: '你好', dms: '1', messageId: 'chat' }, true)
  store.recordGift('84452', { ...gift('24346', 200, 'input'), roomId: '84452', userId: '7', nick: '新昵称', giftCatalogType: 'gift' })
  store.recordGift('84452', { ...gift('3382', 10, 'reward'), roomId: '84452', userId: '7', nick: '新昵称', giftCatalogType: 'prop', sourceGiftId: '24346' })
  store.recordGift('84452', { ...gift('100', 2, 'ordinary'), roomId: '84452', userId: '8', nick: '同名观众', giftCatalogType: 'gift' })
  assert.ok(store.pendingGiftReferences('84452').propIds.includes('3382'))
  const catalog = drawCatalog()
  catalog.delete('prop:3382')
  catalog.set('100', meta('100', 5, '普通礼物'))
  store.updatePricing(catalog, {})
  let user = store.query({ userId: '7', roomId: '84452' }).users[0]!
  assert.equal(user.spending, 100)
  assert.equal(user.unknownGiftCount, 10)
  assert.equal(user.giftValue, 0)
  catalog.set('prop:3382', { ...meta('3382', .1, '捆仙索'), catalogType: 'prop' })
  store.updatePricing(catalog, {})
  user = store.query({ userId: '7' }).users[0]!
  assert.equal(user.spending, 100)
  assert.equal(user.giftValue, 1)
  assert.equal(user.giftCount, 10)
  assert.equal(user.nick, '新昵称')
  assert.equal(user.unknownGiftCount, 0)
  assert.equal(store.query({ userId: '8' }).users[0]!.spending, 10)
  assert.equal(store.query({ userId: '7' }).days[0]!.gifts.length, 2)
  assert.equal(store.query({ userId: '7' }).days[0]!.gifts[1]!.sourceName, '无字经书')
  catalog.get('24346')!.lotteryPriceYuan = 8
  store.updatePricing(catalog, {})
  assert.equal(store.query({ userId: '7' }).users[0]!.spending, 100)
  assert.equal(store.flush(), true)
  const reopened = new StatisticsStore(store.directory)
  reopened.load()
  assert.equal(reopened.query({ userId: '7' }).users[0]!.giftValue, 1)
  assert.equal(reopened.query({ userId: '7' }).users[0]!.spending, 100)
})

test('旧版历史保持总数并明确缺少归属，不能把旧礼物猜给新用户', t => {
  const dir = directory(t), store = new StatisticsStore(dir)
  store.load()
  store.recordChat('11', { roomId: '11', userId: '1', nick: '原观众', text: '历史', dms: '1' }, true)
  store.recordGift('11', { ...gift('100', 3), roomId: '11' })
  store.flush()
  const file = join(dir, `${localDateKey()}.json`)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  delete raw.records[0].state.userDetails
  for (const item of raw.records[0].state.gifts) { delete item.userId; delete item.nick }
  writeFileSync(file, JSON.stringify(raw))
  const restored = new StatisticsStore(dir)
  restored.load()
  assert.equal(restored.query().days[0]!.stats.danmakuCount, 1)
  assert.equal(restored.query().days[0]!.stats.giftCount, 3)
  assert.equal(restored.query().days[0]!.hasLegacyDetails, true)
  assert.equal(restored.query().users.length, 0)
  assert.equal(restored.query({ userId: '1' }).days.length, 0)
})

test('梦想巴士奖励延迟到达、投入卡已经退场时仍能恢复对应关系，不把奖励当成再次消费', () => {
  const refs = dreamBusGiftReferences({ data: { gift_id: 24829, gift_name: '巴士礼包', gift_price: 100,
    propList: [{ awardId: 3969 }], stations: [{ stationId: 1 }] } })
  const catalog = new Map<string, DouyuGiftMeta>([['24829', refs.input!], ['prop:3969', { ...meta('3969', .1, '旅行帽'), catalogType: 'prop' }]])
  const view = new GiftPresentationStore()
  view.updateCatalog(catalog)
  view.add(drawInput('7', '24829', 2), 1_000)
  const first = view.snapshot()[0]!
  view.retire(first.sourceIds)
  assert.equal(view.snapshot().length, 0)
  view.updateCatalog(catalog)
  assert.equal(view.snapshot().length, 0, '仅补目录不能让已经消失的卡片复活')
  view.add({ ...drawReward('3969', 2, '7'), sourceGiftId: undefined }, 46_000)
  const result = view.snapshot()[0]!
  assert.equal(result.key, first.key)
  assert.equal(result.payload.giftName, '巴士礼包')
  assert.equal(result.payload.lotterySummary!.inputValue, 2)
  assert.equal(result.payload.lotterySummary!.rewardValue, .2)
  assert.equal(result.payload.lotterySummary!.rewards[0]!.name, '旅行帽')
  view.retire(result.sourceIds)
  view.add({ ...drawReward('3969', 1, '7'), sourceGiftId: undefined }, 46_001 + LOTTERY_REWARD_WAIT_MS)
  assert.equal(view.snapshot()[0]!.payload.lotterySummary, undefined)
  assert.equal(view.snapshot()[0]!.payload.lotteryUnmatched, true)
})

test('价值背景按本卡奖励金额分级，未知不是免费，抽奖投入再大也不抬高奖励等级', () => {
  const sample = (value: number): DanmakuPayload => ({ ...drawInput(), giftIsLottery: false, giftPrice: value, giftCount: 1 })
  assert.equal(giftValueTier(sample(0)), 'free')
  assert.equal(giftValueTier(sample(9.99)), 'small')
  assert.equal(giftValueTier(sample(10)), 'medium')
  assert.equal(giftValueTier(sample(100)), 'large')
  assert.equal(giftValueTier(sample(1000)), 'premium')
  assert.equal(giftValueTier(drawInput()), 'pending')
  assert.equal(giftValueTier({ ...drawInput(), lotterySummary: { inputCount: 10000, inputValue: 10000,
    rewardCount: 1, rewardValue: 6, unpricedRewardCount: 0, rewards: [] } }), 'small')
})

test('退场改变目标方向时阻尼不沿旧速度反冲，后续每帧向新目标收敛', () => {
  let state = retargetFlowMotion({ offset: 6, velocity: -200, acceleration: 1000 }, -20)
  assert.deepEqual(state, { offset: -14, velocity: 0, acceleration: 0 })
  for (let i = 0; i < 80; i++) {
    const next = advanceFlowMotion(state, 1 / 60)
    assert.ok(Math.abs(next.offset) <= Math.abs(state.offset))
    assert.ok(next.offset <= 0)
    state = next
  }
  assert.equal(state.offset, 0)
})

test('弹幕导出固定查询时的文件末尾，后续同毫秒消息留到下一次导出', async t => {
  const store = new StatisticsStore(directory(t), () => new Date('2026-09-07T12:00:00+08:00').getTime())
  store.load()
  const chat = { roomId: '84452', userId: '7', nick: '查证观众', text: '导出前', dms: '1', messageId: 'before' }
  store.recordChat('84452', chat, true, true)
  const snapshot = store.chats.read({ roomId: '84452' })
  store.recordChat('84452', { ...chat, messageId: 'after', text: '导出后' }, true, true)
  store.flush()
  const messages = []
  for await (const item of snapshot) messages.push(item)
  assert.deepEqual(messages.map(item => item.text), ['导出前'])
  assert.equal((await store.chats.query()).total, 2)
})

test('跨日用户消费汇总保留最近昵称，不被倒序的旧日记录覆盖', t => {
  let now = new Date('2026-09-06T12:00:00+08:00').getTime()
  const store = new StatisticsStore(directory(t), () => now)
  store.load()
  store.recordChat('84452', { roomId: '84452', userId: '7', nick: '旧昵称', text: '昨天', dms: '1', messageId: 'old' }, true)
  now += 86400_000
  store.recordChat('84452', { roomId: '84452', userId: '7', nick: '新昵称', text: '今天', dms: '1', messageId: 'new' }, true)
  const user = store.query().users[0]!
  assert.equal(user.nick, '新昵称')
  assert.equal(user.danmakuCount, 2)
  store.flush()
})
