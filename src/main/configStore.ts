import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mergeConfig, type AppConfig } from '../shared/config'
import type { ConfigStorageInfo } from '../shared/storage'

export function parseConfigFile(raw: string): AppConfig {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('配置文件内容不是设置对象')
  }
  const merged = mergeConfig(parsed)
  if (!Object.prototype.hasOwnProperty.call(parsed, 'overlayEnabled')) merged.overlayEnabled = true
  return merged
}

/** 同一目录写临时文件并刷盘后原子替换，避免退出/断电留下半个 JSON。 */
export function atomicWrite(filePath: string, text: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, filePath)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (created && existsSync(temporary)) unlinkSync(temporary)
  }
}

export class ConfigStore {
  readonly filePath: string
  private savedAt: number | null = null
  private notice: string | null = null

  constructor(directory: string, private readonly legacyPaths: string[] = []) {
    this.filePath = join(directory, 'config.json')
  }

  get info(): ConfigStorageInfo {
    return { directory: dirname(this.filePath), filePath: this.filePath, savedAt: this.savedAt, notice: this.notice }
  }

  load(): AppConfig {
    const candidates = [...new Set([this.filePath, `${this.filePath}.bak`, ...this.legacyPaths])]
    let damaged = false
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      let config: AppConfig
      try {
        config = parseConfigFile(readFileSync(candidate, 'utf8'))
      } catch {
        damaged = true
        continue
      }
      this.savedAt = statSync(candidate).mtimeMs
      if (candidate !== this.filePath) {
        try {
          this.save(config)
          this.notice = candidate === `${this.filePath}.bak`
            ? '已从备份恢复设置。'
            : '已导入旧版设置；原配置文件仍保留。'
        } catch (error) {
          this.notice = `已读取旧设置，但尚未保存到新位置：${String(error)}`
        }
      }
      return config
    }
    if (damaged) this.notice = '配置文件无法读取，且没有可用备份；当前使用默认设置。'
    return mergeConfig(undefined)
  }

  save(config: AppConfig): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const text = `${JSON.stringify(config, null, 2)}\n`
      let backupText = text
      if (existsSync(this.filePath)) {
        try {
          const previous = readFileSync(this.filePath, 'utf8')
          parseConfigFile(previous)
          backupText = previous
        } catch {
          // 不把损坏的文件覆盖到有效备份上。
          if (existsSync(`${this.filePath}.bak`)) backupText = readFileSync(`${this.filePath}.bak`, 'utf8')
        }
      }
      atomicWrite(`${this.filePath}.bak`, backupText)
      atomicWrite(this.filePath, text)
      this.savedAt = Date.now()
      this.notice = null
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.notice = `设置未保存：${detail}`
      throw new Error(`设置未保存，请检查配置目录的写入权限或可用空间。${detail}`)
    }
  }
}
