import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { atomicWrite } from './configStore'
import { APP_NAME } from './appMetadata'
import type { CacheLocationInfo } from '../shared/storage'

// 目录归属沿用旧标识，确保 Starveil 可以识别、清理已有缓存。
const MARKER = '.xingmu-cache.json'
const normalize = (path: string): string => resolve(path).toLowerCase()
const within = (parent: string, child: string): boolean => normalize(child) === normalize(parent) || normalize(child).startsWith(normalize(parent) + sep)
const ownerOf = (directory: string): string => createHash('sha256').update(normalize(directory)).digest('hex')

/** 缓存路径必须是本机目录，整条路径不能经过目录链接。 */
function checkPath(directory: string): void {
  if (!isAbsolute(directory) || directory.startsWith('\\\\') || /[\x00-\x1f]/.test(directory)) throw new Error('请选择本机磁盘上的缓存目录。')
  const target = resolve(directory), root = parse(target).root
  let cursor = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) continue
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new Error('缓存路径不能经过目录链接。')
    if (!stat.isDirectory()) throw new Error('缓存路径中有同名文件，请选择其他目录。')
  }
}

export function ownsCacheDirectory(dataDirectory: string, directory: string): boolean {
  try {
    checkPath(directory)
    if (normalize(directory) === normalize(join(dataDirectory, 'cache'))) return true
    const marker = join(directory, MARKER)
    if (lstatSync(marker).isSymbolicLink()) return false
    const value = JSON.parse(readFileSync(marker, 'utf8'))
    return value?.application === 'xingmu' && value?.version === 1 && value?.owner === ownerOf(dataDirectory)
  } catch { return false }
}

export function prepareCacheDirectory(dataDirectory: string, directory: string): string {
  checkPath(directory)
  const target = resolve(directory), defaultRoot = join(dataDirectory, 'cache')
  if (within(target, dataDirectory) || within(join(dataDirectory, 'statistics'), target)) throw new Error('缓存不能覆盖配置目录或放在统计记录中。')
  const legacy = normalize(target) === normalize(defaultRoot)
  if (existsSync(target) && !legacy && !ownsCacheDirectory(dataDirectory, target) && readdirSync(target).length) {
    throw new Error('此处的 xingmu-cache 文件夹包含其他数据，请选择其他位置。')
  }
  mkdirSync(target, { recursive: true })
  const marker = join(target, MARKER)
  if (!legacy && existsSync(marker)) {
    if (lstatSync(marker).isSymbolicLink()) throw new Error('缓存标识不能是链接。')
    const value = JSON.parse(readFileSync(marker, 'utf8'))
    if (value?.owner !== ownerOf(dataDirectory) || value?.application !== 'xingmu' || value?.version !== 1) throw new Error(`此缓存目录属于另一份 ${APP_NAME} 配置，请选择其他位置。`)
  } else if (!legacy) writeFileSync(marker, JSON.stringify({ application: 'xingmu', version: 1, owner: ownerOf(dataDirectory) }), { flag: 'wx' })
  const probe = join(target, `.write-check-${randomUUID()}`)
  writeFileSync(probe, 'ok', { flag: 'wx' })
  unlinkSync(probe)
  return target
}

/** 路径清单属于配置数据；切换位置后，已知的旧缓存仍可在确认后清理。 */
export class CachePaths {
  readonly activeDirectory: string
  readonly defaultDirectory: string
  readonly notice: string
  private history: string[] = []

  constructor(private readonly dataDirectory: string, configured = '') {
    this.defaultDirectory = join(dataDirectory, 'cache')
    let active: string, notice = ''
    try { active = prepareCacheDirectory(dataDirectory, configured || this.defaultDirectory) }
    catch (error) {
      if (!configured) throw error
      active = prepareCacheDirectory(dataDirectory, this.defaultDirectory)
      notice = `自定义缓存目录暂不可用，本次使用默认位置。${error instanceof Error ? error.message : String(error)}`
    }
    this.activeDirectory = active
    const file = join(dataDirectory, 'cache-paths.json')
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(raw)) this.history = raw.filter(item => typeof item === 'string' && ownsCacheDirectory(dataDirectory, item)).slice(0, 128)
    } catch { /* 首次启动没有历史目录 */ }
    this.history = [...new Map([active, this.defaultDirectory, ...this.history].map(path => [normalize(path), path])).values()]
    try { atomicWrite(file, JSON.stringify(this.history, null, 2) + '\n') }
    catch { notice += ' 旧缓存位置清单未能保存。' }
    this.notice = notice.trim()
  }

  directories(): string[] { return this.history.filter(path => ownsCacheDirectory(this.dataDirectory, path)) }

  select(parent: string): string {
    checkPath(parent)
    // 在用户选中的位置创建独立子目录，不把整个磁盘或其他文件夹作为清理目标。
    return prepareCacheDirectory(this.dataDirectory, ownsCacheDirectory(this.dataDirectory, parent) && normalize(parent) !== normalize(this.defaultDirectory)
      ? parent : join(parent, 'xingmu-cache'))
  }

  info(configured: string): CacheLocationInfo {
    const next = configured || this.defaultDirectory
    return { currentDirectory: this.activeDirectory, configuredDirectory: next, defaultDirectory: this.defaultDirectory,
      restartRequired: normalize(next) !== normalize(this.activeDirectory), custom: Boolean(configured), notice: this.notice }
  }
}
