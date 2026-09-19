import { formatBytes, type CacheInventory, type CacheLocationInfo } from '../shared/storage'

export function installCacheSettings(beforeRestart: () => Promise<boolean>): void {
  const api = window.settingsApi
  const clear = document.getElementById('clearCache') as HTMLButtonElement
  const refresh = document.getElementById('refreshCache') as HTMLButtonElement
  const status = document.getElementById('cacheStatus')!
  const choose = document.getElementById('chooseCacheDirectory') as HTMLButtonElement
  const reset = document.getElementById('resetCacheDirectory') as HTMLButtonElement
  const open = document.getElementById('openCacheDirectory') as HTMLButtonElement
  const restart = document.getElementById('restartForCache') as HTMLButtonElement
  const locationStatus = document.getElementById('cacheLocationStatus')!
  let location: CacheLocationInfo | null = null
  let busy = false

  const renderLocation = (info: CacheLocationInfo): void => {
    location = info
    document.getElementById('cachePath')!.textContent = info.currentDirectory
    document.getElementById('cacheConfiguredPath')!.textContent = info.configuredDirectory
    document.getElementById('cacheNextLocation')!.hidden = !info.restartRequired
    document.getElementById('cacheRestartNotice')!.hidden = !info.restartRequired
    locationStatus.textContent = info.notice
    reset.disabled = busy || !info.custom
  }

  const render = (inventory: CacheInventory): void => {
    document.getElementById('cacheTotal')!.textContent = formatBytes(inventory.bytes)
    document.getElementById('historySize')!.textContent = formatBytes(inventory.historyBytes)
    document.getElementById('cachePath')!.textContent = inventory.directory
    const list = document.getElementById('cacheGroups')!
    list.replaceChildren(...inventory.groups.map(group => {
      const row = document.createElement('div')
      row.className = 'cache-group'
      const label = document.createElement('div'), name = document.createElement('strong'), description = document.createElement('span')
      name.textContent = group.name; description.textContent = group.description
      label.append(name, description)
      const size = document.createElement('span')
      size.className = 'cache-group-size'; size.textContent = formatBytes(group.bytes)
      row.append(label, size)
      return row
    }))
  }
  const pending = (value: boolean): void => {
    busy = value; clear.disabled = value; refresh.disabled = value
    choose.disabled = value; reset.disabled = value || !location?.custom; open.disabled = value; restart.disabled = value
    document.getElementById('cacheSummary')!.setAttribute('aria-busy', String(value))
  }
  const reload = async (): Promise<void> => {
    if (busy) return
    pending(true)
    try {
      const [inventory, info] = await Promise.all([api.getCacheInventory(), api.getCacheLocation()])
      render(inventory); renderLocation(info)
    }
    catch (error) { status.textContent = `无法读取缓存占用：${String(error)}` }
    finally { pending(false) }
  }
  refresh.addEventListener('click', () => { void reload() })
  const changeLocation = async (action: () => Promise<CacheLocationInfo | null>): Promise<void> => {
    if (busy) return
    pending(true)
    try {
      const info = await action()
      if (info) {
        renderLocation(info)
        locationStatus.textContent = info.restartRequired ? '位置已保存，当前仍使用原目录，重启后切换。' : '已保存缓存位置。'
      }
    } catch (error) { locationStatus.textContent = `缓存位置未更改：${String(error)}` }
    finally { pending(false) }
  }
  choose.addEventListener('click', () => { void changeLocation(() => api.chooseCacheDirectory()) })
  reset.addEventListener('click', () => { void changeLocation(() => api.resetCacheDirectory()) })
  open.addEventListener('click', () => { void api.openCacheDirectory().then(error => { if (error) locationStatus.textContent = error }).catch(error => { locationStatus.textContent = String(error) }) })
  restart.addEventListener('click', async () => {
    if (busy || !await beforeRestart()) return
    pending(true)
    try { await api.restartApp() }
    catch (error) { locationStatus.textContent = `未能重启：${String(error)}`; pending(false) }
  })
  api.onConfig(() => { void api.getCacheLocation().then(renderLocation).catch(() => {}) })
  clear.addEventListener('click', async () => {
    if (busy) return
    pending(true)
    status.textContent = '正在计算清理范围，确认后才会删除…'
    try {
      const result = await api.clearCache()
      if (result.canceled) { status.textContent = '已取消，没有删除任何文件。'; return }
      render(result.inventory)
      status.textContent = `已释放 ${formatBytes(result.releasedBytes)}。配置、统计和弹幕记录均已保留。`
      if (result.skipped || result.warnings.length || result.inventory.skipped) status.textContent += ' 部分文件正在使用或是目录链接，已跳过。'
      else if (result.inventory.bytes > 0) status.textContent += ' 运行中的程序可能重新生成少量缓存。'
    } catch (error) { status.textContent = `缓存清理未完成：${String(error)}` }
    finally { pending(false) }
  })
  document.querySelector('[data-section="storage"]')!.addEventListener('click', () => { void reload() })
  void reload()
}
