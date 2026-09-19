import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, mergeConfig } from '../src/shared/config'
import { edgeOverlayBounds } from '../src/shared/overlayGeometry'
import { edgeReadComplete, edgeFlowSlots } from '../src/shared/edgeMotion'
import { AppearancePreview } from '../src/shared/appearancePreview'
import { advanceFlowMotion, motionSpeedScale } from '../src/shared/motion'

test('旧配置沿用显示方式，边缘模式独立保存宽度与普通窗口位置', () => {
  const original = mergeConfig({ danmakuScrollDirection: 'verticalUp', clickThrough: false,
    overlayManualBounds: { x: 100, y: 90, width: 360, height: 640, displayId: '1' } })
  const edge = mergeConfig({ ...original, danmakuScrollDirection: 'edge', edgeSide: 'left', edgeWidth: 520 })
  assert.equal(edge.danmakuScrollDirection, 'edge')
  assert.equal(edge.edgeSide, 'left')
  assert.equal(edge.edgeWidth, 520)
  assert.equal(edge.clickThrough, false)
  assert.deepEqual(edge.overlayManualBounds, original.overlayManualBounds)
  assert.equal(original.danmakuScrollDirection, 'verticalUp')
  assert.equal(mergeConfig(undefined).danmakuScrollDirection, DEFAULT_CONFIG.danmakuScrollDirection)
})

test('边缘停留时间始终有限，非法值回退，宽度和同屏条数受限', () => {
  const cfg = mergeConfig({ edgeHoldSec: Infinity, edgeMaxVisible: 1000, edgeWidth: -20, commonTimeSec: 0, markedTimeSec: 0 })
  assert.equal(cfg.edgeHoldSec, 6)
  assert.equal(cfg.edgeMaxVisible, 8)
  assert.equal(cfg.edgeWidth, 280)
  assert.equal(mergeConfig({ edgeHoldSec: 0 }).edgeHoldSec, 2)
  assert.equal(cfg.commonTimeSec, 0)
  assert.equal(cfg.markedTimeSec, 0)
})

test('左侧副屏和任务栏工作区使用逻辑像素，左右边界都准确', () => {
  const area = { x: -1536, y: -200, width: 1536, height: 824 }
  assert.deepEqual(edgeOverlayBounds(area, 400, 'left'), { x: -1536, y: -200, width: 400, height: 824 })
  assert.deepEqual(edgeOverlayBounds(area, 400, 'right'), { x: -400, y: -200, width: 400, height: 824 })
  assert.deepEqual(edgeOverlayBounds({ x: 80, y: 40, width: 200, height: 100 }, 640, 'right'),
    { x: 80, y: 40, width: 200, height: 100 })
})

test('新消息始终从底部进入，已有消息按顺序向上腾出对应高度', () => {
  const first = edgeFlowSlots([60], 300)
  const second = edgeFlowSlots([60, 80], 300)
  const third = edgeFlowSlots([60, 80, 44], 300)
  assert.deepEqual(first, [{ top: 240, height: 60 }])
  assert.deepEqual(second, [{ top: 152, height: 60 }, { top: 220, height: 80 }])
  assert.deepEqual(third, [{ top: 100, height: 60 }, { top: 168, height: 80 }, { top: 256, height: 44 }])
  assert.equal(second[0]!.top - third[0]!.top, 44 + 8)
  assert.equal(second[1]!.top - third[1]!.top, 44 + 8)
  // 顶部退出后其余消息不下跳；下一条仍接在底部。
  assert.deepEqual(edgeFlowSlots([80, 44], 300), third.slice(1))
  assert.deepEqual(edgeFlowSlots([80, 44, 52], 300), [
    { top: 108, height: 80 }, { top: 196, height: 44 }, { top: 248, height: 52 }
  ])
})

test('顶部礼物只保留自身高度和统一间距，不产生固定空白或越界排版', () => {
  const withGift = edgeFlowSlots([54, 80, 44], 300, 5)
  assert.deepEqual(withGift, [{ top: 112, height: 54 }, { top: 171, height: 80 }, { top: 256, height: 44 }])
  assert.deepEqual(edgeFlowSlots([80, 44], 300, 5), withGift.slice(1))
  assert.deepEqual(edgeFlowSlots([300], 300), [{ top: 0, height: 300 }])
  assert.deepEqual(edgeFlowSlots([301], 300), [])
  assert.deepEqual(edgeFlowSlots([160, 160], 300), [])
  assert.deepEqual(edgeFlowSlots([NaN], 300), [])
  assert.deepEqual(edgeFlowSlots([40], 0), [])
  assert.deepEqual(edgeFlowSlots([40], 300, -1), [])
})

