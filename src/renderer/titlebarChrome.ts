import brandIcon from '../../resources/icon.svg?url'
import type { WindowChromeState } from '../shared/types'

/** 统一的 Windows 标题栏：最小化、最大化/还原、关闭，以及拖拽。 */

const DRAG_THRESHOLD_PX = 5

export function bindTitlebarChrome(beforeClose?: () => Promise<boolean | void>): void {
  const api = window.settingsApi
  for (const icon of document.querySelectorAll<HTMLImageElement>('[data-brand-icon]')) icon.src = brandIcon
  if (!api?.windowDragStart || !api.windowDragMove || !api.windowDragEnd) return

  document.getElementById('winMin')?.addEventListener('click', () => api.minimizeWindow())
  document.getElementById('winMax')?.addEventListener('click', () => api.toggleMaximizeWindow())
  document.getElementById('winClose')?.addEventListener('click', () => {
    void (async () => { if (await beforeClose?.() !== false) api.closeWindow() })()
  })
  const syncState = (state: WindowChromeState): void => {
    document.documentElement.classList.toggle('is-maximized', state.maximized)
    const button = document.getElementById('winMax')
    button?.setAttribute('aria-label', state.maximized ? '还原窗口' : '最大化窗口')
    button?.setAttribute('title', state.maximized ? '还原' : '最大化')
  }
  api.onWindowState(syncState)
  void api.getWindowState().then(syncState)

  const bar = document.getElementById('titlebar')
  if (!bar) return

  bar.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button, input, select, a')) return
    e.preventDefault()
    api.toggleMaximizeWindow()
  })

  bar.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, select, a')) return
    if (e.detail >= 2) return

    const barEl = bar
    const pointerId = e.pointerId
    let armed = true
    let dragging = false
    const sx0 = e.screenX
    const sy0 = e.screenY

    let rafId = 0
    let pending: { sx: number; sy: number } | null = null

    const flushPending = (): void => {
      rafId = 0
      if (!armed || !dragging || !pending) {
        pending = null
        return
      }
      const { sx, sy } = pending
      pending = null
      api.windowDragMove(sx, sy)
    }

    const scheduleMove = (sx: number, sy: number): void => {
      if (!armed || !dragging) return
      pending = { sx, sy }
      if (!rafId) rafId = requestAnimationFrame(flushPending)
    }

    const teardown = (): void => {
      if (!armed) return
      armed = false

      barEl.removeEventListener('pointermove', onPointerMove)
      barEl.removeEventListener('pointerup', onPointerUp)
      barEl.removeEventListener('pointercancel', onPointerUp)
      barEl.removeEventListener('lostpointercapture', onLostCapture)

      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }

      try {
        if (barEl.hasPointerCapture(pointerId)) barEl.releasePointerCapture(pointerId)
      } catch {
        /* ignore */
      }

      if (dragging && pending) {
        api.windowDragMove(pending.sx, pending.sy)
        pending = null
      }
      if (dragging) api.windowDragEnd()
      dragging = false
    }

    const onPointerMove = (pe: PointerEvent): void => {
      if (!armed || pe.pointerId !== pointerId) return
      if (!dragging) {
        if (
          Math.abs(pe.screenX - sx0) < DRAG_THRESHOLD_PX &&
          Math.abs(pe.screenY - sy0) < DRAG_THRESHOLD_PX
        ) {
          return
        }
        dragging = true
        api.windowDragStart(pe.screenX, pe.screenY)
      }
      scheduleMove(pe.screenX, pe.screenY)
    }

    const onPointerUp = (pe: PointerEvent): void => {
      if (pe.pointerId !== pointerId) return
      teardown()
    }

    const onLostCapture = (): void => {
      teardown()
    }

    try {
      barEl.setPointerCapture(pointerId)
    } catch {
      /* 极少见：节点未在文档中 */
    }

    barEl.addEventListener('pointermove', onPointerMove)
    barEl.addEventListener('pointerup', onPointerUp)
    barEl.addEventListener('pointercancel', onPointerUp)
    barEl.addEventListener('lostpointercapture', onLostCapture)
  })
}
