/**
 * 弹幕 renderer 使用的斗鱼原生用户标识资源。
 * 资源仍由斗鱼 CDN 提供，本地仅生成安全、确定的 URL。
 */

export const DIAMOND_ICON_URL =
  'https://sta-op.douyucdn.cn/douyu/2021/08/05/02304a1c04587e43ac626ce5ce07d935.png'

export const ROOM_ADMIN_ICON_URL =
  'https://shark2.douyucdn.cn/front-publish/live-player-aside-master/assets/fonts/room-admin_abc5a2e.svg'

const CURRENT_FANS_MEDAL_BACKGROUNDS: readonly { max: number; url: string }[] = [
  {
    max: 5,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/03/07/e99a0fabd6a605665d3ce6a0f26ba587/com_bg_1.png'
  },
  {
    max: 10,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/03/07/00098c7b09fbfd019975e912bc627d68/com_bg_6.png'
  },
  {
    max: 15,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/a97a927e659f2313a2183d5731224f76/com_bg_11.png'
  },
  {
    max: 20,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/19f7c6577b9a5c015317f380bfa7a0b7/com_bg_16.png'
  },
  {
    max: 25,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/445dd67c8c40474e34207bb1bcb3527c/com_bg_21.png'
  },
  {
    max: 30,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/c1fb3830f35be9a48f454e43278dbd8d/com_bg_26.png'
  },
  {
    max: 35,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/b61836a978a733ab9832981d20191ddd/com_bg_31.webp'
  },
  {
    max: 40,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/15dbc4f862059665eee16c01f9ced823/com_bg_36.webp'
  },
  {
    max: 45,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/7fee1c27260ce7e4ca9dc95bdd7f47b6/com_bg_41.webp'
  },
  {
    max: 50,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/01/11/e8355f7e4b63779ea4ff5af3e530baba/com_bg_46.webp'
  },
  {
    max: 60,
    url: 'https://sta-op.douyucdn.cn/douyu/2024/08/16/285f8c16b70f453b934a543593f8f1c2/com_bg_51.webp'
  }
]

/** 返回 FansMedal 组件按等级段选用的斗鱼粉丝牌底图。 */
export function nativeFansMedalBackgroundUrl(level: number): string {
  const safeLevel = Math.min(60, Math.max(1, Math.round(level)))
  return (
    CURRENT_FANS_MEDAL_BACKGROUNDS.find((entry) => safeLevel <= entry.max)?.url ??
    CURRENT_FANS_MEDAL_BACKGROUNDS[0]!.url
  )
}

/** UserLevel 组件使用的斗鱼 Web Light 等级资源（1～151 级）。 */
export function nativeUserLevelUrl(level: number): string {
  const safeLevel = Math.min(151, Math.max(1, Math.round(level)))
  return `https://shark2.douyucdn.cn/front-publish/static-file-master/userLevelIconV6/web-light/newm3_lv${safeLevel}.png?v=1.2`
}

const NOBLE_RESOURCE_PREFIX = 'https://res.douyucdn.cn/resource/'

/** 斗鱼原生贵族图标，索引即弹幕协议里的 nl 等级。 */
export const NOBLE_ICON_URLS: Readonly<Record<number, string>> = {
  1: NOBLE_RESOURCE_PREFIX + '2018/06/21/common/1b45cf2fb1c6cddbbd95a569f399b26e.png',
  2: NOBLE_RESOURCE_PREFIX + '2018/06/22/common/a54f50c3e6a853bef02d35395f5798ab.png',
  3: NOBLE_RESOURCE_PREFIX + '2018/06/22/common/ad8828ca9b9a85be571b3b28706047ed.png',
  4: NOBLE_RESOURCE_PREFIX + '2018/06/22/common/988709683569f83cefb69dfe1703f710.png',
  5: NOBLE_RESOURCE_PREFIX + '2018/06/22/common/098f64b26aab4307f0943ce188b962b8.png',
  6: NOBLE_RESOURCE_PREFIX + '2018/06/21/common/fd2b69eb629abcd703fa152c66faae52.gif',
  7: NOBLE_RESOURCE_PREFIX + '2018/06/22/common/93e7f66facdaaa30cf5634f92560e351.png',
  8: NOBLE_RESOURCE_PREFIX + '2019/08/09/common/3d994a081e5384de14e6893d1d8b94c5.gif',
  9: NOBLE_RESOURCE_PREFIX + '2019/08/15/common/4e85776071ffbae2867bb9d116e9a43c.gif'
}

export function normalizeNativeLevel(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.min(151, parsed)
}

export function normalizeNativeFansLevel(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.min(60, parsed)
}
