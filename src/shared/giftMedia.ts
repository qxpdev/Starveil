import type { DanmakuPayload, GiftMetadata, GiftBannerCatalog } from './types'

/** 官方媒体只允许斗鱼 CDN；拒绝凭据、端口和外部跳转目标。 */
export function officialGiftUrl(value: unknown, prefix = 'https://gfs-op.douyucdn.cn/dygift'): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:/i, 'https:'), `${prefix.replace(/\/$/, '')}/`)
    // 接口中的 /2024/... 相对 picUrlPrefix，而非域名根路径。
    if (raw.startsWith('/') && !raw.startsWith('//')) return officialGiftUrl(prefix.replace(/\/$/, '') + raw)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (url.hostname === 'douyucdn.cn' || url.hostname.endsWith('.douyucdn.cn'))) return url.href
  } catch { /* 无效来源保持内置展示 */ }
  return undefined
}

export function officialGiftVideoUrl(value: unknown): string | undefined {
  const url = officialGiftUrl(value)
  return url && url.length <= 2048 && new URL(url).pathname.toLowerCase().endsWith('.mp4') ? url : undefined
}

/** 与官方网页一致：eic 选效果，bnidv2 选礼物条。缺少编号时不随意播放目录里的首个效果。 */
export function resolveOfficialGiftMedia(payload: DanmakuPayload, meta: GiftMetadata | undefined, banners: GiftBannerCatalog):
  Pick<DanmakuPayload, 'giftVideo' | 'giftBanner' | 'giftStaticImage'> {
  const effect = payload.giftEffectId ? meta?.effects?.[payload.giftEffectId] : undefined
  const banner = payload.giftBannerId && payload.giftBannerId !== '0'
    ? (effect?.bannerId === payload.giftBannerId ? effect.banner : undefined) || banners[payload.giftBannerId] : undefined
  return {
    // 未取得皮肤专属目录时，不把基础款动画误作本次皮肤特效。
    giftVideo: payload.giftSkinId && payload.giftSkinId !== '0' ? undefined : officialGiftVideoUrl(effect?.video),
    giftBanner: officialGiftUrl(banner),
    giftStaticImage: officialGiftUrl(meta?.staticImage)
  }
}
