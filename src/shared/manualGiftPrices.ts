export interface ManualGiftPrice {
  name: string
  priceYuan: number
}
export type ManualGiftPrices = Record<string, ManualGiftPrice>

/** 显式输入单位为元，最多两位小数；空白和非法值不当作免费。 */
export function parseManualGiftPrice(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const raw = String(value).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null
  const price = Number(raw)
  return Number.isFinite(price) && price >= 0 && price <= 1_000_000 ? Math.round(price * 100) / 100 : null
}

export function normalizeManualGiftPrices(value: unknown): ManualGiftPrices {
  const result: ManualGiftPrices = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [id, raw] of Object.entries(value).slice(0, 1000)) {
    if (!/^(?:prop:)?\d{1,18}$/.test(id) || id === '0' || id === 'prop:0' || !raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const priceYuan = parseManualGiftPrice(item.priceYuan)
    if (priceYuan == null) continue
    result[id] = { name: String(item.name ?? '').trim().slice(0, 60), priceYuan }
  }
  return result
}
