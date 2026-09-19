import { hexToHsv, hsvToHex, normalizeHexColor, type HsvColor } from '../shared/color'
import './colorPicker.css'

/** 页面内调色器：保存回调只更新值，不销毁弹层或抢焦点。 */
export function installColorPicker(): { sync: () => void; close: () => void } {
  const popup = document.createElement('div')
  popup.id = 'colorPicker'
  popup.className = 'color-picker'
  popup.setAttribute('popover', 'manual')
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', '颜色选择器')
  popup.hidden = true
  popup.innerHTML = `<div class="color-picker-heading"><strong id="pickerTitle">选择颜色</strong><span>实时预览</span></div>
    <div class="color-sv" role="slider" tabindex="0" aria-label="饱和度与亮度，使用方向键调整" aria-valuemin="0" aria-valuemax="100"><span class="color-sv-knob"></span></div>
    <input class="color-hue" type="range" min="0" max="359" step="1" aria-label="色相" />
    <div class="color-presets" aria-label="常用颜色"></div>
    <div class="color-picker-bottom"><input id="colorHex" type="text" maxlength="7" spellcheck="false" autocomplete="off" aria-label="十六进制颜色" /><button class="button primary" id="colorDone" type="button">完成</button></div>
    <div id="colorHexError" class="color-hex-error" hidden>请输入有效颜色，例如 #56E3F9。</div>`
  document.body.appendChild(popup)
  const sv = popup.querySelector<HTMLElement>('.color-sv')!
  const knob = popup.querySelector<HTMLElement>('.color-sv-knob')!
  const hue = popup.querySelector<HTMLInputElement>('.color-hue')!
  const hex = popup.querySelector<HTMLInputElement>('#colorHex')!
  const error = popup.querySelector<HTMLElement>('#colorHexError')!
  const presets = popup.querySelector<HTMLElement>('.color-presets')!
  let trigger: HTMLButtonElement | null = null
  let input: HTMLInputElement | null = null
  let color: HsvColor = { h: 0, s: 0, v: 100 }
  let dragPointer: number | null = null

  const sync = (): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color-for]')) {
      const field = document.getElementById(button.dataset.colorFor!) as HTMLInputElement | null
      const value = normalizeHexColor(field?.value || '') || '#ffffff'
      button.querySelector<HTMLElement>('.swatch')!.style.backgroundColor = value
      button.querySelector<HTMLElement>('.hex-value')!.textContent = value.toUpperCase()
    }
  }
  const position = (): void => {
    if (!trigger || popup.hidden) return
    const rect = trigger.getBoundingClientRect()
    const width = popup.offsetWidth, height = popup.offsetHeight
    popup.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.right - width))}px`
    const preferred = rect.bottom + height + 10 <= innerHeight ? rect.bottom + 8 : rect.top - height - 8
    popup.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, preferred))}px`
  }
  const close = (): void => {
    if (!popup.hidden) popup.hidePopover()
    popup.hidden = true
    trigger?.setAttribute('aria-expanded', 'false')
    trigger = null; input = null; dragPointer = null
  }
  const render = (writeHex = true): void => {
    sv.style.setProperty('--picker-hue', String(color.h))
    knob.style.left = `${color.s}%`; knob.style.top = `${100 - color.v}%`
    hue.value = String(Math.round(color.h))
    const value = hsvToHex(color)
    if (writeHex) hex.value = value.toUpperCase()
    sv.setAttribute('aria-valuenow', String(Math.round(color.s)))
    sv.setAttribute('aria-valuetext', `饱和度 ${Math.round(color.s)}%，亮度 ${Math.round(color.v)}%`)
    for (const button of presets.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.color === value))
    }
    sync()
  }
  const apply = (writeHex = true): void => {
    if (!input) return
    input.value = hsvToHex(color)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    error.hidden = true; hex.removeAttribute('aria-invalid')
    render(writeHex)
  }
  for (const value of ['#ffffff', '#56e3f9', '#f7b500', '#79d5b1', '#f481a4', '#ac9cf3', '#bcbcbc', '#000000']) {
    const button = document.createElement('button')
    button.type = 'button'; button.dataset.color = value; button.style.backgroundColor = value
    button.setAttribute('aria-label', value.toUpperCase()); button.setAttribute('title', value.toUpperCase())
    button.addEventListener('click', () => { color = hexToHsv(value); apply() })
    presets.appendChild(button)
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color-for]')) {
    button.addEventListener('click', () => {
      if (trigger === button && !popup.hidden) { close(); return }
      close()
      trigger = button
      input = document.getElementById(button.dataset.colorFor!) as HTMLInputElement
      color = hexToHsv(input.value)
      popup.querySelector<HTMLElement>('#pickerTitle')!.textContent = document.getElementById(`label-${input.id}`)?.textContent || '选择颜色'
      error.hidden = true; hex.removeAttribute('aria-invalid')
      render(); popup.hidden = false; popup.showPopover(); position()
      button.setAttribute('aria-expanded', 'true'); sv.focus({ preventScroll: true })
    })
  }
  const applyPointer = (event: PointerEvent): void => {
    const rect = sv.getBoundingClientRect()
    color.s = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100))
    color.v = 100 - Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100))
    apply()
  }
  sv.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault(); dragPointer = event.pointerId; sv.setPointerCapture(event.pointerId); sv.focus(); applyPointer(event)
  })
  sv.addEventListener('pointermove', event => { if (dragPointer === event.pointerId) applyPointer(event) })
  sv.addEventListener('pointerup', event => {
    if (dragPointer !== event.pointerId) return
    applyPointer(event); dragPointer = null
    if (sv.hasPointerCapture(event.pointerId)) sv.releasePointerCapture(event.pointerId)
  })
  sv.addEventListener('pointercancel', () => { dragPointer = null })
  sv.addEventListener('keydown', event => {
    const step = event.shiftKey ? 10 : 1
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    color.s = Math.max(0, Math.min(100, color.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)))
    color.v = Math.max(0, Math.min(100, color.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)))
    apply()
  })
  hue.addEventListener('input', () => { color.h = Number(hue.value); apply() })
  hex.addEventListener('input', () => {
    const value = normalizeHexColor(hex.value)
    error.hidden = Boolean(value); hex.setAttribute('aria-invalid', String(!value))
    if (!value) return
    color = hexToHsv(value); apply(false)
  })
  hex.addEventListener('keydown', event => {
    if (event.key === 'Enter' && normalizeHexColor(hex.value)) {
      const previous = trigger; close(); previous?.focus()
    }
  })
  popup.querySelector('#colorDone')!.addEventListener('click', () => { const previous = trigger; close(); previous?.focus() })
  document.addEventListener('pointerdown', event => {
    if (!popup.hidden && !popup.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close()
  }, true)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); const previous = trigger; close(); previous?.focus() }
  })
  window.addEventListener('resize', position)
  document.addEventListener('scroll', position, true)
  sync()
  return { sync, close }
}
