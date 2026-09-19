# GitHub 上传与 Windows 发布

## 仓库与来源

发布仓库为 [qxpdev/Starveil](https://github.com/qxpdev/Starveil)。Starveil 使用独立的 Git 历史，从本项目的初始提交开始记录。项目基于 `qianjiachun/douyu-danmaku-overlay` 继续开发，原版权与 MIT 许可声明继续保留。

另一个参考来源是 [douyu-monitor/remix](https://github.com/qianjiachun/douyu-monitor/tree/main/remix)。README 和第三方声明同时列出两个来源。

项目根目录 `LICENSE` 保留原始的 `Copyright (c) 2026 小淳` 和 MIT 全文。`THIRD_PARTY_NOTICES.md` 包含两个上游的完整 MIT 声明及斗鱼资源说明。Windows 打包会核验这两个文件包含在程序内，并生成可随 Release 下载的 `Starveil-<版本>-NOTICES.txt`。

## 仓库设置

`origin` 指向 Starveil 发布仓库，可用以下命令核对地址：

```powershell
git remote -v
```

`package.json` 的 `repository.url`、`homepage`、`bugs.url` 与文档链接均指向 `qxpdev/Starveil`。程序的更新 API 从 `repository.url` 自动生成。后续若更换地址，更新这些元数据和文档；原作者项目的链接、许可证、`appId` 和数据目录标识继续保留。

正式版本发布在当前仓库的 Releases 中；只上传源码或创建发布草稿时，软件不会发现新的正式版本。

建议 GitHub About 描述：

> A Douyu chat tool for Windows with transparent overlays, gifts, live stats and searchable chat history. 星幕：斗鱼弹幕工具。

建议 Topics：`douyu`、`danmaku`、`overlay`、`windows`、`electron`、`typescript`。

## 检查和提交源码

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dist
pnpm release:notes
git diff --check
git status --short
git ls-files --others --exclude-standard
```

确认候选文件只有源码、测试、构建脚本、图标、文档和 GitHub 配置。`.gitignore` 已排除依赖、构建目录、交付 EXE、缓存和常见本地数据；仍应人工检查新增文件。`release/data` 和账户配置不属于上传内容。

使用 `git add -p` 审阅已有文件的改动；新文件按 `git status` 列出的明确路径添加。审阅 `git diff --cached` 后再提交、推送。后续开发在 Starveil 的现有历史上追加提交；参考上游修复时，移植所需改动并记录来源，保持本仓库独立的提交历史。

## GitHub Actions

- **Windows CI**：对 `main` 的推送、PR 或手动运行执行类型检查、测试和 Windows x64 打包；构建产物保留 7 天，不创建 Release。
- **Draft Windows release**：仅手动运行，必须填写已经推送的 `v版本号` 标签。检查标签与 `package.json` 相符后重新验证、构建，并创建带程序、校验文件和许可声明的 **草稿**。

Fork 仓库可能需要先在 Actions 页面启用工作流。工作流使用 GitHub 托管的 `windows-2022`；通常无需另配访问令牌，草稿步骤使用本仓库的 `GITHUB_TOKEN`。仓库或组织禁用 Actions、缓存或令牌写入时，需要维护者在 GitHub 设置中启用对应能力。

## 发布一个版本

1. 修改 `package.json` 的版本，在 `CHANGELOG.md` 顶部增加同名 `## 版本号` 条目。运行上述验证和实际 EXE 启动检查。
2. 提交并推送确认后的源码。在该提交上创建并推送匹配的标签，例如：

   ```powershell
   git tag -a v1.10.4 -m "Starveil v1.10.4"
   git push origin v1.10.4
   ```

3. 在 Actions → Draft Windows release → Run workflow 填入 `v1.10.4`。
4. 检查生成的 Release 草稿、发布说明和三个附件，确认后在 GitHub 点击 **Publish release**。草稿不会被软件的“检查更新”识别为正式版本。

也可手动创建 Release，选择相同标签，粘贴 `release/Starveil-<版本>-release-notes.md`，上传：

```text
Starveil-<版本>-win-x64.exe
Starveil-<版本>-win-x64.exe.sha256
Starveil-<版本>-NOTICES.txt
```

SHA-256 文件用于核对下载内容是否一致，构建流程不包含代码签名。运行新版前从托盘退出旧版，升级继续读取 `%APPDATA%/douyu-danmaku-overlay`。
