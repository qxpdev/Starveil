/** 飘屏窗口中的聊天、礼物和进场消息。 */
export type DanmakuPayloadKind = 'danmaku' | 'gift' | 'welcome' | 'fans'

/** 斗鱼礼物广播的分类。 */
export type DouyuGiftKind = 'gift' | 'diamond' | 'noble' | 'fans' | 'unknown'

/** gpf=0 使用礼物 gfid；gpf=1 使用道具 pid。两套编号不能混用。 */
export type GiftCatalogType = 'gift' | 'prop'

/** 官方效果编号来自本次广播 eic，不按礼物价值或数量猜测触发效果。 */
export interface OfficialGiftEffect { video?: string; banner?: string; bannerId?: string }
export type GiftBannerCatalog = Record<string, string>

/** 推送到飘屏窗口的单条弹幕或礼物消息 */
export interface DanmakuPayload {
  /** 未提供时按普通弹幕处理，兼容旧版配置/消息。 */
  kind?: DanmakuPayloadKind
  /** 斗鱼 uid；用于人数去重、用户送礼归属和历史弹幕查证。 */
  userId?: string
  nick: string
  text: string
  /** 经官方高能广播或其公开详情取得的文字。 */
  isHighEnergy?: boolean
  /** 斗鱼弹幕颜色等级（`col` 字段），如 "1"～"6" */
  col?: string
  /** 斗鱼用户头像标识（`ic` 字段），也可直接传入完整头像 URL */
  avatar?: string
  /** 斗鱼用户等级（`level` 字段） */
  level?: string
  /** 粉丝牌名称（`bnn` 字段） */
  fansName?: string
  /** 粉丝牌等级（`bl` 字段） */
  fansLevel?: string
  /** 用户身份标记 */
  isDiamond?: boolean
  isNoble?: boolean
  /** 斗鱼贵族等级（`nl` 字段，1～9）；用于显示原生贵族图标。 */
  nobleLevel?: number
  isRoomAdmin?: boolean
  isSuper?: boolean
  isVip?: boolean
  /** 礼物名称（斗鱼 dgb/gfn 等字段）；kind 为 gift 时使用。 */
  giftName?: string
  /** 普通礼物、钻粉、贵族、粉丝牌升级或未知礼物。 */
  giftKind?: DouyuGiftKind
  /** 本次礼物数量；kind 为 gift 时使用。 */
  giftCount?: number
  /** 斗鱼连击累计次数（hits 字段）。 */
  giftHits?: number
  /** 礼物 ID，便于调试或后续补充礼物图片。 */
  giftId?: string
  fallbackGiftId?: string
  giftCatalogType?: GiftCatalogType
  /** 道具广播原始 gfid，仅用于核对抽奖来源，绝不用于奖励查价。 */
  sourceGiftId?: string
  /** 若协议提供礼物图片地址则使用，否则渲染器显示内置礼物图标。 */
  giftImage?: string
  giftStaticImage?: string
  giftEffectId?: string
  giftBannerId?: string
  giftSkinId?: string
  /** 只接受官方目录中与本次广播对应的素材。 */
  giftVideo?: string
  giftBanner?: string
  /** 礼物单价（元）；来自斗鱼房间礼物清单，用于高亮礼物卡片。 */
  giftPrice?: number
  giftPriceSource?: 'platform' | 'manual'
  /** 是否已确认免费；来源于同一礼物目录并不代表免费。 */
  giftIsFree?: boolean
  /** 抽奖道具本身不计价值，等待实际开出的奖励广播。 */
  giftIsLottery?: boolean
  /** 展示层的连续开奖汇总；原始奖励仍逐条进入统计和历史。 */
  lotterySummary?: LotteryGiftSummary
  /** 已知奖池里的奖励，但本次没有足够依据关联具体投入。 */
  lotteryUnmatched?: boolean
}

export interface LotteryGiftSummary {
  inputCount: number
  inputValue: number | null
  rewardCount: number
  rewardValue: number
  unpricedRewardCount: number
  rewards: { name: string; count: number; value: number | null }[]
}

export interface GiftMetadata {
  id: string
  catalogType?: GiftCatalogType
  name: string
  image: string
  staticImage?: string
  effects?: Record<string, OfficialGiftEffect>
  /** 未提供真实价格时为 null，不把占位值或缺失值当作免费。 */
  priceYuan: number | null
  isFree: boolean
  /** 斗鱼 basicInfo.giftType=17 的变幻礼物，不把购买价作为奖励价值。 */
  isLottery?: boolean
  /** 投入单价独立保存，不混入主播收到的奖励价值。 */
  lotteryPriceYuan?: number | null
  /** 从官方玩法配置取得的奖励 pid，用于识别缺少来源 gfid 的结果。 */
  lotteryRewardIds?: string[]
  /** 未标注时来自平台；手动补价不会覆盖平台确认的价格。 */
  priceSource?: 'platform' | 'manual'
}

export interface GiftPricingItem {
  id: string
  catalogType?: GiftCatalogType
  name: string
  count: number
  priceYuan: number | null
  source: 'unknown' | 'manual' | 'platform'
}

export interface GiftPricePatch {
  giftId: string
  catalogType?: GiftCatalogType
  name?: string
  /** null 删除手动补价；0 明确表示免费。 */
  priceYuan: number | null
}

export interface GiftCatalogStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  roomId: string
  count: number
  pricedCount: number
  manualCount: number
  pendingCount: number
  updatedAt: number | null
  detail: string
  pricing: GiftPricingItem[]
}

export interface WindowChromeState { maximized: boolean }

/**
 * 底部状态栏数据。
 *
 * 这些值来自斗鱼 WebSocket 数据：noble_num_info/oni、chatmsg 和
 * dgb；不再调用其他房间信息接口补在线数或关注数。
 */
export interface OverlayStatsPayload {
  noble: number | null
  danmakuUsers: number
  danmakuCount: number
  giftCount: number
  giftValue: number
  unknownGiftCount?: number
  unidentifiedChatCount?: number
  startedAt?: number
  source?: 'live' | 'simulate'
}
