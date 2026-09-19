export interface ConfigStorageInfo {
  directory: string
  filePath: string
  savedAt: number | null
  notice: string | null
}

export interface CacheGroupInfo {
  id: string
  name: string
  description: string
  bytes: number
  files: number
}

export interface CacheInventory {
  directory: string
  directories: string[]
  historyBytes: number
  groups: CacheGroupInfo[]
  bytes: number
  protectedItems: readonly string[]
  skipped: number
}

export interface CacheLocationInfo {
  currentDirectory: string
  configuredDirectory: string
  defaultDirectory: string
  restartRequired: boolean
  custom: boolean
  notice: string
}

export type CacheClearResult = { canceled: true } | {
  canceled: false
  releasedBytes: number
  skipped: number
  warnings: string[]
  inventory: CacheInventory
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
