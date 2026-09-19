export function installSettingsLayout(onNavigate: () => void): void {
  const search = document.getElementById('settingsSearch') as HTMLInputElement
  const pages = [...document.querySelectorAll<HTMLElement>('[data-page]')]
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-section]')]
  const scroll = document.querySelector<HTMLElement>('.settings-scroll')!
  let selected = 'window'
  try { selected = localStorage.getItem('settingsSection') || selected } catch { /* 存储不可用仍可操作 */ }
  selected = new URLSearchParams(location.search).get('section') || selected
  if (!pages.some(page => page.dataset.page === selected)) selected = 'window'
  const apply = (): void => {
    const query = search.value.trim().toLocaleLowerCase()
    let matches = 0
    for (const page of pages) {
      let pageMatches = 0
      for (const group of page.querySelectorAll<HTMLElement>('[data-settings-group]')) {
        let groupMatches = 0
        for (const row of group.querySelectorAll<HTMLElement>('.setting-item')) {
          const match = !query || `${page.dataset.title} ${row.textContent} ${group.querySelector('h2')?.textContent}`.toLocaleLowerCase().includes(query)
          row.hidden = !match
          if (match) groupMatches++
        }
        group.hidden = groupMatches === 0
        pageMatches += groupMatches
      }
      page.hidden = query ? pageMatches === 0 : page.dataset.page !== selected
      if (!page.hidden) matches += pageMatches
    }
    for (const button of buttons) {
      if (!query && button.dataset.section === selected) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
    const current = pages.find(page => page.dataset.page === selected)!
    document.getElementById('settingsTitle')!.textContent = query ? '搜索设置' : current.dataset.title!
    document.getElementById('settingsDescription')!.textContent = query ? `“${search.value.trim()}”的相关选项` : current.dataset.description!
    document.getElementById('noResults')!.hidden = matches > 0
    document.dispatchEvent(new CustomEvent('settings-section-changed', { detail: selected }))
  }
  const navigate = (section: string): void => {
    if (!pages.some(page => page.dataset.page === section)) return
    onNavigate(); selected = section; search.value = ''
    try { localStorage.setItem('settingsSection', selected) } catch { /* 无需阻止分类切换 */ }
    apply(); scroll.scrollTop = 0
  }
  buttons.forEach(button => button.addEventListener('click', () => navigate(button.dataset.section!)))
  document.querySelectorAll<HTMLElement>('[data-settings-link]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.settingsLink!)))
  window.settingsApi.onSettingsSection(navigate)
  search.addEventListener('input', () => { onNavigate(); apply(); scroll.scrollTop = 0 })
  search.addEventListener('keydown', event => { if (event.key === 'Escape') { search.value = ''; apply() } })
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select() }
  })
  apply()
}
