/** dms 是斗鱼智能弹幕的协议字段，不是经过认证的真人身份。 */
export type ChatExclusionReason = 'otherRoom' | 'missingRoom' | 'suspectedRobot' | 'emptyText'
export type ChatExclusions = Record<ChatExclusionReason, number>

export function emptyChatExclusions(): ChatExclusions {
  return { otherRoom: 0, missingRoom: 0, suspectedRobot: 0, emptyText: 0 }
}

export function chatExclusionReason(
  message: { roomId?: string; text: string; dms?: string; isHighEnergy?: boolean },
  roomId: string,
  filterSuspectedRobots: boolean
): ChatExclusionReason | null {
  const source = String(message.roomId || '').trim()
  if (!source) return 'missingRoom'
  if (source !== roomId) return 'otherRoom'
  if (!message.text.trim()) return 'emptyText'
  // 保留旧版过滤规则，包括合法值 "0"；不把分数高低当成真人判定。
  if (filterSuspectedRobots && !message.isHighEnergy && !String(message.dms || '').trim()) return 'suspectedRobot'
  return null
}
