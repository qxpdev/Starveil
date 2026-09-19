import { app, screen } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 返回当前任务栏未覆盖的全屏显示器。辅助进程仅输出几何信息。 */
export function watchFullscreenDisplay(onChange: (displayId: number | null) => void): () => void {
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'desktop-state.exe')
    : join(app.getAppPath(), 'resources', 'desktop-state.exe')
  if (!existsSync(executable)) return () => {}
  const child = spawn(executable, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buffer = ''
  let previous: number | null = null
  const update = (id: number | null): void => {
    if (id !== previous) { previous = id; onChange(id) }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      try {
        const state = JSON.parse(line)
        const rect = state.fullscreen
        if (!rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))) { update(null); continue }
        const dip = screen.screenToDipRect(null, rect)
        const display = screen.getDisplayMatching(dip)
        update(display.id)
      } catch { update(null) }
    }
  })
  child.on('error', () => update(null))
  child.on('exit', () => update(null))
  return () => { child.removeAllListeners(); child.kill() }
}
