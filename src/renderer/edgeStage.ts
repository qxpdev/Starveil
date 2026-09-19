import type { AppConfig } from '../shared/config'
import { EDGE_ENTER_MS, EDGE_ENTER_EASING, EDGE_REPLACE_MS, EDGE_GAP, edgeFlowSlots, edgeReadComplete } from '../shared/edgeMotion'
import { advanceFlowMotion, retargetFlowMotion, motionSpeedScale, type MotionState } from '../shared/motion'

interface EdgeItem {
  top: number | null
  height: number
  motion: MotionState
}

/** 新消息立即从底部进入，整列平滑上移；顶部礼物独立停留，不阻塞消息流。 */
export class EdgeStage {
  private items = new Map<HTMLElement, EdgeItem>()
  private entrances = new Map<HTMLElement, Animation>()
  private departures = new Map<HTMLElement, Animation>()
  private readyTimes = new Map<HTMLElement, number>()
  private pinnedGift: HTMLElement | null = null
  private pinnedAt = Infinity
  private pinnedTop: number | null = null
  private available = 0
  private giftHoldSec = 4
  private side: 'left' | 'right' = 'right'
  private limit = 4
  private motion = true
  private speed = 1
  private gap = EDGE_GAP

  constructor(
    private layer: HTMLElement,
    private fit: (element: HTMLElement, height: number) => void,
    private replace: (element: HTMLElement) => void
  ) {}

  configure(config: AppConfig, motion: boolean): void {
    this.side = config.edgeSide
    this.limit = config.edgeMaxVisible
    this.gap = config.edgeMessageGap
    this.giftHoldSec = config.edgeGiftTopHoldSec
    this.motion = motion
    const speed = motionSpeedScale(config.speedPxPerSec)
    if (!motion) {
      for (const [element, animation] of this.entrances) {
        animation.cancel()
        this.markReady(element)
      }
      this.entrances.clear()
      for (const [element, item] of this.items) {
        item.motion = { offset: 0, velocity: 0, acceleration: 0 }
        element.style.translate = ''
      }
      for (const [element, animation] of this.departures) { animation.cancel(); element.remove() }
      this.departures.clear()
    } else if (speed !== this.speed) {
      for (const animation of [...this.entrances.values(), ...this.departures.values()]) animation.updatePlaybackRate(speed)
    }
    this.speed = speed
  }

  has(element: HTMLElement): boolean { return this.items.has(element) }
  readableAt(element: HTMLElement): number { return this.readyTimes.get(element) ?? 0 }
  isPinnedGift(element: HTMLElement): boolean { return this.pinnedGift === element }
  isHead(element: HTMLElement): boolean { return this.stream()[0] === element }
  giftHoldComplete(element: HTMLElement, now: number): boolean {
    return this.pinnedGift === element && edgeReadComplete(this.pinnedAt, now, this.giftHoldSec)
  }
  get travel(): string { return 'translate3d(' + (this.side === 'left' ? -1 : 1) * (this.layer.clientWidth + 32) + 'px, 0, 0)' }

  private stream(): HTMLElement[] { return [...this.items.keys()].filter(element => element !== this.pinnedGift) }

  /** 只保留一条顶部礼物；下一条到顶时接替，不能形成另一条等待队列。 */
  holdGift(element: HTMLElement, now = Date.now()): boolean {
    if (!this.giftHoldSec || !this.isHead(element) || !element.classList.contains('highlight-row') ||
      element.classList.contains('is-leaving')) return false
    if (this.pinnedGift) this.replace(this.pinnedGift)
    this.pinnedGift = element
    this.pinnedAt = Number.isFinite(this.readableAt(element)) ? now : Infinity
    this.pinnedTop = this.items.get(element)?.top ?? null
    element.dataset.edgeRole = 'pinned-gift'
    return true
  }

  refreshGiftHold(element: HTMLElement, now: number): void {
    if (this.pinnedGift === element) this.pinnedAt = Number.isFinite(this.readableAt(element)) ? now : Infinity
  }

  mount(element: HTMLElement): boolean {
    if (this.layer.clientHeight <= 0) return false
    element.classList.add('edge-item', 'is-static')
    element.dataset.edgeRole = 'stream'
    element.style.visibility = 'hidden'
    this.layer.appendChild(element)
    this.items.set(element, { top: null, height: 0, motion: { offset: 0, velocity: 0, acceleration: 0 } })
    this.layout()
    if (!this.items.has(element)) return false
    this.reveal(element)
    return true
  }

