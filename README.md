# OpenCode WebUI Sidebar / OpenCode WebUI 侧边栏

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/hahahehe.opencode-webui-sidebar?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=hahahehe.opencode-webui-sidebar)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/hahahehe.opencode-webui-sidebar)](https://marketplace.visualstudio.com/items?itemName=hahahehe.opencode-webui-sidebar)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[中文](#中文) | [English](#english)

---

## 中文

**在 VS Code 侧边栏里使用官方的 OpenCode WebUI。** 不是又一个重写,不是嵌入一个 TUI 终端,而是把 OpenCode 官方那套完整、现代、持续迭代的 Web 界面,原封不动装进你的侧边栏。

### 现有的 OpenCode 插件,为什么都不好用?

Claude Code 和 Codex 都有好用的 VS Code 扩展,但当你想给 OpenCode 找一个时,却发现为啥都不怎么好用?

坦白说:

- ❌ **第三方插件年久失修**——opencode 迭代飞快,插件作者跟不上,聊天界面停留在几个版本前,有些集成 webui 的其他项目,项目页展示异常,可能看不到之前的会话列表,只能新建会话
- ❌ **官方 VS Code 集成只是开了个 TUI**——在 VS Code 终端面板里跑一个终端 UI,体验非常别扭
- ❌ **自己重写 UI 的插件**——重写意味着滞后、缺功能、bug 修不完

### OpenCode WebUI Sidebar 的思路:官方 WebUI 已经很完善,直接用它

OpenCode 官方的 WebUI 已经具备一切:完整的聊天流、会话管理、内嵌终端、文件差异、权限审批、MCP 工具展示……**这套界面由 opencode 官方团队持续打磨,永远最新。**

所以这个扩展只做一件事:**把官方 WebUI 无损装进 VS Code 侧边栏**。

- ✅ **功能零缺失零滞后**——官方 WebUI 有的全都有,opencode 升级即升级,插件本身永远不需要"跟进适配"
- ✅ **打开项目即用**——自动定位到当前工作区的项目页,历史会话整齐排列,不用手动选目录
- ✅ **真·侧边栏体验**——辅助侧栏常驻(`Ctrl+Alt+B` 呼出),边写代码边对话,不用切窗口
- ✅ **主题实时同步**——VS Code 换深浅主题,OpenCode 跟着换,毫无违和
- ✅ **终端、SSE、WebSocket 全透传**——PTY 终端和事件流在侧边栏里和浏览器里一模一样

### 展示

**项目页:打开项目即自动定位,历史会话一目了然**

![项目页](images/project_page.png)

**对话页:官方 WebUI 完整体验,常驻侧边栏** 建议使用 Ctrl+Alt+B 切换辅助侧栏

![对话页](images/sidebar.png)

### 快速开始

1. 安装 [OpenCode CLI](https://opencode.ai) 并确保 `opencode --version` 可用
2. 安装本扩展(从 VS Marketplace 或 vsix)
3. 打开任意项目文件夹 → 点击侧边栏的 OpenCode 图标 → 开聊

### 工作原理

```
VS Code 侧边栏 → WebviewView
    └─ <iframe sandbox> ──► 本地反向代理 http://127.0.0.1:<port>/
                                   └─► opencode serve (127.0.0.1)
主题链路: VS Code 主题切换 → postMessage → iframe shim → 实时换肤
```

扩展不实现任何业务逻辑:启动一个 `opencode serve`,用薄反向代理解决 iframe 嵌入限制并注入工作区绑定/主题 shim,其余一切交给官方 WebUI。这也意味着:**插件本身几乎不会坏**——坏的只会是 opencode,而修 opencode 不是你的事。

### 平台支持

| Windows | macOS | Linux |
|:---:|:---:|:---:|
| ✅ | ✅ | ✅ |

> 仅限本地场景;Remote-SSH / DevContainer 需端口转发,后续版本支持。

### 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `opencodeSidebar.serverPath` | `""` | opencode 可执行文件路径;留空使用 PATH 中的 `opencode` |
| `opencodeSidebar.proxyPort` | `0` | 本地代理端口;`0` 表示随机空闲端口 |

---

## English

**Use the official OpenCode WebUI right inside your VS Code sidebar.** Not yet another rewrite. Not a TUI crammed into a terminal panel. The complete, modern, continuously-iterated official OpenCode web interface — embedded as-is in your sidebar.

### Why do existing OpenCode extensions suck?

Claude Code and Codex both have great VS Code extensions. Try to find one for OpenCode and... why are they all so painful to use?

Honestly:

- ❌ **Third-party extensions are abandoned** — opencode moves fast, extension authors can't keep up. The chat UI lags versions behind. Some projects that integrate the WebUI even show the project page incorrectly — you may not see your previous session list at all and can only create new sessions
- ❌ **The official VS Code integration is just a TUI** — a terminal UI running in the terminal panel. No session management, no click interactions. Feels extremely awkward
- ❌ **Extensions that rewrite the UI** — rewriting means lagging behind, missing features, and endless bugs

### The OpenCode WebUI Sidebar approach: the official WebUI is already great — just use it

The official OpenCode WebUI already has everything: full chat streams, session management, embedded terminal, file diffs, permission approvals, MCP tool inspection... **polished continuously by the opencode team, always up to date.**

So this extension does exactly one thing: **embed the official WebUI losslessly into the VS Code sidebar.**

- ✅ **Zero missing features, zero lag** — everything the official WebUI has, you get. When opencode upgrades, so do you. This extension never needs "catching up"
- ✅ **Open a project and go** — automatically opens the current workspace's project page with its full session history. No manual directory picking
- ✅ **A real sidebar experience** — lives in the secondary sidebar (`Ctrl+Alt+B`), chat while you code, no window switching
- ✅ **Live theme sync** — switch VS Code between light/dark and OpenCode follows instantly
- ✅ **Terminal, SSE, WebSocket — fully passthrough** — PTY terminals and event streams behave exactly like in the browser

### Demo

**Project page: opens your workspace automatically, session history at a glance**

![Project page](images/project_page.png)

**Chat page: the full official WebUI, docked in your sidebar** — press `Ctrl+Alt+B` to toggle the secondary sidebar

![Chat page](images/sidebar.png)

### Getting Started

1. Install the [OpenCode CLI](https://opencode.ai) and make sure `opencode --version` works
2. Install this extension (from VS Marketplace or vsix)
3. Open any project folder → click the OpenCode icon in the sidebar → start chatting

### How it works

```
VS Code sidebar → WebviewView
    └─ <iframe sandbox> ──► local reverse proxy http://127.0.0.1:<port>/
                                   └─► opencode serve (127.0.0.1)
Theme: VS Code theme change → postMessage → iframe shim → live reskin
```

The extension implements zero business logic: it spawns an `opencode serve`, puts a thin reverse proxy in front of it to solve iframe embedding restrictions and inject a workspace-binding/theme shim, and leaves everything else to the official WebUI. Which means: **this extension can barely break** — the only thing that breaks is opencode itself, and fixing that isn't your job.

### Platform Support

| Windows | macOS | Linux |
|:---:|:---:|:---:|
| ✅ | ✅ | ✅ |

> Local sessions only; Remote-SSH / DevContainer require port forwarding — planned for a future release.

### Settings

| Setting | Default | Description |
|---|---|---|
| `opencodeSidebar.serverPath` | `""` | Path to the opencode executable. Leave empty to use `opencode` from PATH |
| `opencodeSidebar.proxyPort` | `0` | Port for the local proxy. `0` picks a random free port |

### License

[MIT](LICENSE)
