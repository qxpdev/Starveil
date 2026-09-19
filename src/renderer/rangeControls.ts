/** 范围滑杆与精确数值共用同一条保存路径，输入未完成时不抢写焦点。 */
export function installRangeControls(): { sync: () => void } {
  const bindings = [...document.querySelectorAll<HTMLInputElement>('input[type="range"][data-config]')].map(range => {
    const host = range.closest<HTMLElement>('.range-control')!
    const previous = host.querySelector<HTMLElement>('.range-val')!
    const percent = range.dataset.format === 'percent'
    const multiplier = percent ? 100 : 1
    const label = document.getElementById(range.getAttribute('aria-labelledby') || '')?.textContent || '数值'
    const stepper = document.createElement('div')
    stepper.className = 'range-stepper'
    const number = document.createElement('input')
    number.type = 'number'; number.id = `${range.id}Number`
    number.min = String(Number(range.min) * multiplier); number.max = String(Number(range.max) * multiplier)
    number.step = String(Number((Number(range.step) * multiplier).toFixed(3)))
    number.setAttribute('aria-label', `${label}数值`)
    const unit = document.createElement('span')
    unit.className = 'range-unit'; unit.textContent = percent ? '%' : (previous.textContent || '').trim()
    const inputBox = document.createElement('label')
    inputBox.className = 'range-number'; inputBox.append(number, unit)
    const set = (value: number, commit: boolean): void => {
      range.value = String(Math.min(Number(range.max), Math.max(Number(range.min), value / multiplier)))
      range.dispatchEvent(new Event('input', { bubbles: true }))
      if (commit) range.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const buttons = [-1, 1].map(direction => {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = direction < 0 ? '−' : '+'
      button.setAttribute('aria-label', `${direction < 0 ? '减小' : '增大'}${label}`)
      button.addEventListener('click', () => {
        set((Number(range.value) + direction * Number(range.step)) * multiplier, true)
        number.value = String(Number((Number(range.value) * multiplier).toFixed(3)))
      })
      return button
    })
    stepper.append(buttons[0]!, inputBox, buttons[1]!)
    previous.replaceWith(stepper)
    number.addEventListener('input', () => {
      const value = Number(number.value)
      if (number.value !== '' && Number.isFinite(value) && value >= Number(number.min) && value <= Number(number.max)) set(value, false)
    })
    number.addEventListener('change', () => {
      if (number.value !== '' && Number.isFinite(Number(number.value))) set(Number(number.value), true)
      number.value = String(Number((Number(range.value) * multiplier).toFixed(3)))
    })
    number.addEventListener('keydown', event => { if (event.key === 'Enter') number.blur() })
    return { range, number, buttons, multiplier }
  })
  return { sync: () => {
    for (const { range, number, buttons, multiplier } of bindings) {
      if (document.activeElement !== number) number.value = String(Number((Number(range.value) * multiplier).toFixed(3)))
      number.disabled = range.disabled
      buttons[0]!.disabled = range.disabled || Number(range.value) <= Number(range.min)
      buttons[1]!.disabled = range.disabled || Number(range.value) >= Number(range.max)
    }
  } }
}
