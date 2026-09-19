<p align="center">
  <img src="resources/icon.svg" width="88" height="88" alt="Starveil icon" />
</p>

# Starveil · 星幕

**A Douyu chat tool for Windows.** View chat, gifts and room statistics, and search locally saved messages.

[简体中文](README.md) · [Download for Windows](https://github.com/qxpdev/Starveil/releases) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

[![Windows CI](https://github.com/qxpdev/Starveil/actions/workflows/windows.yml/badge.svg)](https://github.com/qxpdev/Starveil/actions/workflows/windows.yml)
![Platform](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D4)
[![License: MIT](https://img.shields.io/badge/License-MIT-3d8878)](LICENSE)

Also known as 星幕. Built with Electron and TypeScript for **Windows 10 / 11 x64**. The application interface is currently in Chinese.

## Preview

| Edge mode | Upward message flow |
| --- | --- |
| <img src="docs/images/edge-flow.gif" width="460" alt="Messages enter from the right, move upward and show gift totals" /> | <img src="docs/images/upward-flow.gif" width="360" alt="New chat messages smoothly move the stream upward" /> |

Captured from the app using simulated messages. The dark backdrop makes the transparent overlay visible; typography, layout, opacity and motion are configurable.

## Features

- Transparent windows, multiple displays, always on top, mouse passthrough and remembered positions.
- Horizontal, vertical and edge modes with smooth nonlinear motion and adjustable speed. Respects reduced motion.
- Edge messages arrive immediately and move upward together. A gift can remain at the top while messages below continue moving.
- Transparent gift rows, clear amounts and value colors. Lottery spending, received rewards and unknown prices remain distinct.
- Douyu gift images, official banners and supported VAP animations, matched to the actual event and catalog. Unsupported animation formats fall back to images.
- Standard, diamond fan, meme and room emotes, with plain text fallback.
- An optional persistent statistics bar with independent position, size and opacity.
- Daily records, per-user gifts and recorded spending, optional chat history, and Excel export.
- Configurable cache location and a cleanup confirmation showing what can be removed and what is preserved.

High-energy message text is shown only when a new event is received and Douyu returns its content. Platform responses and supported media formats determine which official effects are available.

## Getting started

1. Download `Starveil-<version>-win-x64.exe` from [Releases](https://github.com/qxpdev/Starveil/releases). Node.js is not required to run it. Older releases may use the Chinese name 星幕.
2. Check or replace the prefilled Douyu room ID, or paste a room URL, then click **启动飘屏** to start the overlay.
3. Open **调整外观与规则** to customize it. Appearance sliders update the overlay as you drag; the **已保存** status confirms persistence after release.
4. Closing the main window minimizes the app to the system tray. Use **退出** in the tray menu to quit completely before upgrading.

The initial preset uses the right screen edge, 18px text, 1.0 line height, a transparent gift background and a persistent bottom statistics bar. The overlay starts disabled; daily statistics are enabled and chat text storage is disabled. Existing saved settings take precedence.

Enable chat text storage separately if you need to review past messages. Recorded spending covers events received locally in the selected room; it cannot recover offline activity or earlier messages. Lottery rewards are recorded separately from spending.

## Storage and upgrades

Settings and records stay in `%APPDATA%/douyu-danmaku-overlay/`, including after the Starveil rename:

```text
config.json              Settings and manual gift prices
config.json.bak          Previous valid configuration
cache-paths.json          Known cache locations
statistics/              Daily, user and gift records
statistics/danmaku/      Chat text saved after opting in
cache/                   Resource and runtime caches
```

Custom cache locations use an owned `xingmu-cache` subdirectory and take effect after restart. Cleanup asks for confirmation and preserves settings, manual prices, statistics and saved chat. The legacy data and cache identifiers remain stable for compatibility.

See the [usage guide in Chinese](docs/usage.md) for migration, accounting rules and media sources.

## Development and releases

Requires Windows, Node.js 20+ and pnpm 9.15.9. CI uses Node.js 22. The Windows desktop-state helper is compiled with the .NET Framework C# compiler included in Windows.

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm dist
pnpm release:notes
```

`pnpm dist` writes the Windows portable executable, a SHA-256 file and license notices to `release/`, verifies packaged dependencies and notices, and removes build intermediates. `pnpm release:notes` generates notes for the package version from the changelog.

The Windows CI workflow checks and builds the app. The separate release workflow is started manually for an existing version tag and creates a **draft** with artifacts for review. See [publishing instructions](docs/PUBLISHING.md).

## Credits and license

Starveil is derived from [qianjiachun/douyu-danmaku-overlay](https://github.com/qianjiachun/douyu-danmaku-overlay) and also references [qianjiachun/douyu-monitor/remix](https://github.com/qianjiachun/douyu-monitor/tree/main/remix). Both projects are by **小淳 (qianjiachun)** and licensed under **MIT**.

Distributed under [MIT](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.md) retain both upstream copyright notices and full licenses and are included in Windows distributions.
