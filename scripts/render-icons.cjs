// 直接由 SVG 渲染 PNG，并将多种尺寸的 PNG 装入 Windows ICO；无需额外图像依赖。
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const root = resolve(__dirname, '..')
const temporary = process.env.XINGMU_ICON_PROFILE
if (!temporary) throw new Error('请通过 build-icons.cjs 生成图标。')
app.setPath('userData', temporary)
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'resources/icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<style>*{margin:0;padding:0}html,body{width:1024px;height:1024px;background:transparent}svg{width:1024px;height:1024px;display:block}</style>' + svg))
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  if (image.isEmpty()) throw new Error('SVG 图标渲染失败')
  writeFileSync(join(root, 'resources/icon.png'), image.toPNG())
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const cursor = 6 + index * 16
    header[cursor] = header[cursor + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, cursor + 4); header.writeUInt16LE(32, cursor + 6)
    header.writeUInt32LE(pngs[index].length, cursor + 8); header.writeUInt32LE(offset, cursor + 12)
    offset += pngs[index].length
  })
  writeFileSync(join(root, 'resources/icon.ico'), Buffer.concat([header, ...pngs]))
  win.destroy(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })
