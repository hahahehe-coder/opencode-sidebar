# OpenCode WebUI Sidebar

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/hahahehe.opencode-webui-sidebar?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=hahahehe.opencode-webui-sidebar)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/hahahehe.opencode-webui-sidebar)](https://marketplace.visualstudio.com/items?itemName=hahahehe.opencode-webui-sidebar)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**在 VS Code 侧边栏里使用官方的 OpenCode WebUI。** 不是又一个重写,不是嵌入一个 TUI 终端,而是把 OpenCode 官方那套完整、现代、持续迭代的 Web 界面,原封不动装进你的侧边栏。

## 现有的 OpenCode 插件,为什么都不好用?

claude code 和 codex 都有好用的 VSCode 拓展，但当你尝试查找 opencode 拓展时，却发现，为啥都不怎么好用呢？

坦白说:

- ❌ **第三方插件年久失修**——opencode 迭代飞快,插件作者跟不上,聊天界面停留在几个版本前,Agent、终端、权限审批等新能力永远"开发中"
- ❌ **官方 VS Code 集成只是开了个 TUI**——在 VS Code 终端面板里跑一个终端 UI,体验非常别扭
- ❌ **自己重写 UI 的插件**——重写意味着滞后、缺功能、bug 修不完

## OpenCode Sidebar 的思路:官方 WebUI 已经很完善,直接用它

OpenCode 官方的 WebUI 已经具备一切:完整的聊天流、会话管理、内嵌终端、文件差异、权限审批、MCP 工具展示……**这套界面由 opencode 官方团队持续打磨,永远最新。**

所以这个扩展只做一件事:**把官方 WebUI 无损装进 VS Code 侧边栏**。

- ✅ **功能零缺失零滞后**——官方 WebUI 有的全都有,opencode 升级即升级,插件本身永远不需要"跟进适配"
- ✅ **打开项目即用**——自动定位到当前工作区的项目页,历史会话整齐排列,不用手动选目录
- ✅ **真·侧边栏体验**——辅助侧栏常驻(`Ctrl+Alt+B` 呼出),边写代码边对话,不用切窗口
- ✅ **主题实时同步**——VS Code 换深浅主题,OpenCode 跟着换,毫无违和
- ✅ **终端、SSE、WebSocket 全透传**——PTY 终端和事件流在侧边栏里和浏览器里一模一样

## 快速开始

1. 安装 [OpenCode CLI](https://opencode.ai) 并确保 `opencode --version` 可用
2. 安装本扩展(从 VS Marketplace 或 vsix)
3. 打开任意项目文件夹 → 点击侧边栏的 OpenCode 图标 → 开聊

## 工作原理

```
VS Code 侧边栏 → WebviewView
    └─ <iframe sandbox> ──► 本地反向代理 http://127.0.0.1:<port>/
                                   └─► opencode serve (127.0.0.1)
主题链路: VS Code 主题切换 → postMessage → iframe shim → 实时换肤
```

扩展不实现任何业务逻辑:启动一个 `opencode serve`,用薄反向代理解决 iframe 嵌入限制并注入工作区绑定/主题 shim,其余一切交给官方 WebUI。这也意味着:**插件本身几乎不会坏**——坏的只会是 opencode,而修 opencode 不是你的事。

## 平台支持

| Windows | macOS | Linux |
|:---:|:---:|:---:|
| ✅ | ✅ | ✅ |

> 仅限本地场景;Remote-SSH / DevContainer 需端口转发,后续版本支持。

## 开发

```bash
npm install
npm run build        # esbuild 打包 → dist/
npm test             # 集成测试(真实拉起 opencode serve + 代理,断言注入/透传/WS 升级)
npm run package      # 生成 .vsix
```

按 `F5` 启动扩展开发宿主调试。

## 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `opencodeSidebar.serverPath` | `""` | opencode 可执行文件路径;留空使用 PATH 中的 `opencode` |
| `opencodeSidebar.proxyPort` | `0` | 本地代理端口;`0` 表示随机空闲端口 |

## License

[MIT](LICENSE)
