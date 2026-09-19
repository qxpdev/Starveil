import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { BoundedFileCache, managedPath, scanCacheDirectory, removeCacheFiles } from '../src/main/cacheFiles'
import { CacheManager } from '../src/main/cacheManager'
import { EmoticonService } from '../src/main/emoticonService'
import { standardEmoticons, parseRoomEmoticons } from '../src/douyu/emoticons'
import { emoticonMap, safeEmoticonUrl, splitEmoticons } from '../src/shared/emoticons'
import { mergeConfig } from '../src/shared/config'
import { ConfigStore } from '../src/main/configStore'

const image = 'https://sta-op.douyucdn.cn/dygev/2024/04/25/a8750fa3bdffeeb2109f76fc5b7b4ace.png'
const memeResponse = { error: 0, data: { popularEmojis: { list: [{ name: '菜就多练', webPic: image, type: 3 }] } } }
const emptyResponse = { error: 0, data: null }

function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'xingmu-test-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    const remove = (target: string): void => {
      assert.ok(target === root || resolve(target).startsWith(resolve(root) + sep))
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        const child = join(target, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) remove(child)
        else unlinkSync(child)
      }
      rmdirSync(target)
    }
    remove(root)
  })
  return root
}
function put(root: string, name: string, value = 'cache'): string {
  const file = join(root, name)
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value)
  return file
}

test('普通、数字编码、钻粉梗与房间表情混排，未知 token 和原文保留', () => {
  const dynamic = parseRoomEmoticons(memeResponse, { data: JSON.stringify({ emoList: [{ eid: 'room102', pic: image }] }) })
  const catalog = emoticonMap([...standardEmoticons(), ...dynamic])
  const text = '你好[吃瓜] [emot:dy101] [菜就多练][room102][未知表情] <img src=x>😀'
  const parts = splitEmoticons(text, catalog)
  assert.equal(parts.filter(part => part.emoticon).length, 4)
  assert.equal(parts.map(part => part.text).join(''), text)
  assert.equal(parts.find(part => part.text === '[菜就多练]')?.emoticon?.source, 'meme')
  assert.deepEqual(splitEmoticons(text, catalog, false), [{ text }])
  assert.ok(catalog.has('dy001') && catalog.has('101') && catalog.has('RUA'))
})

test('钻粉、公共与房间接口接受空目录，拒绝伪造域名和 HTML 编码', () => {
  const items = parseRoomEmoticons({ data: { emoList: [{ text: '钻粉', pic: image }],
    commEmoList: [{ text: '星座', pic: image }, { text: '[bad]', pic: image }],
    popularEmojis: { list: [{ name: '坏地址', webPic: 'https://douyucdn.cn.evil.test/a.png' }] } } },
  { data: { emoList: [{ eid: 678, pic: image }] } })
  assert.deepEqual(items.map(item => [item.code, item.source]), [['钻粉', 'diamond'], ['星座', 'shared'], ['678', 'room']])
  assert.deepEqual(parseRoomEmoticons(emptyResponse, null), [])
  for (const url of ['file:///C:/config.json', 'javascript:alert(1)', 'https://sta-op.douyucdn.cn@evil.test/x', 'https://evil.test/x', 'https://sta-op.douyucdn.cn:999/x']) assert.equal(safeEmoticonUrl(url), '')
  assert.equal(safeEmoticonUrl(image.replace('https:', 'http:')), image)
})

test('重复表情限制图片节点数量，但查证正文不丢字', () => {
  const text = '[吃瓜]'.repeat(1000)
  const parts = splitEmoticons(text, emoticonMap(standardEmoticons()))
  assert.equal(parts.filter(part => part.emoticon).length, 64)
  assert.equal(parts.map(part => part.text).join(''), text)
})

test('表情开关默认开启，关闭后重启配置仍保留', t => {
  const root = directory(t), store = new ConfigStore(root)
  assert.equal(store.load().showDouyuEmoticons, true)
  store.save(mergeConfig({ showDouyuEmoticons: false, roomId: '84452', lineHeight: 1.1 }))
  const loaded = new ConfigStore(root).load()
  assert.equal(loaded.showDouyuEmoticons, false)
  assert.equal(loaded.lineHeight, 1.1)
})

