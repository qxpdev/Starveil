import test from 'node:test'
import assert from 'node:assert/strict'
import { giftCatalogFromList, giftBannersFromResponse } from '../src/douyu/roomInfo'
import { tryParseGift } from '../src/douyu/client'
import { mergeGiftMetadata } from '../src/shared/giftMetadata'
import { officialGiftUrl, officialGiftVideoUrl, resolveOfficialGiftMedia } from '../src/shared/giftMedia'
import { GiftPresentationStore } from '../src/shared/giftPresentation'
import { parseVapInfo } from '../src/shared/vap'
import { mergeConfig } from '../src/shared/config'

const prefix = 'https://gfs-op.douyucdn.cn/dygift'
const gift = { id: 20005, name: '超级火箭', picUrlPrefix: prefix, effectStatus: 1,
  basicInfo: { giftType: 0, focusPic: '/rocket.gif', giftPic: '/rocket.png' }, priceInfo: { price: 200000 },
  effectInfo: { '0': {}, '20003': { mp4: { mp4Src: '/rocket.mp4' }, banner: {} },
    '20004': { mp4: { mp4Src: 'https://outside.example/foreign.mp4' }, banner: {} } } }

test('官方媒体按广播 eic 与 bnidv2 选择，不靠金额、数量或目录顺序推测触发', () => {
  const meta = giftCatalogFromList([gift]).get('20005')!
  assert.equal(meta.image, `${prefix}/rocket.gif`)
  assert.equal(meta.staticImage, `${prefix}/rocket.png`)
  assert.equal(meta.effects?.['20003']?.video, `${prefix}/rocket.mp4`)
  assert.equal(meta.effects?.['20004'], undefined)
  const parsed = tryParseGift({ type: 'dgb', gpf: '0', gfid: '20005', nn: '观众', gfcnt: '1', eic: '20003', bnidv2: '10005', skinid: '0' })!
  assert.equal(parsed.giftEffectId, '20003')
  assert.equal(parsed.giftBannerId, '10005')
  const media = resolveOfficialGiftMedia({ ...parsed, text: '' }, meta, { '10005': `${prefix}/banner.png` })
  assert.equal(media.giftVideo, `${prefix}/rocket.mp4`)
  assert.equal(media.giftBanner, `${prefix}/banner.png`)
  assert.equal(resolveOfficialGiftMedia({ nick: '', text: '', giftCount: 999 }, meta, {}).giftVideo, undefined)
  assert.equal(resolveOfficialGiftMedia({ nick: '', text: '', giftEffectId: '0' }, meta, {}).giftVideo, undefined)
  assert.equal(resolveOfficialGiftMedia({ nick: '', text: '', giftEffectId: '20003', giftSkinId: '456' }, meta, {}).giftVideo, undefined)
})

test('官方礼物条兼容字符串 JSON，只接受对应编号与可信 CDN', () => {
  const banners = giftBannersFromResponse({ error: 0, data: JSON.stringify({ bannersNew: {
    '10001': { bannerPic: `${prefix}/light.png`, bannerPicDark: `${prefix}/dark.png` },
    '10002': { bannerPic: 'https://douyucdn.cn.evil.example/fake.png' }
  } }) })
  assert.deepEqual(banners, { '10001': `${prefix}/dark.png` })
  assert.deepEqual(giftBannersFromResponse({ error: 0, data: 'broken' }), {})
  assert.deepEqual(giftBannersFromResponse({ error: 500 }), {})
  for (const url of ['file:///C:/config.json', 'https://127.0.0.1/a.mp4', 'https://user:pass@gfs-op.douyucdn.cn/a.mp4',
    'https://gfs-op.douyucdn.cn:123/a.mp4', 'https://douyucdn.cn.example/a.mp4', 'data:video/mp4;base64,AA==']) {
    assert.equal(officialGiftVideoUrl(url), undefined)
  }
  assert.equal(officialGiftVideoUrl(`${prefix}/x.js`), undefined)
  assert.equal(officialGiftVideoUrl(`${prefix}/x.mp4?version=1`), `${prefix}/x.mp4?version=1`)
  assert.equal(officialGiftUrl('/x.gif', prefix), `${prefix}/x.gif`)
  assert.equal(officialGiftUrl('//gfs-op.douyucdn.cn/x.png'), 'https://gfs-op.douyucdn.cn/x.png')
})

