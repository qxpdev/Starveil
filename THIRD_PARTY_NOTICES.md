# 第三方来源与许可 / Third-party notices

Starveil（星幕）基于以下开源项目继续开发。保留原作者的版权声明与完整许可，项目名称变化不改变这些要求。本文件与根目录 LICENSE 均包含在 Windows 程序中，发布附件另提供一份可直接阅读的副本。

Starveil is derived from or references the projects below. Their copyright and permission notices are retained in source and binary distributions.

## 1. douyu-danmaku-overlay

- 来源 / Source: https://github.com/qianjiachun/douyu-danmaku-overlay
- 原作者 / Original author: 小淳 (qianjiachun)
- 关系 / Relationship: Starveil 的主要代码基础，包括 Electron 应用、弹幕浮层与设置的原始实现；本仓库保留上游提交历史。
- 原许可 / Upstream license: https://github.com/qianjiachun/douyu-danmaku-overlay/blob/main/LICENSE

```text
MIT License

Copyright (c) 2026 小淳

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. douyu-monitor / remix

- 来源 / Source: https://github.com/qianjiachun/douyu-monitor/tree/main/remix
- 原作者 / Original author: 小淳 (qianjiachun)
- 关系 / Relationship: 斗鱼 WebSocket 协议、基础礼物目录等实现的参考来源。
- 目录许可 / Directory license: https://github.com/qianjiachun/douyu-monitor/blob/main/remix/LICENSE
- 仓库许可 / Repository license: https://github.com/qianjiachun/douyu-monitor/blob/main/LICENSE

```text
MIT License

Copyright (c) 2022 小淳

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 斗鱼资源

普通表情映射取自斗鱼官网公开脚本 `live-next-player-aside_a1dae71.js`（2026-09-07）。钻粉梗、钻粉和房间表情通过官网目录接口更新；图片通过斗鱼 CDN 按需加载。本项目不捆绑完整表情图片包，素材版权归斗鱼及原作者所有。

礼物图片与特效来自斗鱼礼物目录 `gift.douyucdn.cn`；通用礼物条来自 `/api/gift/v1/web/commonConfig`。广播中的 `eic`、`bnidv2`、`skinid` 对应关系核对自公开脚本 `BarrageGroup_c8d2c66_c65642b.js`。按需使用官方 CDN 素材，不捆绑或执行官网脚本，素材版权归斗鱼及原作者所有。VAP 解码器依据 MP4 内的 `vapc` RGB/Alpha 矩形实现，未引入官方播放器代码。

Electron、ExcelJS、ws 等依赖沿用各自分发包中的许可。

上述 MIT 许可仅覆盖相应软件代码，不授予斗鱼品牌、表情、礼物或其他第三方素材的版权。Starveil 的名称和新增实现不表示原作者或斗鱼对本项目的背书。
The MIT notices above apply to the respective software code, not to third-party branding or media assets. Starveil does not imply endorsement by the upstream authors or Douyu.
