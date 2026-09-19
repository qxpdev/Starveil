import { createHash } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { APP_NAME } from './appMetadata'

export interface InstanceGuard { close: () => Promise<void> }

/** 固定账户配置目录决定互斥名，不依赖 EXE 文件名、版本或便携包解压目录。 */
export function instanceEndpoint(directory: string): string {
  const absolute = resolve(directory)
  const identity = absolute.toLocaleLowerCase('en-US')
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return `\\\\.\\pipe\\douyu-overlay-${hash}`
}

function notifyExisting(endpoint: string): Promise<boolean> {
  return new Promise(resolveResult => {
    const socket = createConnection(endpoint)
    let reply = '', finished = false
    const finish = (ok: boolean): void => {
      if (finished) return
      finished = true
      socket.destroy()
      resolveResult(ok)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(1500, () => finish(false))
    socket.on('connect', () => socket.write('activate\n'))
    socket.on('data', chunk => { reply += chunk; if (reply.includes('\n')) finish(reply.trim() === 'ok') })
    socket.on('error', () => finish(false))
    socket.on('end', () => finish(reply.trim() === 'ok'))
  })
}

/** 与 Electron 内置锁共同使用；第二次启动只唤回已有主窗口。 */
export async function acquireInstanceGuard(directory: string, activate: () => void): Promise<InstanceGuard | null> {
  const endpoint = instanceEndpoint(directory)
  for (let attempt = 0; attempt < 3; attempt++) {
    const guard = await new Promise<InstanceGuard | null>((resolveGuard, reject) => {
      const sockets = new Set<Socket>()
      const server = createServer(socket => {
        sockets.add(socket)
        let command = ''
        socket.setEncoding('utf8')
        socket.setTimeout(1500, () => socket.destroy())
        socket.on('error', () => socket.destroy())
        socket.on('close', () => sockets.delete(socket))
        socket.on('data', chunk => {
          command += chunk
          if (command.length > 64) { socket.destroy(); return }
          if (!command.includes('\n')) return
          if (command.trim() === 'activate') { activate(); socket.end('ok\n') }
          else socket.destroy()
        })
      })
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolveGuard(null)
        else reject(error)
      }
      server.once('error', onError)
      server.listen(endpoint, () => {
        server.removeListener('error', onError)
        server.on('error', error => console.error('[single-instance]', error))
        let closed = false
        resolveGuard({ close: () => new Promise<void>(resolveClose => {
          if (closed) { resolveClose(); return }
          closed = true
          server.close(() => resolveClose())
          for (const socket of sockets) socket.destroy()
        }) })
      })
    })
    if (guard) return guard
    if (await notifyExisting(endpoint)) return null
    await new Promise<void>(done => setTimeout(done, 120))
  }
  throw new Error(`已有 ${APP_NAME} 实例占用配置，但暂时无法唤回。请从托盘退出已有程序后重新打开。`)
}
