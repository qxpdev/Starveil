import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { CachePaths, ownsCacheDirectory, prepareCacheDirectory } from '../src/main/cachePaths'
import { CacheManager } from '../src/main/cacheManager'
import { removeCacheFiles, scanCacheDirectory } from '../src/main/cacheFiles'
import { ConfigStore } from '../src/main/configStore'
import { EmoticonService } from '../src/main/emoticonService'
import { DEFAULT_CONFIG, mergeConfig } from '../src/shared/config'

function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'xingmu-path-test-'))
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

function put(root: string, child: string, content = 'cache'): string {
  const file = join(root, child)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

test('切换缓存位置先保存，下次启动才启用专用子目录，原配置不迁移', t => {
  const root = directory(t), data = join(root, '配置'), parent = join(root, '缓存磁盘')
  const store = new ConfigStore(data)
  store.save(mergeConfig({ roomId: '84452', manualGiftPrices: { '20005': { name: '超级火箭', priceYuan: 2000 } } }))
  const bytes = readFileSync(store.filePath)
  const initial = new CachePaths(data)
  assert.equal(initial.activeDirectory, join(data, 'cache'))
  put(parent, '其他文件.txt', '保留')
  const selected = initial.select(parent)
  assert.equal(selected, join(parent, 'xingmu-cache'))
  assert.equal(initial.select(selected), selected)
  assert.equal(initial.info(selected).restartRequired, true)
  assert.equal(initial.activeDirectory, join(data, 'cache'))
  assert.deepEqual(readFileSync(store.filePath), bytes)
  store.save({ ...store.load(), cacheDirectory: selected })
  const restarted = new CachePaths(data, new ConfigStore(data).load().cacheDirectory)
  assert.equal(restarted.activeDirectory, selected)
  assert.equal(restarted.info(selected).restartRequired, false)
  assert.deepEqual(new Set(restarted.directories()), new Set([selected, join(data, 'cache')]))
  assert.equal(readFileSync(join(parent, '其他文件.txt'), 'utf8'), '保留')
  assert.equal(store.load().roomId, '84452')
  assert.equal(store.load().manualGiftPrices['20005']?.priceYuan, 2000)
})

test('自定义路径不可用时回退默认位置，不改掉保存的路径与其他设置', t => {
  const root = directory(t), data = join(root, 'profile')
  const blocker = put(root, '不可写入的路径', '文件')
  const selected = join(blocker, 'xingmu-cache')
  const store = new ConfigStore(data)
  store.save(mergeConfig({ cacheDirectory: selected, edgeStatusMode: 'always', edgeGiftTopHoldSec: 9 }))
  const before = readFileSync(store.filePath)
  const paths = new CachePaths(data, store.load().cacheDirectory)
  assert.equal(paths.activeDirectory, join(data, 'cache'))
  assert.match(paths.notice, /暂不可用/)
  assert.equal(paths.info(selected).configuredDirectory, selected)
  assert.equal(paths.info(selected).restartRequired, true)
  assert.deepEqual(readFileSync(store.filePath), before)
  assert.equal(store.load().edgeGiftTopHoldSec, 9)
  assert.equal(readFileSync(blocker, 'utf8'), '文件')
})

test('缓存路径拒绝相对路径、网络共享、配置祖先和统计目录', t => {
  const root = directory(t), data = join(root, 'profile')
  mkdirSync(data)
  for (const target of ['relative/cache', '\\\\server\\share', root, data, join(data, 'statistics', 'xingmu-cache')]) {
    assert.throws(() => prepareCacheDirectory(data, target), /本机|覆盖/)
  }
  const linked = join(root, 'link')
  symlinkSync(data, linked, 'junction')
  assert.throws(() => prepareCacheDirectory(data, join(linked, 'xingmu-cache')), /链接/)
  assert.equal(ownsCacheDirectory(data, join(linked, 'cache')), false)
})

test('非空目标和其他配置所有的缓存不能被接管，归属标识保持不变', t => {
  const root = directory(t), a = join(root, 'profile-a'), b = join(root, 'profile-b')
  mkdirSync(a); mkdirSync(b)
  const paths = new CachePaths(a)
  const custom = paths.select(join(root, 'shared'))
  const marker = readFileSync(join(custom, '.xingmu-cache.json'))
  assert.throws(() => prepareCacheDirectory(b, custom), /其他数据|另一份/)
  assert.equal(ownsCacheDirectory(b, custom), false)
  assert.deepEqual(readFileSync(join(custom, '.xingmu-cache.json')), marker)
  const occupied = put(root, 'occupied/xingmu-cache/用户文档.txt', '用户内容')
  assert.throws(() => paths.select(join(root, 'occupied')), /其他数据/)
  assert.equal(readFileSync(occupied, 'utf8'), '用户内容')
})

test('清理覆盖当前与已知旧缓存，保留各目录中的配置、正文、标识和未知文件', async t => {
  const root = directory(t), data = join(root, 'profile')
  mkdirSync(data)
  const initial = new CachePaths(data), old = initial.select(join(root, 'old'))
  const oldPaths = new CachePaths(data, old), active = oldPaths.select(join(root, 'new'))
  const paths = new CachePaths(data, active), defaults = join(data, 'cache')
  const disposable: string[] = []
  const kept: [string, Buffer][] = []
  for (const path of [defaults, old, active]) {
    for (const child of ['chromium/Cache/Cache_Data/a', 'chromium/Code Cache/js/a', 'chromium/GPUCache/a',
      'avatars/a.png', 'emoticons/a.json', 'logs/a.log', 'crash-dumps/a.dmp']) disposable.push(put(path, child))
    for (const child of ['chromium/Local Storage/preferences', 'chromium/Network/Cookies', 'unmanaged/my.xlsx']) {
      const file = put(path, child, '保留' + child); kept.push([file, readFileSync(file)])
    }
    if (path !== defaults) { const marker = join(path, '.xingmu-cache.json'); kept.push([marker, readFileSync(marker)]) }
  }
  for (const child of ['config.json', 'config.json.bak', 'statistics/2026-09-07.json', 'statistics/danmaku/2026-09-07.jsonl']) {
    const file = put(data, child, '保留' + child); kept.push([file, readFileSync(file)])
  }
  const unknown = join(root, 'unknown')
  const unknownFile = put(unknown, 'avatars/用户文件.png', 'keep')
  writeFileSync(join(data, 'cache-paths.json'), JSON.stringify([...paths.directories(), unknown]))
  const reloaded = new CachePaths(data, active)
  kept.push([join(data, 'cache-paths.json'), readFileSync(join(data, 'cache-paths.json'))])
  assert.equal(reloaded.directories().includes(unknown), false)
  const calls: string[] = []
  const clearActive = async (child: string): Promise<void> => {
    calls.push(child)
    await removeCacheFiles(active, (await scanCacheDirectory(active, child)).files)
  }
  const manager = new CacheManager(data, { clearCache: () => clearActive('chromium/Cache'),
    clearCodeCaches: () => clearActive('chromium/Code Cache') }, active, () => reloaded.directories())
  const inventory = await manager.inventory()
  assert.deepEqual(new Set(inventory.directories), new Set([active, old, defaults]))
  assert.equal(inventory.bytes, disposable.length * 5)
  const result = await manager.clear()
  assert.equal(result.canceled, false)
  if (result.canceled) return
  assert.equal(result.inventory.bytes, 0)
  assert.deepEqual(calls, ['chromium/Cache', 'chromium/Code Cache'])
  for (const file of disposable) assert.equal(existsSync(file), false, file)
  for (const [file, contents] of kept) assert.deepEqual(readFileSync(file), contents, file)
  assert.equal(readFileSync(unknownFile, 'utf8'), 'keep')
})

test('房间表情目录写入当前缓存位置，配置目录不产生重复图片缓存', async t => {
  const root = directory(t), data = join(root, 'profile'), cache = join(root, 'cache-disk')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 0, data: null }))
  const service = new EmoticonService(data, () => {}, cache)
  await service.activate('84452')
  assert.equal(existsSync(join(cache, 'emoticons', 'room-84452.json')), true)
  assert.equal(existsSync(join(data, 'cache')), false)
})