test('缓存清单只包含可恢复的内容，清理后配置、备份、统计、正文和其他文件逐字不变', async t => {
  const root = directory(t)
  const protectedNames = ['config.json', 'config.json.bak', 'statistics/2026-09-07.json', 'statistics/danmaku/2026-09-07.jsonl',
    'statistics/2026-09-07.json.bak', 'Network/Cookies', 'Local Storage/preferences', 'Preferences', 'custom.xlsx', 'cache/unmanaged/data.txt']
  const protectedContents = protectedNames.map((name, index) => [put(root, name, `kept-${index}`), `kept-${index}`])
  const disposable = ['cache/chromium/Cache/Cache_Data/a', 'cache/chromium/Code Cache/js/a', 'cache/chromium/GPUCache/a',
    'cache/avatars/84452.png', 'cache/emoticons/room-84452.json', 'cache/logs/a.log', 'cache/crash-dumps/a.dmp', 'room-avatar-cache/old.png', 'Cache/Cache_Data/a', 'DawnWebGPUCache/a']
  disposable.forEach(name => put(root, name))
  const calls: string[] = []
  const clear = async (name: string): Promise<void> => {
    calls.push(name)
    const scan = await scanCacheDirectory(root, `cache/chromium/${name}`)
    await removeCacheFiles(root, scan.files)
  }
  const manager = new CacheManager(root, { clearCache: () => clear('Cache'), clearCodeCaches: () => clear('Code Cache') })
  const before = await manager.inventory()
  assert.equal(before.bytes, disposable.length * 5)
  assert.ok(before.historyBytes > 0)
  const result = await manager.clear()
  assert.equal(result.canceled, false)
  if (result.canceled) return
  assert.equal(result.inventory.bytes, 0)
  assert.equal(result.releasedBytes, before.bytes)
  assert.deepEqual(calls, ['Cache', 'Code Cache'])
  for (const [file, content] of protectedContents) assert.equal(readFileSync(file!, 'utf8'), content)
  for (const name of disposable) assert.equal(existsSync(join(root, name)), false)
  assert.equal(existsSync(join(root, 'room-avatar-cache')), false)
})

test('清理拒绝路径穿越、缓存 junction 和内部链接，不会进入统计目录', async t => {
  const root = directory(t)
  const kept = put(root, 'statistics/protected.json', 'kept')
  mkdirSync(join(root, 'cache/chromium'), { recursive: true })
  const links = [join(root, 'cache/chromium/Cache'), join(root, 'cache/avatars')]
  for (const link of links) symlinkSync(join(root, 'statistics'), link, 'junction')
  try {
    await assert.rejects(managedPath(root, '../outside'), /越界/)
    await assert.rejects(managedPath(root, 'cache/avatars/protected.json'), /链接/)
    let called = false
    const manager = new CacheManager(root, { clearCache: async () => { called = true }, clearCodeCaches: async () => {} })
    const result = await manager.clear()
    assert.equal(called, false)
    assert.equal(readFileSync(kept, 'utf8'), 'kept')
    assert.equal(result.canceled, false)
    if (!result.canceled) assert.ok(result.skipped > 0 && result.warnings.length > 0)
  } finally { for (const link of links) unlinkSync(link) }
})

test('扫描之后被替换或正在写入的缓存不强行删除', async t => {
  const root = directory(t)
  put(root, 'cache/avatars/test.png', 'before')
  const scan = await scanCacheDirectory(root, 'cache/avatars')
  put(root, 'cache/avatars/test.png', 'after updated')
  const result = await removeCacheFiles(root, scan.files)
  assert.equal(result.skipped, 1)
  assert.equal(readFileSync(join(root, 'cache/avatars/test.png'), 'utf8'), 'after updated')
})

test('中文数据路径也能清除缓存并保留配置', async t => {
  const root = join(directory(t), '中文数据目录')
  put(root, 'config.json', '我的配置')
  put(root, 'cache/emoticons/目录.json', 'cache')
  const manager = new CacheManager(root, { clearCache: async () => {}, clearCodeCaches: async () => {} })
  const result = await manager.clear()
  assert.equal(result.canceled, false)
  if (!result.canceled) assert.equal(result.inventory.bytes, 0)
  assert.equal(existsSync(join(root, 'cache/emoticons')), false)
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), '我的配置')
})

