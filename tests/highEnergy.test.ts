import test from 'node:test'
import assert from 'node:assert/strict'
import { HighEnergyReader, highEnergyChat, parseHighEnergyEvent } from '../src/douyu/highEnergy'
import { parseDouyuFields, tryParseGift, type ChatMessage } from '../src/douyu/client'
import { chatExclusionReason } from '../src/shared/chatPolicy'
import { SessionStats } from '../src/main/sessionStats'

// 协议依据：官网 live-next-player-aside_a1dae71.js 的 HighEnergyServices，
// 正文依据：high-energy-barrage-master/useGetBarrageDetail-0261db9a.js。
const escape = (value: string): string => value.replace(/@/g, '@A').replace(/\//g, '@S')
const stt = (fields: Record<string, string>): string => Object.entries(fields).map(([key, value]) => key + '@=' + escape(value) + '/').join('')
function event(items: Record<string, string>[], mtype = '2', type = 'voice_trlt', rid = '84452') {
  const list = items.map(item => escape(stt(item)) + '/').join('')
  return parseHighEnergyEvent(parseDouyuFields(stt({ type, rid, mtype, list })), '84452')!
}
function json(value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { headers })
}

test('高能 STT 多条记录逐层解码，正文里的斜杠、@、表情和字面转义保持原样', () => {
  const result = event([{ vrId: 'v-1', uid: '7', un: '观众', content: '你好/世界 @S [emot:dy101]' },
    { vrId: 'v-2', uid: '8', un: '第二位', content: '第二条' }])
  assert.equal(result.action, 'add')
  assert.equal(result.records.length, 2)
  const chat = highEnergyChat({ voiceRecordId: 'v-1', content: result.records[0]!.content }, result.records[0]!)!
  assert.equal(chat.text, '你好/世界 @S [emot:dy101]')
  assert.equal(chat.nick, '观众')
  assert.equal(chat.userId, '7')
  assert.equal(chat.roomId, '84452')
  assert.equal(chat.isHighEnergy, true)
  assert.equal(parseHighEnergyEvent({ type: 'voice_utost', mtype: '2', list: '' }, '84452'), null)
})

test('只采集当前房间的公开新增高能记录，不把初始化、审核或撤下通知重播', async () => {
  const messages: ChatMessage[] = []
  let requests = 0
  const reader = new HighEnergyReader(message => messages.push(message), async () => {
    requests++; throw new Error('不应联网')
  })
  reader.accept(event([{ vrId: 'old', content: '旧消息' }], '1'))
  reader.accept(event([{ vrId: 'old', content: '旧消息' }]))
  reader.accept(event([{ vrId: 'removed' }], '3'))
  reader.accept(event([{ vrId: 'removed', content: '已撤下' }]))
  reader.accept(event([{ vrId: 'foreign', content: '别的房间' }], '2', 'voice_trlt', '999'))
  reader.accept(event([{ vrId: 'foreign-inner', rid: '999', content: '别的房间' }]))
  reader.accept(event([{ vrId: 'current', uid: '9', content: '公开正文' }]))
  reader.accept(event([{ vrId: 'current', uid: '9', content: '公开正文' }], '2', 'anchor_voice_trlt'))
  await reader.flush()
  reader.stop()
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.text, '公开正文')
  assert.equal(requests, 0)
})

test('高能正文通过官方只读详情取得，保留用户归属并去重，不重复记礼物消费', async () => {
  const messages: ChatMessage[] = []
  const calls: { url: string; method?: string }[] = []
  const reader = new HighEnergyReader(message => messages.push(message), async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method })
    if (url.endsWith('getCsrfCookie')) return json({ error: 0 }, { 'set-cookie': 'acf_ccn=test-token; Path=/' })
    assert.ok(url.endsWith('/voiceDanmu/play/batchVoiceDetail'))
    assert.equal(init?.method, 'POST')
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get('rid'), '84452')
    assert.equal(body.get('recordIdList'), 'v-1,v-2')
    assert.equal(body.get('ctn'), 'test-token')
    return json({ error: 0, data: { recordList: [
      { voiceRecordId: 'unrequested', content: '不能收录' },
      { voiceRecordId: 'v-1', uid: '7', userNick: '发送者', content: '真实发送的内容', realPrice: 3000 },
      { voiceRecordId: 'v-1', uid: '7', userNick: '发送者', content: '真实发送的内容' },
      { voiceRecordId: 'v-2', rid: '999', content: '不能串房' }
    ] } })
  })
  reader.accept(event([{ vrId: 'v-1', un: '观众' }, { vrId: 'v-2', un: '另一位' }]))
  await reader.flush()
  reader.stop()
  assert.equal(calls.length, 2)
  assert.equal(messages.length, 1)
  const chat = messages[0]!
  assert.equal(chat.userId, '7')
  assert.equal(chat.nick, '发送者')
  assert.equal(chatExclusionReason(chat, '84452', true), null)
  assert.equal(chatExclusionReason({ ...chat, roomId: '999' }, '84452', true), 'otherRoom')
  const stats = new SessionStats()
  assert.equal(stats.recordChat(chat), true)
  assert.equal(stats.recordChat(chat), false)
  assert.equal(stats.snapshot().danmakuCount, 1)
  assert.equal(stats.snapshot().giftValue, 0)
  assert.equal(stats.snapshot().giftCount, 0)
})

test('详情只取 content，不拿昵称、语音地址、礼物名或空正文冒充弹幕', () => {
  const ref = event([{ vrId: '1', un: '观众' }]).records[0]!
  assert.equal(highEnergyChat({ voiceRecordId: '1', voiceUrl: 'https://example.com/a.mp3', userNick: '用户' }, ref), null)
  assert.equal(highEnergyChat({ voiceRecordId: '1', content: '   ' }, ref), null)
  assert.equal(highEnergyChat({ voiceRecordId: '2', content: '错误记录' }, ref), null)
})

test('切换房间或关闭后，晚到详情不再送入弹幕和统计', async () => {
  const messages: ChatMessage[] = []
  let resolveDetail!: (response: Response) => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const reader = new HighEnergyReader(message => messages.push(message), async input => {
    if (String(input).endsWith('getCsrfCookie')) return json({ error: 0 }, { 'set-cookie': 'acf_ccn=test-token' })
    markStarted()
    return new Promise<Response>(resolve => { resolveDetail = resolve })
  })
  reader.accept(event([{ vrId: 'late' }]))
  const work = reader.flush()
  await started
  reader.stop()
  resolveDetail(json({ error: 0, data: { recordList: [{ voiceRecordId: 'late', content: '晚到正文' }] } }))
  await work
  assert.equal(messages.length, 0)
})

test('粉丝牌升级保留通知含义，不增加聊天条数或礼物消费', () => {
  const gift = tryParseGift({ type: 'blab', rid: '84452', uid: '7', nn: '观众', bnn: '粉丝牌', bl: '20' })!
  assert.equal(gift.giftKind, 'fans')
  assert.equal(gift.giftName, '粉丝牌升到20级')
  const stats = new SessionStats()
  assert.equal(stats.recordGift(gift), false)
  assert.equal(stats.snapshot().danmakuCount, 0)
  assert.equal(stats.snapshot().giftValue, 0)
})
