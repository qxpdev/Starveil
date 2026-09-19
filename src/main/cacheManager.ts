import { join, resolve } from 'node:path'
import { scanCacheDirectory, removeCacheFiles, removeEmptyCacheDirectories, managedPath } from './cacheFiles'
import type { CacheInventory, CacheClearResult, CacheGroupInfo } from '../shared/storage'

const graphics = ['GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache']
// Windows 不区分 Cache/cache。旧版只清理 Cache_Data，绝不能把新的统一 cache 根目录一起删掉。
const oldCache = ['Cache/Cache_Data', 'Code Cache', ...graphics, 'blob_storage', 'Shared Dictionary', 'room-avatar-cache']
const groups = [
  { id: 'http', name: '表情、头像与礼物图片缓存', description: '礼物图片、官方礼物条和网页资源，需要时会重新获取。', paths: ['chromium/Cache'] },
  { id: 'code', name: '界面脚本缓存', description: '加速界面启动的临时数据。', paths: ['chromium/Code Cache'] },
  { id: 'graphics', name: '图形与临时缓存', description: '渲染缓存；正在使用的文件可能要下次再清理。', paths: [...graphics, 'blob_storage', 'Shared Dictionary'].map(name => join('chromium', name)) },
  { id: 'avatars', name: '主播头像缓存', description: '已缓存的主播头像，不影响头像设置。', paths: ['avatars'] },
  { id: 'emoticons', name: '斗鱼表情目录缓存', description: '钻粉、梗和房间表情目录，重新连接时可获取。', paths: ['emoticons'] },
  { id: 'diagnostics', name: '诊断日志与崩溃缓存', description: '程序运行产生的临时诊断文件。', paths: ['logs', 'crash-dumps'] },
  { id: 'legacy', name: '旧版本遗留缓存', description: '旧版数据目录中的图片、脚本和图形缓存。', paths: oldCache }
] as const

export const CACHE_PROTECTED_ITEMS = [
  'config.json、配置备份和手动补价',
  '缓存路径设置、目录归属标识与已知位置清单',
  'statistics 中的每日统计、用户与礼物记录',
  '已保存的弹幕正文和导出的 Excel 文件',
  '界面偏好、登录状态及其他非缓存文件'
]

interface CacheSession {
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
}

export class CacheManager {
  private clearing = false
  constructor(private readonly root: string, private readonly session: CacheSession,
    private readonly cacheDirectory = join(root, 'cache'), private readonly knownDirectories: () => string[] = () => [cacheDirectory]) {}

  private locations(group: typeof groups[number]): { root: string; child: string; active: boolean }[] {
    const roots = group.id === 'legacy' ? [this.root] : this.knownDirectories()
    return roots.flatMap(root => group.paths.map(child => ({ root, child,
      active: group.id !== 'legacy' && resolve(root).toLowerCase() === resolve(this.cacheDirectory).toLowerCase() })))
  }

  async inventory(): Promise<CacheInventory> {
    const items: CacheGroupInfo[] = []
    const directories = new Set(this.knownDirectories())
    let skipped = 0
    for (const group of groups) {
      let bytes = 0, files = 0
      for (const location of this.locations(group)) {
        const scan = await scanCacheDirectory(location.root, location.child)
        bytes += scan.bytes; files += scan.files.length; skipped += scan.skipped
        if (group.id === 'legacy' && scan.files.length) directories.add(join(location.root, location.child))
      }
      items.push({ id: group.id, name: group.name, description: group.description, bytes, files })
    }
    const history = await scanCacheDirectory(this.root, 'statistics')
    return { directory: this.cacheDirectory, directories: [...directories], groups: items, historyBytes: history.bytes, bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      protectedItems: CACHE_PROTECTED_ITEMS, skipped }
  }

  async clear(): Promise<CacheClearResult> {
    if (this.clearing) throw new Error('缓存正在清理，请稍候。')
    this.clearing = true
    try {
      const before = await this.inventory()
      let skipped = 0
      const warnings: string[] = []
      for (const group of groups) {
        for (const location of this.locations(group)) {
        try {
          if (location.active && group.id === 'http') {
            await managedPath(location.root, location.child)
            await this.session.clearCache()
          } else if (location.active && group.id === 'code') {
            await managedPath(location.root, location.child)
            await this.session.clearCodeCaches({})
          }
          else {
            const scan = await scanCacheDirectory(location.root, location.child)
            const removed = await removeCacheFiles(location.root, scan.files)
            await removeEmptyCacheDirectories(location.root, scan.directories)
            skipped += scan.skipped + removed.skipped
          }
        } catch { warnings.push(`${group.name}部分文件正在使用或无法访问。`) }
        }
      }
      const inventory = await this.inventory()
      return { canceled: false, releasedBytes: Math.max(0, before.bytes - inventory.bytes), inventory, skipped, warnings }
    } finally { this.clearing = false }
  }
}