test('中文项目的构建清理真实删除产物，保护 release/data 并拒绝误删用户文件', t => {
  const root = join(directory(t), '中文项目')
  const requireProject = createRequire(join(process.cwd(), 'package.json'))
  const { cleanGeneratedDirectory } = requireProject('./scripts/clean-dist.cjs') as { cleanGeneratedDirectory: (root: string, child: string) => void }
  put(root, 'release/data/config.json', 'keep')
  put(root, 'out/界面.js', 'temporary')
  cleanGeneratedDirectory(root, 'out')
  assert.equal(existsSync(join(root, 'out')), false)
  put(root, 'release/.build/config.json', 'protected')
  assert.throws(() => cleanGeneratedDirectory(root, join('release', '.build')), /配置/)
  assert.throws(() => cleanGeneratedDirectory(root, 'release'), /非编译目录/)
  assert.equal(readFileSync(join(root, 'release/data/config.json'), 'utf8'), 'keep')
})

test('目录缓存限制容量与数量，过期文件淘汰，不能以缓存键写出目录', async t => {
  const root = directory(t)
  const cache = new BoundedFileCache(root, 'cache/avatars', 10, 60_000, 2)
  await cache.write('one.png', '1234')
  const early = new Date(Date.now() - 2000)
  utimesSync(join(root, 'cache/avatars/one.png'), early, early)
  await cache.write('two.png', '5678')
  await cache.write('three.png', '9012')
  assert.equal((await scanCacheDirectory(root, 'cache/avatars')).bytes, 8)
  assert.equal(await cache.read('one.png'), null)
  assert.equal((await cache.read('three.png'))?.toString(), '9012')
  const stale = new Date(Date.now() - 120_000)
  utimesSync(join(root, 'cache/avatars/three.png'), stale, stale)
  assert.equal(await cache.read('three.png'), null)
  await cache.prune()
  assert.equal(existsSync(join(root, 'cache/avatars/three.png')), false)
  await cache.write('too-big.png', '0'.repeat(11))
  assert.equal(await cache.read('too-big.png'), null)
  assert.throws(() => cache.write('../config.json', 'bad'), /缓存键/)
})

test('清理使正在排队的目录写入失效，之后可以重新缓存', async t => {
  const root = directory(t), cache = new BoundedFileCache(root, 'cache/emoticons', 100, 60_000, 2)
  const write = cache.write('old.json', 'old')
  await cache.invalidate(); await write
  assert.equal(await cache.read('old.json'), null)
  await cache.write('new.json', 'new')
  assert.equal((await cache.read('new.json'))?.toString(), 'new')
})

test('表情目录复用本地缓存；网络异常保留已知梗表情', async t => {
  const root = directory(t), cache = new BoundedFileCache(root, 'cache/emoticons', 4096, 86400_000, 32)
  await cache.write('room-84452.json', JSON.stringify({ updatedAt: Date.now(), items: parseRoomEmoticons(memeResponse, emptyResponse) }))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('offline') })
  const service = new EmoticonService(root, () => {})
  await service.activate('84452')
  assert.equal(requests, 0)
  assert.ok(service.snapshot().items.some(item => item.code === '菜就多练'))
  await service.invalidateCache()
  await cache.write('room-84452.json', JSON.stringify({ updatedAt: Date.now() - 7 * 3600_000, items: parseRoomEmoticons(memeResponse, emptyResponse) }))
  await service.activate('84452')
  assert.equal(requests, 2)
  assert.ok(service.snapshot().items.some(item => item.code === '菜就多练'))
})

test('换房间时丢弃上一间迟到的表情响应，不跨房间写入或显示', async t => {
  const root = directory(t), responses: { url: string; resolve: (value: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: string) => new Promise<Response>(resolveResponse => { responses.push({ url, resolve: resolveResponse }) }))
  const service = new EmoticonService(root, () => {})
  const first = service.activate('111')
  for (let i = 0; i < 100 && responses.length < 2; i++) await new Promise(done => setTimeout(done, 5))
  assert.equal(responses.length, 2)
  const second = service.activate('222')
  for (let i = 0; i < 100 && responses.length < 4; i++) await new Promise(done => setTimeout(done, 5))
  assert.equal(responses.length, 4)
  for (const entry of responses.filter(item => item.url.endsWith('222'))) entry.resolve(Response.json(emptyResponse))
  await second
  for (const entry of responses.filter(item => item.url.endsWith('111'))) entry.resolve(Response.json(memeResponse))
  await first
  assert.equal(service.snapshot().roomId, '222')
  assert.equal(service.snapshot().items.some(item => item.source === 'meme'), false)
  assert.equal(existsSync(join(root, 'cache/emoticons/room-111.json')), false)
  assert.ok(existsSync(join(root, 'cache/emoticons/room-222.json')))
})
