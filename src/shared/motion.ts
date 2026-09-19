export interface MotionState { offset: number; velocity: number; acceleration: number }

export function motionSpeedScale(speedPercent = 100): number {
  return Math.min(320, Math.max(40, Number.isFinite(speedPercent) ? speedPercent : 100)) / 100
}

/** 重排只改变目标，延续当前速度和加速度；方向反转时消除背向惯性。 */
export function retargetFlowMotion(state: MotionState, delta: number): MotionState {
  if (Math.abs(delta) <= 0.5) return state
  const offset = state.offset + delta
  if (!offset || offset * state.velocity > 0 || (!state.velocity && offset * state.acceleration > 0)) {
    return { offset, velocity: 0, acceleration: 0 }
  }
  return { ...state, offset }
}

/**
 * 三阶临界阻尼的解析解：从静止柔和加速，中段推进，末段减速贴合。
 * 连续插入保留位置、速度和加速度，不把每次重排变成一次急起步。
 */
export function advanceFlowMotion(state: MotionState, dt: number, speedPercent = 100): MotionState {
  if (dt <= 0 || !Number.isFinite(dt)) return state
  const time = Math.min(dt, 0.1)
  const damping = 24 * motionSpeedScale(speedPercent)
  const decay = Math.exp(-damping * time)
  const linear = state.velocity + damping * state.offset
  const quadratic = (state.acceleration + 2 * damping * state.velocity + damping * damping * state.offset) / 2
  const position = state.offset + linear * time + quadratic * time * time
  const derivative = linear + 2 * quadratic * time
  const offset = position * decay
  const velocity = (derivative - damping * position) * decay
  const acceleration = (2 * quadratic - 2 * damping * derivative + damping * damping * position) * decay
  if (offset * state.offset < 0 || (Math.abs(offset) < 0.15 && Math.abs(velocity) < 3)) {
    return { offset: 0, velocity: 0, acceleration: 0 }
  }
  // 途中大幅减速或目标缩短时，旧惯性可能不再适合新曲线；单向收拢，避免回拉。
  if (Math.abs(offset) > Math.abs(state.offset) || offset * velocity > 0) {
    return { offset: Math.sign(state.offset) * Math.min(Math.abs(offset), Math.abs(state.offset)), velocity: 0, acceleration: 0 }
  }
  return { offset, velocity, acceleration }
}

/** 高峰按小批次匀速推进；不把积压量换算成每帧进场。 */
export function incomingBatchSize(pending: number, visibleCapacity: number): number {
  return Math.min(Math.max(1, Math.ceil(pending / 8)), 3, Math.max(1, Math.floor(visibleCapacity / 3)))
}
