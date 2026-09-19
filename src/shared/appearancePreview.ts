import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from './config'

const appearanceKeys = [
  'fontSize', 'avatarSize', 'fansMedalScale', 'userLevelScale', 'nicknameScale',
  'letterSpacing', 'lineHeight', 'lanePadding', 'opacity', 'danmakuBgColor',
  'danmakuBgOpacity', 'overlayBackgroundOpacity', 'usernameTextColor', 'giftTextColor',
  'commonTextColor', 'minorTextColor', 'textShadowColor', 'motionEnabled', 'edgeWidth',
  'edgeBottomPercent', 'speedPxPerSec', 'edgeMessageGap', 'giftOpacity', 'giftBackgroundOpacity',
  'giftBannerOpacity', 'giftAmountScale', 'statusOpacity', 'statusBackgroundOpacity', 'statusFontSize'
] as const satisfies readonly (keyof AppConfig)[]

export type AppearancePatch = Partial<Pick<AppConfig, typeof appearanceKeys[number]>>

/** 预览只接收外观字段，不能借此切换房间、统计、消息过滤或窗口开关。 */
export function pickAppearancePatch(value: unknown): AppearancePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  return Object.fromEntries(appearanceKeys.filter(key =>
    Object.prototype.hasOwnProperty.call(input, key) &&
    typeof input[key] === typeof DEFAULT_CONFIG[key] &&
    (typeof input[key] !== 'number' || Number.isFinite(input[key]))
  ).map(key => [key, input[key]])) as AppearancePatch
}

/** 未保存的外观只叠加到弹幕窗口，不修改持久配置。 */
export class AppearancePreview {
  private patch: AppearancePatch = {}

  config(saved: AppConfig): AppConfig { return { ...saved, ...this.patch } }

  update(saved: AppConfig, input: unknown): AppConfig {
    const partial = pickAppearancePatch(input)
    const normalized = mergeConfig({ ...saved, ...this.patch, ...partial })
    for (const key of Object.keys(partial) as (keyof AppearancePatch)[]) {
      Object.assign(this.patch, { [key]: normalized[key] })
    }
    return this.config(saved)
  }

  acceptSaved(saved: AppConfig, input: unknown): void {
    for (const key of Object.keys(pickAppearancePatch(input)) as (keyof AppearancePatch)[]) {
      // 较早的保存完成时，不能把后来拖到的新数值覆盖回去。
      if (this.patch[key] === saved[key]) delete this.patch[key]
    }
  }

  clear(): void { this.patch = {} }
}