test('目录晚到时补齐官方动画，较弱价格来源不会抹掉素材，也不改变数量', () => {
  const store = new GiftPresentationStore()
  store.add({ kind: 'gift', nick: '观众', userId: '7', text: '超级火箭', giftId: '20005', giftEffectId: '20003', giftBannerId: '10005', giftCount: 2 }, 1000)
  assert.equal(store.snapshot()[0]!.payload.giftVideo, undefined)
  const catalog = giftCatalogFromList([gift])
  const merged = mergeGiftMetadata(catalog.get('20005'), { id: '20005', name: '', image: '', priceYuan: null, isFree: false })
  store.updateCatalog(new Map([['20005', merged]]), { '10005': `${prefix}/banner.png` })
  for (let i = 0; i < 2; i++) {
    const item = store.snapshot()[0]!.payload
    assert.equal(item.giftVideo, `${prefix}/rocket.mp4`)
    assert.equal(item.giftBanner, `${prefix}/banner.png`)
    assert.equal(item.giftPrice, 2000)
    assert.equal(item.giftCount, 2)
  }
})

function atom(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.byteLength + 8)
  new DataView(result.buffer).setUint32(0, result.byteLength)
  result.set(new TextEncoder().encode(type), 4); result.set(data, 8)
  return result
}

const rocketVap = { v: 2, f: 112, w: 520, h: 850, fps: 20, videoW: 784, videoH: 864,
  aFrame: [524, 0, 260, 425], rgbFrame: [0, 0, 520, 850], isVapx: 0, orien: 0 }
function video(info = rocketVap): ArrayBuffer {
  const header = atom('ftyp', new Uint8Array(12)), vap = atom('vapc', new TextEncoder().encode(JSON.stringify({ info })))
  const result = new Uint8Array(header.byteLength + vap.byteLength)
  result.set(header); result.set(vap, header.byteLength)
  return result.buffer
}

test('超级火箭 VAP 使用实际非对半的 RGB/Alpha 矩形，不用黑色抠图', () => {
  assert.deepEqual(parseVapInfo(video()), { width: 520, height: 850, videoWidth: 784, videoHeight: 864,
    rgb: [0, 0, 520, 850], alpha: [524, 0, 260, 425], duration: 5.6 })
  const bytes = video()
  assert.equal(parseVapInfo(bytes.slice(0, bytes.byteLength - 1)), null)
  assert.equal(parseVapInfo(new ArrayBuffer(0)), null)
})

test('非透明视频、损坏 box、越界矩形、VAPX、异常尺寸与超时动画回退礼物图', () => {
  assert.equal(parseVapInfo(atom('mdat', new Uint8Array(8)).buffer as ArrayBuffer), null)
  const broken = video(); new DataView(broken).setUint32(0, 4)
  assert.equal(parseVapInfo(broken), null)
  for (const changes of [{ isVapx: 1 }, { v: 3 }, { orien: 90 }, { videoW: 90000 }, { fps: 0 }, { f: 20000 },
    { aFrame: [524, 0, 900, 425] }, { aFrame: [-1, 0, 200, 200] }, { rgbFrame: [0, 0, 0, 0] }]) {
    assert.equal(parseVapInfo(video({ ...rocketVap, ...changes })), null)
  }
})

test('透明礼物底色与官方礼物条、动画开关独立保存', () => {
  assert.equal(mergeConfig({}).giftBackgroundOpacity, 0)
  for (const options of [{ giftOfficialBanner: true, giftOfficialAnimation: false },
    { giftOfficialBanner: false, giftOfficialAnimation: true }]) {
    const restored = mergeConfig(JSON.parse(JSON.stringify(mergeConfig(options))))
    assert.equal(restored.giftOfficialBanner, options.giftOfficialBanner)
    assert.equal(restored.giftOfficialAnimation, options.giftOfficialAnimation)
  }
})
