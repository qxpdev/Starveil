const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const { version, build: { productName } } = require('../package.json')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
const section = changelog.split(/^## /m).find(item => item.split('\n', 1)[0] === version)
if (!section) throw new Error(`CHANGELOG.md 缺少 ${version} 的发布说明。`)
const changes = section.slice(section.indexOf('\n') + 1).trim()
const filename = `${productName}-${version}-win-x64.exe`
const output = join(root, 'release', `${productName}-${version}-release-notes.md`)
const notes = `# ${productName} ${version} · 星幕

Windows 10 / 11 x64 · 便携版 / Portable

下载并运行 **${filename}**。无需安装 Node.js；首次使用请确认房间号并点击“启动飘屏”。
Download **${filename}** below. No Node.js installation is needed. The app interface is in Chinese.

${changes}

## 升级与数据 / Upgrade and data

更新前请从托盘完全退出旧版本，然后运行新版。配置、每日统计和已保存的弹幕继续使用原目录。
Fully quit the previous version from the tray before opening the new executable. Existing settings and saved records are reused.

## 校验 / Checksum

同页的 **${filename}.sha256** 提供 SHA-256 校验值，可在 PowerShell 中运行：
Use the attached **${filename}.sha256** file to compare the SHA-256 hash:

\`\`\`powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\\${filename}'
\`\`\`
`
mkdirSync(join(root, 'release'), { recursive: true })
writeFileSync(output, notes, 'utf8')
console.log('发布说明：' + output)