test('消息高峰从进场完成开始计算阅读时间，慢速进场不挤占阅读时间', () => {
  assert.equal(edgeReadComplete(Infinity, 99_000, 6), false)
  assert.equal(edgeReadComplete(1620, 4020, 6), false)
  assert.equal(edgeReadComplete(1620, 7619, 6), false)
  assert.equal(edgeReadComplete(1620, 7620, 6), true)
  assert.equal(edgeReadComplete(1620, 3619, 2), false)
  assert.equal(edgeReadComplete(1620, 3620, 2), true)
  assert.equal(edgeReadComplete(2550, 4549, 2), false)
  assert.equal(edgeReadComplete(2550, 4550, 2), true)
})

test('恢复礼物顶部追加停留，移除自动阅读参数并保留原有外观', () => {
  const old = { edgeGiftTopHoldSec: 60, edgeHoldSec: 9, edgeBottomPercent: 35, giftOpacity: .8,
    edgeReadCharsPerSec: 3, edgeMaxHoldSec: 90 }
  const config = mergeConfig(old)
  assert.equal(config.edgeGiftTopHoldSec, 60)
  assert.equal('edgeReadCharsPerSec' in config, false)
  assert.equal('edgeMaxHoldSec' in config, false)
  assert.equal(old.edgeGiftTopHoldSec, 60)
  assert.equal(old.edgeReadCharsPerSec, 3)
  assert.equal(config.edgeHoldSec, 9)
  assert.equal(config.edgeBottomPercent, 35)
  assert.equal(config.giftOpacity, .8)
  assert.equal(mergeConfig(undefined).edgeGiftTopHoldSec, 4)
  assert.equal(mergeConfig({ edgeGiftTopHoldSec: 0 }).edgeGiftTopHoldSec, 0)
  assert.equal(mergeConfig({ edgeGiftTopHoldSec: Infinity }).edgeGiftTopHoldSec, 4)
  assert.equal(mergeConfig({ edgeGiftTopHoldSec: 1000 }).edgeGiftTopHoldSec, 60)
})

test('消息流调速改变移动快慢，途中减速仍单向收敛，不反弹', () => {
  const start = { offset: 120, velocity: 0, acceleration: 0 }
  const slow = advanceFlowMotion(start, 1 / 60, 40)
  const normal = advanceFlowMotion(start, 1 / 60, 100)
  let fast = advanceFlowMotion(start, 1 / 60, 320)
  assert.ok(slow.offset > normal.offset && normal.offset > fast.offset)
  for (let frame = 0; frame < 180; frame++) {
    const next = advanceFlowMotion(fast, 1 / 60, 40)
    assert.ok(next.offset >= 0 && next.offset <= fast.offset)
    fast = next
  }
  assert.equal(fast.offset, 0)
  assert.equal(motionSpeedScale(NaN), 1)
})

test('边缘上下位置与速度支持实时预览，取消恢复原值且不修改原配置', () => {
  const saved = mergeConfig({ edgeBottomPercent: 0, speedPxPerSec: 100 })
  const preview = new AppearancePreview()
  preview.update(saved, { edgeBottomPercent: 45, speedPxPerSec: 200 })
  assert.equal(preview.config(saved).edgeBottomPercent, 45)
  assert.equal(preview.config(saved).speedPxPerSec, 200)
  assert.equal(saved.edgeBottomPercent, 0)
  preview.clear()
  assert.equal(preview.config(saved).edgeBottomPercent, 0)
  assert.equal(preview.config(saved).speedPxPerSec, 100)
  assert.equal(mergeConfig({ edgeBottomPercent: 100 }).edgeBottomPercent, 80)
})

test('边缘宽度预览不写入配置，旧保存与撤销都保持一致', () => {
  const saved = mergeConfig({ danmakuScrollDirection: 'edge', edgeWidth: 400 })
  const preview = new AppearancePreview()
  preview.update(saved, { edgeWidth: 440 })
  preview.update(saved, { edgeWidth: 540, edgeSide: 'left' })
  const committed = { ...saved, edgeWidth: 440 }
  preview.acceptSaved(committed, { edgeWidth: 440 })
  assert.equal(preview.config(committed).edgeWidth, 540)
  assert.equal(preview.config(committed).edgeSide, 'right')
  assert.equal(saved.edgeWidth, 400)
  preview.clear()
  assert.equal(preview.config(committed).edgeWidth, 440)
})
