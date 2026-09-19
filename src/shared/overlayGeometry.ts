export interface Rectangle { x: number; y: number; width: number; height: number }
export const OVERLAY_MIN_WIDTH = 240
export const OVERLAY_MIN_HEIGHT = 120
export const OVERLAY_SNAP_DISTANCE = 6

/** 所有坐标均为 Electron 的逻辑像素；DPI 仅由系统换算一次。 */
export function clampOverlayBounds(rect: Rectangle, area: Rectangle): Rectangle {
  const minWidth = Math.min(OVERLAY_MIN_WIDTH, area.width)
  const minHeight = Math.min(OVERLAY_MIN_HEIGHT, area.height)
  const width = Math.round(Math.min(area.width, Math.max(minWidth, rect.width)))
  const height = Math.round(Math.min(area.height, Math.max(minHeight, rect.height)))
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  const x = Math.round(Math.min(maxX, Math.max(area.x, rect.x)))
  const y = Math.round(Math.min(maxY, Math.max(area.y, rect.y)))
  return { x, y, width, height }
}

/** 只在拖动结束时使用；移动过程中仅限制越界，不吸住鼠标。 */
export function clampAndSnapOverlayBounds(rect: Rectangle, area: Rectangle): Rectangle {
  const result = clampOverlayBounds(rect, area)
  const maxX = area.x + area.width - result.width
  const maxY = area.y + area.height - result.height
  if (Math.abs(result.x - area.x) <= OVERLAY_SNAP_DISTANCE) result.x = area.x
  else if (Math.abs(result.x - maxX) <= OVERLAY_SNAP_DISTANCE) result.x = maxX
  if (Math.abs(result.y - area.y) <= OVERLAY_SNAP_DISTANCE) result.y = area.y
  else if (Math.abs(result.y - maxY) <= OVERLAY_SNAP_DISTANCE) result.y = maxY
  return result
}

export function defaultOverlayBounds(area: Rectangle): Rectangle {
  const width = Math.min(area.width, 360)
  const height = Math.min(area.height, 640)
  return clampAndSnapOverlayBounds({ x: area.x + area.width - width, y: area.y + (area.height - height) / 2, width, height }, area)
}

/** 边缘模式占用透明的屏幕侧边带，不改写普通窗口的手动位置。 */
export function edgeOverlayBounds(area: Rectangle, requestedWidth: number, side: 'left' | 'right'): Rectangle {
  const width = Math.round(Math.min(area.width, Math.max(OVERLAY_MIN_WIDTH, requestedWidth)))
  return { x: side === 'left' ? area.x : area.x + area.width - width, y: area.y, width, height: area.height }
}

/** 分辨率/任务栏变化后维持相对位置，右下贴边的窗口继续贴右下边。 */
export function remapOverlayBounds(rect: Rectangle, previous: Rectangle | undefined, area: Rectangle): Rectangle {
  if (!previous || (previous.x === area.x && previous.y === area.y && previous.width === area.width && previous.height === area.height)) {
    return clampOverlayBounds(rect, area)
  }
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  const fraction = (offset: number, available: number): number => available <= 0 ? 0 : Math.min(1, Math.max(0, offset / available))
  return clampOverlayBounds({
    x: area.x + fraction(rect.x - previous.x, previous.width - rect.width) * (area.width - width),
    y: area.y + fraction(rect.y - previous.y, previous.height - rect.height) * (area.height - height),
    width, height
  }, area)
}
