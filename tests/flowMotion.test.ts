import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceFlowMotion, retargetFlowMotion, type MotionState } from '../src/shared/motion'

const rest = (): MotionState => ({ offset: 0, velocity: 0, acceleration: 0 })

function run(state: MotionState, seconds: number, fps = 120, speed = 100): MotionState {
  for (let elapsed = 0; elapsed < seconds - 1e-9;) {
    const dt = Math.min(1 / fps, seconds - elapsed)
    state = advanceFlowMotion(state, dt, speed)
    elapsed += dt
  }
  return state
}

test('上移柔和起步、中段提速、末段减速，半秒内停稳且没有匀速尾巴', () => {
  let state = retargetFlowMotion(rest(), 100)
  const samples: MotionState[] = []
  for (let frame = 0; frame < 60; frame++) {
    state = advanceFlowMotion(state, 1 / 120)
    samples.push(state)
  }
  assert.ok(100 - samples[1]!.offset < 2, '首个 60 Hz 画面只轻微移动')
  assert.ok(100 - samples[4]!.offset < 12, '起步不能直接冲走一大截')
  const speeds = samples.map(sample => -sample.velocity)
  const peak = Math.max(...speeds)
  const peakTime = (speeds.indexOf(peak) + 1) / 120
  assert.ok(peakTime >= .07 && peakTime <= .12, '中段才达到最高速度')
  assert.ok(speeds[1]! < peak / 3)
  assert.ok(speeds[35]! < peak / 10, '末段有明显减速')
  assert.ok(samples[47]!.offset < .5, '收尾不能拖着文字慢慢爬行')
  assert.deepEqual(state, rest())
})

test('移动中连续来消息保留实际位置、速度和加速度，不从静止重新起步', () => {
  let target = 500
  let state = retargetFlowMotion(rest(), 64)
  for (const interval of [.04, .06, .03, .09, .025, .1]) {
    state = run(state, interval)
    const position = target + state.offset
    const previous = state
    target -= 48
    state = retargetFlowMotion(state, 48)
    assert.equal(target + state.offset, position)
    assert.equal(state.velocity, previous.velocity)
    assert.equal(state.acceleration, previous.acceleration)
    const next = advanceFlowMotion(state, 1e-5)
    assert.ok(Math.abs(next.velocity - state.velocity - state.acceleration * 1e-5) < .002)
    assert.ok(next.offset < state.offset && next.velocity < 0)
  }
  assert.deepEqual(run(state, 1), rest())
})

test('不同刷新率与一次短暂掉帧在相同时间到达相同位置', () => {
  const start = retargetFlowMotion(rest(), 140)
  for (const seconds of [.1, .2, .3, .4]) {
    const reference = run(start, seconds, 120)
    for (const fps of [10, 20, 30, 60, 144]) {
      const sample = run(start, seconds, fps)
      assert.ok(Math.abs(sample.offset - reference.offset) < 1e-7, `${fps} Hz / ${seconds}s`)
      assert.ok(Math.abs(sample.velocity - reference.velocity) < 1e-6)
    }
  }
  const beforeStall = run(start, .05)
  const afterStall = advanceFlowMotion(beforeStall, .08)
  assert.ok(Math.abs(afterStall.offset - run(start, .13).offset) < 1e-7)
})

test('慢速、标准和快速保持相同缓动节奏，滚动速度只缩放运动时长', () => {
  const start = retargetFlowMotion(rest(), 80)
  const normal = run(start, .2)
  for (const speed of [40, 160, 320]) {
    const sample = run(start, .2 / (speed / 100), 120, speed)
    assert.ok(Math.abs(sample.offset - normal.offset) < 1e-7)
  }
})

test('上移与向下收拢途中大幅调速仍单向靠近目标，最终不残留运动', () => {
  for (const direction of [-1, 1]) for (const from of [40, 100, 320]) {
    for (const to of [40, 100, 320]) for (const switchAt of [.025, .08, .16, .3]) {
      let state = run(retargetFlowMotion(rest(), 120 * direction), switchAt, 120, from)
      for (let frame = 0; frame < 240; frame++) {
        const next = advanceFlowMotion(state, frame % 2 ? 1 / 60 : 1 / 120, to)
        assert.ok(next.offset * direction >= 0)
        assert.ok(Math.abs(next.offset) <= Math.abs(state.offset))
        assert.ok(next.velocity * direction <= 1e-8)
        state = next
      }
      assert.deepEqual(state, rest(), `${direction} / ${from} -> ${to} at ${switchAt}`)
    }
  }
})

test('目标被缩短或反转时不回弹；恰好抵达目标会清除剩余惯性', () => {
  const moving = run(retargetFlowMotion(rest(), 100), .07)
  for (const delta of [-20, -80, -120]) {
    let state = retargetFlowMotion(moving, delta)
    const direction = Math.sign(state.offset)
    for (let frame = 0; frame < 120; frame++) {
      const next = advanceFlowMotion(state, 1 / 120)
      assert.ok(next.offset * direction >= 0)
      assert.ok(Math.abs(next.offset) <= Math.abs(state.offset))
      state = next
    }
    assert.deepEqual(state, rest())
  }
  assert.deepEqual(retargetFlowMotion(moving, -moving.offset), rest())
})

test('无效时间不污染运动状态，长时间挂起恢复后限制单帧追赶量', () => {
  const state = retargetFlowMotion(rest(), 100)
  for (const dt of [0, -1, NaN, Infinity]) assert.equal(advanceFlowMotion(state, dt), state)
  assert.deepEqual(advanceFlowMotion(state, 5), advanceFlowMotion(state, .1))
})
