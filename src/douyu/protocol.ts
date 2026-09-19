export function decodeDouyuValue(value: string): string {
  // 必须先还原斜杠，避免把原文的字面量 @S 多解码一次。
  return value.replace(/@S/gi, '/').replace(/@A/g, '@')
}

export function parseDouyuFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split('/')) {
    const index = part.indexOf('@=')
    if (index === -1) continue
    const key = part.slice(0, index)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = decodeDouyuValue(part.slice(index + 2))
  }
  return out
}

/** 已解析外层字段中的 STT 数组，逐层还原，不能一次替换所有嵌套转义。 */
export function parseDouyuList(value: string, limit = 100): Record<string, string>[] {
  return value.split('/').filter(Boolean).slice(0, limit).map(part => parseDouyuFields(decodeDouyuValue(part)))
}
