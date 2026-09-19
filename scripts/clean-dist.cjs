const { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } = require('node:fs')
const { join, relative, resolve, sep, isAbsolute } = require('node:path')

function cleanGeneratedDirectory(root, child) {
  const workspace = realpathSync(root)
  const target = resolve(workspace, child)
  const local = relative(workspace, target)
  if (!['out', join('release', '.build')].includes(local) || isAbsolute(local) || local.startsWith('..' + sep)) {
    throw new Error('拒绝清理非编译目录：' + target)
  }
  let cursor = workspace
  for (const name of local.split(sep)) {
    cursor = join(cursor, name)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('拒绝清理目录链接：' + cursor)
  }
  if (!existsSync(target)) return
  const pending = [target]
  const directories = [], files = []
  while (pending.length) {
    const directory = pending.pop()
    directories.push(directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (/^(?:config\.json(?:\.bak)?|statistics|data|data\.douyu-danmaku-overlay)$/i.test(entry.name)) {
        throw new Error('发现配置或用户数据，已停止清理：' + join(directory, entry.name))
      }
      if (entry.isSymbolicLink()) throw new Error('拒绝清理目录中的链接：' + join(directory, entry.name))
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
      else files.push(join(directory, entry.name))
    }
  }
  // 路径已限定在工作区内，只删除确认过的编译中间目录。
  // 个别 Node 24 Windows 运行时的 recursive rm 在中文路径上会静默不删除，逐个调用并核验结果。
  for (const file of files) unlinkSync(file)
  for (const directory of directories.reverse()) rmdirSync(directory)
  if (existsSync(target)) throw new Error('编译目录未能清理：' + target)
}

module.exports = { cleanGeneratedDirectory }
if (require.main === module) {
  const root = resolve(__dirname, '..')
  cleanGeneratedDirectory(root, 'out')
  if (!process.argv.includes('--out-only')) cleanGeneratedDirectory(root, join('release', '.build'))
  console.log('已清理编译中间文件；配置、统计、release/data 和交付的 EXE 均保留。')
}
