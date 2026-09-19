import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MIB = 1024 * 1024
export const HTTP_CACHE_BYTES = 128 * MIB
export const AVATAR_CACHE_BYTES = 8 * MIB
export const EMOTICON_CACHE_BYTES = 4 * MIB

/** 只操作指定根目录中的普通文件；拒绝中途的 junction / symlink。 */
export async function managedPath(root: string, child: string): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('已跳过缓存根目录链接')
  const base = await realpath(root)
  const destination = resolve(base, child)
  const local = relative(base, destination)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('缓存路径越界')
  let cursor = base
  for (const part of local.split(sep)) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('已跳过缓存目录中的链接')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return destination
}

export interface CacheFile { path: string; bytes: number; modified: number }
export interface CacheScan { files: CacheFile[]; directories: string[]; bytes: number; skipped: number }

export async function scanCacheDirectory(root: string, directory: string): Promise<CacheScan> {
  const result: CacheScan = { files: [], directories: [], bytes: 0, skipped: 0 }
  const pending = [directory]
  let visited = 0
  while (pending.length) {
    const child = pending.pop()!
    if (++visited > 100_000) { result.skipped += pending.length + 1; break }
    try {
      const target = await managedPath(root, child)
      const stat = await lstat(target)
      if (stat.isDirectory()) {
        result.directories.push(child)
        for (const name of await readdir(target)) pending.push(join(child, name))
      } else if (stat.isFile()) {
        result.files.push({ path: child, bytes: stat.size, modified: stat.mtimeMs })
        result.bytes += stat.size
      } else result.skipped++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.skipped++
    }
  }
  return result
}

export async function removeEmptyCacheDirectories(root: string, directories: readonly string[]): Promise<void> {
  for (const child of [...directories].reverse()) {
    try { await rmdir(await managedPath(root, child)) }
    catch { /* 保留非空目录、正在使用的目录和链接 */ }
  }
}

/** 不递归删除整个 profile，逐项复核后只 unlink 普通缓存文件。 */
export async function removeCacheFiles(root: string, files: readonly CacheFile[]): Promise<{ bytes: number; skipped: number }> {
  let bytes = 0, skipped = 0
  for (const file of files) {
    try {
      const target = await managedPath(root, file.path)
      const stat = await lstat(target)
      if (!stat.isFile() || stat.mtimeMs !== file.modified || stat.size !== file.bytes) { skipped++; continue }
      await unlink(target)
      bytes += file.bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped++
    }
  }
  return { bytes, skipped }
}

/** 小型目录缓存；过期、数量和总容量同时受限，不下载或保存整套表情图片。 */
export class BoundedFileCache {
  private work: Promise<void> = Promise.resolve()
  private generation = 0
  constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  invalidate(): Promise<void> { this.generation++; return this.work.catch(() => {}) }
  private keyPath(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(key)) throw new Error('无效的缓存键')
    return join(this.directory, key)
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      const file = await managedPath(this.root, this.keyPath(key))
      const info = await lstat(file)
      if (!info.isFile() || info.size > this.maxBytes || this.now() - info.mtimeMs > this.maxAgeMs) return null
      return await readFile(file)
    } catch { return null }
  }

  write(key: string, data: Buffer | string): Promise<void> {
    const child = this.keyPath(key), generation = this.generation
    if (Buffer.byteLength(data) > this.maxBytes) return Promise.resolve()
    this.work = this.work.catch(() => {}).then(async () => {
      if (generation !== this.generation) return
      const directory = await managedPath(this.root, this.directory)
      await mkdir(directory, { recursive: true })
      const destination = await managedPath(this.root, child)
      const temporary = await managedPath(this.root, `${child}.tmp`)
      let created = false
      try {
        // wx 不覆盖已有临时文件或链接；中断遗留文件由容量清理处理。
        await writeFile(temporary, data, { flag: 'wx' })
        created = true
        if (generation !== this.generation) return
        await managedPath(this.root, child)
        await rename(temporary, destination)
      } finally {
        if (created) {
          try { await unlink(await managedPath(this.root, `${child}.tmp`)) } catch { /* 已替换或文件正在使用 */ }
        }
      }
      await this.prune()
    })
    return this.work
  }

  async prune(): Promise<void> {
    const scan = await scanCacheDirectory(this.root, this.directory)
    const files = scan.files.sort((a, b) => b.modified - a.modified)
    let bytes = 0, count = 0
    const stale: CacheFile[] = []
    for (const file of files) {
      if (file.path.endsWith('.tmp') || this.now() - file.modified > this.maxAgeMs ||
        count >= this.maxEntries || bytes + file.bytes > this.maxBytes) stale.push(file)
      else { bytes += file.bytes; count++ }
    }
    await removeCacheFiles(this.root, stale)
  }
}
