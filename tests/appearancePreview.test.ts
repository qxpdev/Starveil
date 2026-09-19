import test from 'node:test'
import assert from 'node:assert/strict'
import { AppearancePreview } from '../src/shared/appearancePreview'
import { mergeConfig } from '../src/shared/config'

test('拖动预览立即生效，已保存配置与其他功能保持独立', () => {
  const saved = mergeConfig({ fontSize: 20, lineHeight: 1.5, roomId: '84452', dailyStatisticsEnabled: true })
  const preview = new AppearancePreview()
  const visible = preview.update(saved, { fontSize: 34, lineHeight: 1.1, roomId: '1', dailyStatisticsEnabled: false, overlayEnabled: false })
  assert.equal(visible.fontSize, 34)
  assert.equal(visible.lineHeight, 1.1)
  assert.equal(visible.roomId, '84452')
  assert.equal(visible.dailyStatisticsEnabled, true)
  assert.equal(visible.overlayEnabled, saved.overlayEnabled)
  assert.equal(saved.fontSize, 20)
  assert.equal(saved.lineHeight, 1.5)
})

test('多个控件的连续预览累积并遵循已保存设置的合法范围', () => {
  const saved = mergeConfig({ fontSize: 20 })
  const preview = new AppearancePreview()
  preview.update(saved, { fontSize: 500, opacity: .45 })
  const visible = preview.update(saved, { lineHeight: -1, usernameTextColor: '#abcdef', avatarSize: Infinity })
  assert.equal(visible.fontSize, 96)
  assert.equal(visible.opacity, .45)
  assert.equal(visible.lineHeight, 1)
  assert.equal(visible.usernameTextColor, '#abcdef')
  assert.equal(visible.avatarSize, saved.avatarSize)
  assert.deepEqual(preview.update(saved, ['fontSize', 50]), visible)
})

test('较早的保存完成后仍显示最新拖动值，不发生回弹', () => {
  const saved = mergeConfig({ fontSize: 20 })
  const preview = new AppearancePreview()
  preview.update(saved, { fontSize: 24, lineHeight: 1.2 })
  preview.update(saved, { fontSize: 32 })
  const olderSave = mergeConfig({ ...saved, fontSize: 24 })
  preview.acceptSaved(olderSave, { fontSize: 24 })
  assert.equal(preview.config(olderSave).fontSize, 32)
  assert.equal(preview.config(olderSave).lineHeight, 1.2)
  const latestSave = mergeConfig({ ...olderSave, fontSize: 32, lineHeight: 1.2 })
  preview.acceptSaved(latestSave, { fontSize: 32, lineHeight: 1.2 })
  assert.equal(preview.config({ ...latestSave, fontSize: 28 }).fontSize, 28)
})

test('保存归一化后的值会结束预览，不覆盖后续设置', () => {
  const saved = mergeConfig(undefined)
  const preview = new AppearancePreview()
  preview.update(saved, { fontSize: 1000 })
  const committed = mergeConfig({ ...saved, fontSize: 1000 })
  preview.acceptSaved(committed, { fontSize: 1000 })
  assert.equal(preview.config({ ...committed, fontSize: 30 }).fontSize, 30)
})

test('保存失败或离开设置后撤回预览，采用最近的持久配置', () => {
  const saved = mergeConfig({ fontSize: 20, lineHeight: 1.1 })
  const preview = new AppearancePreview()
  preview.update(saved, { fontSize: 28, lineHeight: 2 })
  const current = { ...saved, fontSize: 24, roomId: '999' }
  preview.clear()
  assert.deepEqual(preview.config(current), current)
})

test('礼物与统计透明度可独立预览，预览不能切换缓存位置或统计显示方式', () => {
  const saved = mergeConfig({ giftOpacity: 1, giftBackgroundOpacity: 0, giftBannerOpacity: .55, statusOpacity: 1 })
  const preview = new AppearancePreview()
  const shown = preview.update(saved, { giftOpacity: .42, giftBackgroundOpacity: .16, giftBannerOpacity: .3,
    statusOpacity: .75, statusBackgroundOpacity: .5, statusFontSize: 18, edgeMessageGap: 3,
    cacheDirectory: 'C:\\elsewhere', edgeStatusMode: 'always' })
  assert.equal(shown.giftOpacity, .42)
  assert.equal(shown.giftBackgroundOpacity, .16)
  assert.equal(shown.giftBannerOpacity, .3)
  assert.equal(shown.statusOpacity, .75)
  assert.equal(shown.statusBackgroundOpacity, .5)
  assert.equal(shown.statusFontSize, 18)
  assert.equal(shown.edgeMessageGap, 3)
  assert.equal(shown.opacity, saved.opacity)
  assert.equal(shown.danmakuBgOpacity, saved.danmakuBgOpacity)
  assert.equal(shown.cacheDirectory, saved.cacheDirectory)
  assert.equal(shown.edgeStatusMode, saved.edgeStatusMode)
  preview.clear()
  assert.deepEqual(preview.config(saved), saved)
})
