const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

/** 按 Node 实际解析位置检查生产依赖，包括同名的嵌套版本。 */
function verifyPackagedDependencies(projectDirectory, archive) {
  const root = path.resolve(projectDirectory)
  const visited = new Set()
  const failures = []
  const read = directory => JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))

  for (const filename of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    try {
      const packed = asar.extractFile(archive, filename)
      if (!packed.equals(fs.readFileSync(path.join(root, filename)))) failures.push(`许可声明内容不一致：${filename}`)
    } catch { failures.push(`程序包缺少许可声明：${filename}`) }
  }

  function locate(from, name) {
    let directory = from
    while (true) {
      const candidate = path.join(directory, 'node_modules', name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
      const parent = path.dirname(directory)
      if (directory === root || parent === directory) return null
      directory = parent
    }
  }

  function visit(directory) {
    const manifest = read(directory)
    const optional = manifest.optionalDependencies || {}
    for (const name of Object.keys({ ...manifest.dependencies, ...optional })) {
      // 类型声明不在运行时加载，electron-builder 会有意移除它们。
      if (name.startsWith('@types/')) continue
      const resolved = locate(directory, name)
      if (!resolved) {
        if (name in optional) continue
        failures.push(`${manifest.name}: 本地缺少 ${name}`)
        continue
      }
      if (visited.has(resolved)) continue
      visited.add(resolved)
      const relative = path.relative(root, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`生产依赖不在项目中：${name}`)
      const local = read(resolved)
      try {
        const packed = JSON.parse(asar.extractFile(archive, path.join(relative, 'package.json')).toString('utf8'))
        if (packed.version !== local.version) failures.push(`${relative}: 需要 ${local.version}，包内为 ${packed.version}`)
      } catch { failures.push(`${relative}: 程序包缺少 ${local.name}@${local.version}`) }
      visit(resolved)
    }
  }
  visit(root)
  if (failures.length) throw new Error(`生产依赖或许可声明打包不完整：\n${failures.join('\n')}`)
  console.log(`  • verified packaged production dependencies  modules=${visited.size}`)
  console.log('  • verified packaged license notices  files=2')
  return visited.size
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  verifyPackagedDependencies(context.packager.projectDir, path.join(context.appOutDir, 'resources', 'app.asar'))
}
module.exports.verifyPackagedDependencies = verifyPackagedDependencies

if (require.main === module) {
  if (!process.argv[2]) throw new Error('请提供 app.asar 路径')
  verifyPackagedDependencies(path.resolve(__dirname, '..'), path.resolve(process.argv[2]))
}
