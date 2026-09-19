const { createRequire } = require('node:module')
const { mkdtempSync, rmSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const fromVite = createRequire(require.resolve('vite'))
const esbuild = fromVite('esbuild')
const directory = mkdtempSync(join(tmpdir(), 'douyu-unit-'))
try {
  const entryPoints = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.ts')).map(name => join(root, 'tests', name))
  esbuild.buildSync({ entryPoints, outdir: directory, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning' })
  const result = spawnSync(process.execPath, ['--test', ...readdirSync(directory).filter(name => name.endsWith('.cjs')).map(name => join(directory, name))], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory')
  rmSync(directory, { recursive: true, force: true })
}
