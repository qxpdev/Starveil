import { app } from 'electron'
import { join, resolve } from 'node:path'

let runtimeCacheDirectory: string | undefined
export function setRuntimeCacheDirectory(directory: string): void { runtimeCacheDirectory = directory }
export function getRuntimeCacheDirectory(): string { return runtimeCacheDirectory || join(getWritableDataDirectory(), 'cache') }

/** 固定到当前 Windows 账户；Starveil 改名后继续沿用原目录，避免丢失设置与记录。 */
export function getWritableDataDirectory(): string {
  const explicit = app.commandLine.getSwitchValue('user-data-dir').trim()
  return explicit ? resolve(explicit) : join(app.getPath('appData'), 'douyu-danmaku-overlay')
}

/** 只在新位置还没有有效配置时导入旧配置；原文件保留以便回退。 */
export function getLegacyConfigPaths(): string[] {
  if (app.commandLine.hasSwitch('user-data-dir')) return []
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
  return [...new Set([
    ...(portableDir ? [
      join(portableDir, 'data', 'config.json'),
      join(portableDir, 'data.douyu-danmaku-overlay', 'config.json')
    ] : []),
    join(app.getPath('appData'), '斗鱼弹幕飘屏', 'config.json'),
    join(app.getPath('appData'), '星幕', 'config.json'),
    join(app.getPath('userData'), 'config.json')
  ])]
}