test('新设置保存后可完整恢复，非法透明度和停留时间限制在可用范围', t => {
  const root = directory(t), store = new ConfigStore(root)
  const options = { giftLayout: 'card' as const, giftAmountScale: 1.5, giftOpacity: .45, giftBackgroundOpacity: .15, giftBannerOpacity: .6,
    edgeGiftTopHoldSec: 12, edgeMessageGap: 5, edgeStatusMode: 'always' as const, edgeStatusPosition: 'bottom' as const,
    statusOpacity: .8, statusBackgroundOpacity: .3, statusFontSize: 18, cacheDirectory: join(root, 'cache-choice') }
  store.save(mergeConfig(options))
  const loaded = new ConfigStore(root).load()
  for (const [key, value] of Object.entries(options)) assert.equal(loaded[key as keyof typeof options], value)
  const limited = mergeConfig({ giftOpacity: -1, giftBackgroundOpacity: 5, statusFontSize: 100,
    edgeGiftTopHoldSec: Infinity, edgeMessageGap: -1, giftBannerOpacity: NaN })
  assert.equal(limited.giftOpacity, .05)
  assert.equal(limited.giftBackgroundOpacity, 1)
  assert.equal(limited.statusFontSize, 24)
  assert.equal(limited.edgeGiftTopHoldSec, 4)
  assert.equal(limited.edgeMessageGap, 0)
  assert.equal(limited.giftBannerOpacity, DEFAULT_CONFIG.giftBannerOpacity)
})
