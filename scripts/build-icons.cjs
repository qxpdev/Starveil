const { existsSync, statSync, mkdtempSync, rmSync } = require('node:fs')
const { join, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const root = resolve(__dirname, '..')
const source = join(root, 'resources', 'icon.svg')
const targets = ['icon.png', 'icon.ico'].map(name => join(root, 'resources', name))
if (targets.every(file => existsSync(file) && statSync(file).mtimeMs >= statSync(source).mtimeMs)) process.exit(0)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const temporary = mkdtempSync(join(tmpdir(), 'xingmu-icon-'))
env.XINGMU_ICON_PROFILE = temporary
try {
  const result = spawnSync(require('electron'), [join(__dirname, 'render-icons.cjs')], {
    cwd: root, env, stdio: 'inherit', windowsHide: true
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} finally {
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error('图标临时目录越界')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
}
