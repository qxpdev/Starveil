export const EDGE_ENTER_MS = 620
export const EDGE_EXIT_MS = 400
// 横向进场也柔和起步，让已有消息上移后再进入文字区域，避免两行短暂交叠。
export const EDGE_ENTER_EASING = 'cubic-bezier(.3, 0, .16, 1)'
export const EDGE_EXIT_EASING = 'cubic-bezier(.55, 0, 1, .45)'
export const EDGE_GAP = 8
export const EDGE_REPLACE_MS = 140

export interface EdgeSlot { top: number; height: number }

/** 按消息顺序紧密排列，最新一条始终贴底；顶部礼物只占自身高度，不留固定空白。 */
export function edgeFlowSlots(heights: readonly number[], available: number, gap = EDGE_GAP): EdgeSlot[] {
  if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(gap) || gap < 0 ||
    heights.some(height => !Number.isFinite(height) || height <= 0)) return []
  const total = heights.reduce((sum, height) => sum + height, 0) + Math.max(0, heights.length - 1) * gap
  if (total > available) return []
  let top = available - total
  return heights.map(height => {
    const slot = { top, height }
    top += height + gap
    return slot
  })
}

/** 完整进场后逐条计时，不依赖其他消息的到期时间。 */
export function edgeReadComplete(readableAt: number, now: number, holdSec: number): boolean {
  return Number.isFinite(readableAt) && now - readableAt >= holdSec * 1000
}
