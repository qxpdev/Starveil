# 参与开发 / Contributing

Starveil 是基于 [douyu-danmaku-overlay](https://github.com/qianjiachun/douyu-danmaku-overlay) 继续开发的 Windows 应用，并参考 [douyu-monitor/remix](https://github.com/qianjiachun/douyu-monitor/tree/main/remix)。保留原作者的版权和许可证声明。

Starveil is a Windows application derived from douyu-danmaku-overlay, with additional references to douyu-monitor/remix. Keep upstream copyright and license notices intact.

## 开发

需要 Windows 10/11 x64、Node.js 20+（CI 使用 Node.js 22）和 pnpm 9.15.9。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm dist
```

开发时可以为 Electron 传入 `--user-data-dir=绝对路径`，使用独立测试配置；正常开发启动会读取当前账户的数据。只维护 Windows 版本，不引入其他平台的构建分支。

## 提交范围

- 一个 PR 解决一组相关问题，说明触发条件、修改结果和验证方式。
- 保持现有配置兼容，缓存清理必须保护配置、手动补价、统计和已保存的弹幕。
- 动画修改需验证连续消息、消息到期、礼物顶部停留和系统减少动态效果设置。
- 礼物金额、抽奖归属和用户消费需使用可验证的来源；接口缺失时明确显示未知状态。
- 提交外部代码时在 `THIRD_PARTY_NOTICES.md` 记录来源和许可，保留需要的声明。
- 不提交 `node_modules`、编译输出、EXE、用户配置、缓存、统计、真实弹幕历史或凭证。

Please describe the problem, resulting behavior and validation in each PR. Keep stored data compatible, include licenses for borrowed code, and leave generated files and personal records out of commits. Contributions are distributed under the project's MIT license.
