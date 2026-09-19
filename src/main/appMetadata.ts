import packageInfo from '../../package.json'

export const APP_NAME = packageInfo.build.productName
export const APP_DISPLAY_NAME = `${APP_NAME} · 星幕`

// 更新地址跟随 package.json 中的真实仓库，仓库改名时只需修改项目元数据。
const repositoryUrl = packageInfo.repository.url.replace(/\.git$/, '').replace(/\/$/, '')
export const GITHUB_LATEST_API = repositoryUrl.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest'
