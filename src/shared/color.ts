export interface HsvColor { h: number; s: number; v: number }

export function normalizeHexColor(value: string): string | null {
  const raw = value.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(raw)) return '#' + [...raw].map(c => c + c).join('').toLowerCase()
  return /^[0-9a-f]{6}$/i.test(raw) ? '#' + raw.toLowerCase() : null
}

export function hexToHsv(value: string): HsvColor {
  const hex = normalizeHexColor(value) || '#ffffff'
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }
  return { h: (h * 60 + 360) % 360, s: max ? delta / max * 100 : 0, v: max * 100 }
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const hue = ((h % 360) + 360) % 360 / 60
  const value = Math.min(100, Math.max(0, v)) / 100
  const chroma = value * Math.min(100, Math.max(0, s)) / 100
  const x = chroma * (1 - Math.abs(hue % 2 - 1)), m = value - chroma
  const triples = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]]
  return '#' + triples[Math.floor(hue)]!.map(c => Math.round((c + m) * 255).toString(16).padStart(2, '0')).join('')
}