  layout(): void {
    const available = this.layer.clientHeight
    if (available <= 0) return
    if (this.pinnedTop != null && this.available) this.pinnedTop += available - this.available
    this.available = available
    for (const [element, item] of this.items) {
      element.style.maxHeight = available + 'px'
      this.fit(element, available)
      item.height = Math.max(1, element.offsetHeight)
    }
    if (this.pinnedGift && !this.giftHoldSec) this.replace(this.pinnedGift)

    // 只裁剪已经在屏幕上的条目。最新消息不等保留时间或退场动画结束。
    const fits = (): boolean => this.items.size <= this.limit &&
      [...this.items.values()].reduce((sum, item) => sum + item.height, 0) + Math.max(0, this.items.size - 1) * this.gap <= available
    while (!fits()) {
      const stream = this.stream()
      if (stream.length > 1) {
        const first = stream[0]!
        if (!this.holdGift(first)) this.replace(first)
      } else if (this.pinnedGift) this.replace(this.pinnedGift)
      else break
    }

    const ordered = [...(this.pinnedGift ? [this.pinnedGift] : []), ...this.stream()]
    const slots = edgeFlowSlots(ordered.map(element => this.items.get(element)!.height), available, this.gap)
    if (this.pinnedGift && slots.length) {
      // 下方消息变短或到期，不让正在顶部停留的礼物向下掉；空间增长时只向上让位。
      this.pinnedTop = Math.max(0, Math.min(this.pinnedTop ?? slots[0]!.top, slots[0]!.top))
      slots[0]!.top = this.pinnedTop
    }
    for (let index = 0; index < slots.length; index++) {
      const element = ordered[index]!, item = this.items.get(element)!, slot = slots[index]!
      item.motion = this.motion && item.top != null
        ? retargetFlowMotion(item.motion, item.top - slot.top) : { offset: 0, velocity: 0, acceleration: 0 }
      item.top = slot.top
      element.style.top = slot.top + 'px'
      element.style.translate = item.motion.offset ? '0 ' + item.motion.offset + 'px' : ''
    }
  }

  /** 纵向位移独立于横向进退场，频繁消息延续速度与加速度，不重启动画。 */
  advance(dt: number): void {
    for (const [element, item] of this.items) {
      if (!item.motion.offset && !item.motion.velocity) continue
      item.motion = this.motion ? advanceFlowMotion(item.motion, dt, this.speed * 100) : { offset: 0, velocity: 0, acceleration: 0 }
      element.style.translate = item.motion.offset ? '0 ' + item.motion.offset + 'px' : ''
    }
  }

  freeze(element: HTMLElement): Keyframe {
    const style = getComputedStyle(element)
    const frame = { transform: style.transform, opacity: style.opacity }
    const item = this.items.get(element)
    if (item && item.top != null) {
      item.top += item.motion.offset
      item.motion = { offset: 0, velocity: 0, acceleration: 0 }
      element.style.top = item.top + 'px'
      element.style.translate = ''
    }
    this.entrances.get(element)?.cancel()
    this.entrances.delete(element)
    return frame
  }

  /** 离场影像不占消息流容量，数量受限，也不延迟新消息。 */
  exitReplaced(element: HTMLElement, from: Keyframe): void {
    if (!this.motion) return
    const top = parseFloat(element.style.top)
    for (const [old, animation] of this.departures) {
      if (Math.abs(old.offsetTop - top) < old.offsetHeight || this.departures.size >= this.limit) {
        animation.cancel(); old.remove(); this.departures.delete(old)
      }
    }
    this.layer.appendChild(element)
    element.classList.add('is-leaving')
    const animation = element.animate([from, { transform: this.travel, opacity: 0 }], {
      duration: EDGE_REPLACE_MS, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'both'
    })
    animation.playbackRate = this.speed
    this.departures.set(element, animation)
    animation.onfinish = () => { this.departures.delete(element); animation.cancel(); element.remove() }
  }

  private markReady(element: HTMLElement): void {
    const now = Date.now()
    this.readyTimes.set(element, now)
    if (this.pinnedGift === element && !Number.isFinite(this.pinnedAt)) this.pinnedAt = now
  }

  reveal(element: HTMLElement, from?: Keyframe): void {
    this.entrances.get(element)?.cancel()
    this.entrances.delete(element)
    element.style.visibility = ''
    this.readyTimes.set(element, Infinity)
    if (!this.motion) { this.markReady(element); return }
    const animation = element.animate(
      [from ?? { transform: this.travel, opacity: 0 }, { transform: 'translate3d(0, 0, 0)', opacity: 1 }],
      { duration: EDGE_ENTER_MS, easing: EDGE_ENTER_EASING, fill: 'both' }
    )
    animation.playbackRate = this.speed
    this.entrances.set(element, animation)
    animation.onfinish = () => {
      if (this.entrances.get(element) !== animation) return
      this.entrances.delete(element)
      this.markReady(element)
      animation.cancel()
    }
  }

  unmount(element: HTMLElement): void {
    this.entrances.get(element)?.cancel()
    this.entrances.delete(element)
    this.readyTimes.delete(element)
    this.items.delete(element)
    if (this.pinnedGift === element) { this.pinnedGift = null; this.pinnedAt = Infinity; this.pinnedTop = null }
  }

  clear(): void {
    for (const animation of [...this.entrances.values(), ...this.departures.values()]) animation.cancel()
    this.entrances.clear()
    this.departures.clear()
    this.readyTimes.clear()
    this.items.clear()
    this.pinnedGift = null
    this.pinnedAt = Infinity
    this.pinnedTop = null
    this.available = 0
    this.layer.replaceChildren()
  }
}
