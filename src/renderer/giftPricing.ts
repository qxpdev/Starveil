import type { GiftCatalogStatus, GiftPricePatch } from '../shared/types'
import { parseManualGiftPrice } from '../shared/manualGiftPrices'

export function installGiftPricing(onSaved: (status: GiftCatalogStatus) => void, onSaveError: (message: string) => void): {
  render: (status: GiftCatalogStatus) => void
  waitForSave: () => Promise<boolean>
} {
  const panel = document.getElementById('giftPricingPanel')!
  const list = document.getElementById('giftPricingList')!
  const empty = document.getElementById('giftPricingEmpty')!
  const statusLabel = document.getElementById('giftPricingStatus')!
  const addForm = document.getElementById('manualGiftForm') as HTMLFormElement
  let latest: GiftCatalogStatus | null = null
  let fingerprint = ''
  let saving: Promise<void> | null = null
  let saveFailed = false

  const showStatus = (text: string, error = false): void => {
    statusLabel.textContent = text
    statusLabel.dataset.error = String(error)
  }
  const render = (status: GiftCatalogStatus, force = false): void => {
    latest = status
    const nextFingerprint = JSON.stringify(status.pricing)
    if (nextFingerprint === fingerprint || (!force && (saveFailed || panel.contains(document.activeElement)))) return
    fingerprint = nextFingerprint
    empty.hidden = status.pricing.length > 0
    list.replaceChildren()
    for (const item of status.pricing) {
      const row = document.createElement('form')
      row.className = 'gift-price-row'
      row.dataset.giftId = item.id
      row.dataset.catalogType = item.catalogType || 'gift'
      const info = document.createElement('div'); info.className = 'gift-price-info'
      const name = document.createElement('strong'); name.textContent = item.name
      const detail = document.createElement('span')
      detail.textContent = [item.id ? `${item.catalogType === 'prop' ? '道具' : '礼物'} ID ${item.id}` : '广播未提供礼物 ID', item.count ? `本次收到 ×${item.count}` : '已保存的补价',
        item.source === 'manual' ? '手动价格' : item.source === 'platform' ? '已采用平台价格' : '等待补价'].join(' · ')
      info.append(name, detail); row.append(info)
      const actions = document.createElement('div'); actions.className = 'gift-price-actions'; row.append(actions)
      if (!/^\d{1,18}$/.test(item.id) || item.id === '0') {
        const missing = document.createElement('span'); missing.className = 'setting-desc'; missing.textContent = '缺少 ID，暂时无法对应补价'; actions.append(missing)
      } else if (item.source === 'platform') {
        const value = document.createElement('span'); value.className = 'gift-price-platform'; value.textContent = `平台单价 ￥${item.priceYuan?.toFixed(2)}`; actions.append(value)
      } else {
        const label = document.createElement('label'); label.className = 'gift-price-input'
        const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'
        input.placeholder = '单价 / 元'; input.setAttribute('aria-label', `${item.name} 单价（元）`)
        input.value = item.priceYuan == null ? '' : String(item.priceYuan)
        const unit = document.createElement('span'); unit.textContent = '元'
        label.append(input, unit)
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'button'; save.textContent = item.source === 'manual' ? '保存补价' : '补价并保存'
        actions.append(label, save)
        row.addEventListener('submit', event => {
          event.preventDefault()
          const priceYuan = parseManualGiftPrice(input.value)
          if (priceYuan == null) { input.setAttribute('aria-invalid', 'true'); showStatus('单价请填写 0 至 1000000 元，最多两位小数。', true); return }
          input.removeAttribute('aria-invalid')
          void savePrice({ giftId: item.id, catalogType: item.catalogType, name: item.name, priceYuan }, '补价已保存，本次已收到的礼物金额已重新计算。')
        })
      }
      if (item.source !== 'unknown') {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button quiet'; remove.textContent = '清除补价'
        remove.addEventListener('click', () => { void savePrice({ giftId: item.id, catalogType: item.catalogType, priceYuan: null }, '已清除手动补价；继续使用平台价格，缺价时显示待确认。') })
        actions.append(remove)
      }
      list.append(row)
    }
  }

  const savePrice = (patch: GiftPricePatch, message: string): Promise<void> => {
    if (saving) return saving
    showStatus('正在保存补价…')
    for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true
    saving = window.settingsApi.setGiftPrice(patch).then(status => {
      saveFailed = false
      if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur()
      render(status, true)
      onSaved(status)
      showStatus(message)
    }).catch(error => {
      saveFailed = true
      const message = error instanceof Error ? error.message : String(error)
      showStatus(message, true)
      onSaveError(message)
    }).finally(() => {
      saving = null
      for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false
    })
    return saving
  }

  addForm.addEventListener('submit', event => {
    event.preventDefault()
    const id = document.getElementById('manualGiftId') as HTMLInputElement
    const name = document.getElementById('manualGiftName') as HTMLInputElement
    const amount = document.getElementById('manualGiftAmount') as HTMLInputElement
    const type = document.getElementById('manualGiftType') as HTMLSelectElement
    const giftId = id.value.trim(), priceYuan = parseManualGiftPrice(amount.value)
    if (!/^\d{1,18}$/.test(giftId) || giftId === '0') { showStatus('礼物 ID 请填写有效的非零数字，可从上方未知礼物列表中查看。', true); id.focus(); return }
    if (priceYuan == null) { showStatus('单价请填写 0 至 1000000 元，最多两位小数；0 表示免费。', true); amount.focus(); return }
    void savePrice({ giftId, catalogType: type.value === 'prop' ? 'prop' : 'gift', name: name.value.trim(), priceYuan }, '手动价格已保存；平台提供正式价格后会优先采用平台价格。')
  })
  panel.addEventListener('focusout', () => {
    setTimeout(() => { if (latest && !saving && !panel.contains(document.activeElement)) render(latest) }, 0)
  })
  return { render, waitForSave: async () => { await saving; return !saveFailed } }
}
