# PLAN-03：顶部导航栏与项目 Tab 栏 UI 重设计（交付）

本次只改 UI 结构 / 视觉 / 交互反馈，未重写功能逻辑。完成后停止，未改 Settings 页面。

## 1. 修改文件清单

| 文件 | 改动 |
|---|---|
| `src/renderer/tabbar/index.html` | 顶部栏重排为 `.tabs + .drag-strip + .window-tools(.tool-actions + .status + .window-controls)`；4 个功能按钮统一 `tool-button` + 16px SVG；服务状态拆成端口 / 次要信息两段；新增 WCO 安全区占位 |
| `src/renderer/tabbar/style.css` | 顶部栏 / 页签 / 工具区 / 状态胶囊 / 多 Pane 的视觉规范；窄窗口媒体查询；reduced-motion；`--tool-size` 等尺寸变量 |
| `src/renderer/tabbar/tabbar.ts` | `renderStatus()` 支持四态指示 + 端口主信息；Tooltip 完整标题换行；分屏 Pane 的 `+` 换成统一 SVG 按钮；移除不再使用的 `STATUS_SUFFIX` |
| `src/main/index.ts` | 仅 1 行调试探针：`DEBUG_THEME` 日志改读 `.window-controls` 的宽度（原读 `.tabbar` 的 `paddingRight`） |
| `scripts/check-topbar-ui.mjs` | 新增：顶部栏 UI 结构 / 拖动区 / 固定槽位 / 原有拖拽事件绑定的静态回归（42 项断言，含标题行高防裁切） |
| `package.json` | 新增 `check:topbar-ui`，并接入 `check` / `check:all` 链 |

未改动：pi-web 上游、`TabManager` 核心逻辑、`Split Tree` 数据模型 / 拖放算法、Tab ID / 项目归属、IPC 与 preload API、`TabStatusManager`、独立输入工作区逻辑、服务启停、Settings 页面。

## 2. 顶部栏布局调整

单行 40px（高度未变）：

```
[ .tabs 页签（可横向滚动，压缩时省略号） ][ .drag-strip 连续拖动区 ]
[ .window-tools: (分屏 独立输入 新建Tab 设置) | 状态胶囊 | WCO 安全区 ]
```

- 4 个按钮统一 32px 点击区、16px 图标、4px 间距；默认透明、Hover `--bg-hover`、Active（分屏 / 独立输入开启）用 `color-mix(--accent 16%)` 的克制强调色，无独立边框。
- 服务状态改为 24px 高胶囊：状态点 + 端口号（主）+ `vX.Y.Z / 复用 / 启动失败`（次要，弱化且窄窗口隐藏）。四态反馈：`ready+managed` 绿、`ready+!managed` 琥珀、`failed` 红且胶囊染红、启动中蓝点呼吸。数据来源仍是 `getServerState()` / `onServerState()`，点击行为保持原样（只有原生 Tooltip，未加服务管理入口）。
- 按钮事件、`newTabButton.hidden = splitMode`、分屏按钮菜单、`draft-toggle` 的 `is-on` / `disabled` 全部沿用原有处理。

## 3. 项目 Tab 栏视觉设计

- 活动 Tab：圆角浮动块 + `color-mix(--bg-selected 88%, --accent)` 背景 + 2px 强调底线；非活动透明底、文字 `--text-muted`、Hover `--bg-hover`，无逐 Tab 边框。
- 图标固定 14px 槽位（loading 转圈也改成 14px），标题 `flex:1 + 单行省略`，原生 Tooltip 显示完整标题并在第二行显示状态文案；图标与标题不互相挤压。
- **标题行高 `line-height: 1.45`**：`overflow: hidden` 是实现省略号必需的，行盒不能压到 `1`，否则 `g / p / y` 的下降部会被裁掉（实测 `sgs_web_week` 的 `g` 下环被切平）。已加静态断言 `标题行高足够容纳 g/p/y 下降部` 防回归。
- 关闭按钮固定 18px 槽位，只改透明度：非活动 Hover 显示、活动常显，Hover 有轻量底色；固定 Tab 的隐藏规则不变。
- Agent 状态沿用 `TabStatusManager` 已有的 `idle/running/unread/awaiting`：转圈 / 蓝点（回答完毕）/ 橙点（需确认）/ 不显示，固定 12px 槽位、不占标题空间、状态切换不重排。项目身份与运行状态是两套独立视觉表达。
- 多 Pane：`.tabbar` 与 `.pane-tabbar` 共用同一条基础规则；焦点 Pane 底边加强调色，非焦点 Pane 的 active Tab 背景与底线弱化但仍可辨认、可操作。窗口宽度不足时 `.tabs` 收缩并横向滚动，按钮与窗口控件不被遮挡（已加 1120 / 960px 媒体查询）。

## 4. 项目标识的数据来源说明

**调查结论：渲染层没有可靠的项目身份数据。**

`TabInfo` 只有 `id / title / favicon / pinned / loading / status / crashed / crashReason`，没有 `projectId`、项目名、项目图标或项目分组。`favicon` 是 pi-web 的静态站点图标（所有 Tab 相同，`page-favicon-updated` 刻意忽略全局 badge）；`title` 来自 `page-title-updated`（`cleanTitle` 去掉 " - Pi Web" 后缀），实际就是 pi-web 的会话 / 项目名（截图中 `pi-web-desktop`、`sgs_web_week`、`sgs_web_month`、`person`）。主进程 `Tab.path` 里可能有 `?cwd=` / `?session=`，但未下发，且切会话后 URL 会在两者间变化，不能作为稳定项目身份。

因此按 Plan 4.2 的约束：**不新增项目颜色 / 分组管理、不要求用户配置、不从标题猜项目、不构造新身份规则**。Tab 识别继续使用已有的「站点小图标 + 完整标题」，只提升排版与可读性；同一项目的 Tab 表现一致。`--status-unread/--status-awaiting` 只用于 Agent 状态，与项目识别无关。

## 5. Electron 窗口拖动区域处理

- 自绘标题栏仍是 `titleBarStyle: "hidden" + titleBarOverlay`（WCO，Windows 原生绘制最小化 / 最大化·还原 / 关闭）。原生控件本身具备统一图标、最大化/还原图标切换、关闭 Hover 变红；**未自绘控件、未新增 IPC / preload API、未改窗口控制行为**。
- `-webkit-app-region: drag` 只保留在 `.drag-strip`（分屏时仅 `.pane-tabbar.is-top .drag-strip`），`flex: 1 1 auto` 自然伸缩；所有按钮、状态胶囊、页签、关闭按钮、分隔条均为 `no-drag`。
- 双击最大化 / 还原由 Windows 对 `HTCAPTION` 的原生处理提供（Electron 把 drag 区域映射为非客户区），无需额外 JS/IPC。
- WCO 安全区从原来的 `.tabbar` `padding-right: max(...,146px)` 改为**显式独立区域** `.window-controls`：`width: var(--wco-safe-width)` = `max(100vw - env(titlebar-area-x) - env(titlebar-area-width), 140px)`，加容器 6px 内边距 ≈ 原 146px 兜底；左侧一条 1px 极轻分界线。`data-titlebar="native"`（系统标题栏 / 非 Windows）时该区域 `display: none`，不预留空白。
- 分屏时同一份 `.window-tools` DOM 仍挂到 `topRightPaneIndex` 那条 Pane 页签条，安全区随之只出现在最右上 Pane。

## 6. 测试和构建结果

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（main / preload / renderer 全部产出） |
| `npm run check:topbar-ui`（新增 42 项） | 通过 |
| `npm run check:all`（typecheck + 20 项静态回归 + smoke） | 通过（`smoke` 实际拉起 pi-web v0.17.0，GET / 与 /?session= 均 200） |
| 深色 / 浅色主题 | 均已实机验证（跟随页面 `--*` 变量，无新配色体系） |
| 正常 / 最大化 / 分屏 / 900px 窄窗口 | 均已实机验证，顶部栏高度未增加 |

> 验证过程的前后对比截图属于临时产物，已按交付要求清理，不留在仓库中。需要复现时用隔离 profile 启动并截图，例如（PowerShell）：
> `$env:PORTABLE_EXECUTABLE_DIR = "<临时目录>"; $env:PI_WEB_DESKTOP_TABBAR_SHOT = "<输出路径>"; $env:PI_WEB_DESKTOP_AUTOQUIT_MS = "20000"; npm run app`
> 分屏另加 `$env:PI_WEB_DESKTOP_SELFTEST_SPLIT = "columns-2"; $env:PI_WEB_DESKTOP_SPLIT_SHOT = "<输出路径>"`。截图由 `BrowserWindow.capturePage()` 生成，只含外壳渲染层；子 `WebContentsView`（pi-web 内容）与 OS 绘制的 WCO 控件不会被合成进去，因此内容区留白、右上角看不到原生窗口按钮——这是采集方式的限制，不是 UI 缺失。

## 7. 未能实际验证的项目

- **Windows 原生 WCO 按钮的 Hover 变红 / 最大化↔还原图标切换**：属系统绘制，`capturePage` 无法采集，未做像素级验证；其行为由 `titleBarOverlay` 原生保证，本次未改。
- **真实鼠标交互回归**：窗口拖动、双击最大化、最小化 / 最大化 / 还原 / 关闭、Tab 切换 / 关闭 / 固定 / 排序、跨 Pane 与跨项目拖拽、五方向投放高亮、分隔条拖动、右键菜单、服务状态点击，均通过源码绑定 + 静态检查确认保留，但**未做真人逐项点击回归**。
- **服务 `failed` / 启动中相位的胶囊外观**：`renderStatus` 分支与样式已实现，`check:topbar-ui` 覆盖四态选择器，但未在异常服务下实机验证。
- **macOS / Linux 与 `PI_WEB_DESKTOP_NATIVE_TITLEBAR=1` 系统标题栏模式**：本机仅 Windows WCO，`data-titlebar="native"` 分支只做了 CSS 静态检查。
- **Agent 状态 `running / unread / awaiting` 的动态演示**：沿用原有 `TabStatusManager`，本次未改；可用 `PI_WEB_DESKTOP_SELFTEST_STATUS=1` 按 `docs/TESTING.md` 第 21 条人工复核。

---

后续 Settings 改造将单独建立 Plan（左侧分类导航 + 右侧设置内容），复用本文件记录的 `--tool-size / --tool-icon-size / --tool-gap / --radius-md / --radius-pill` 与 `--bg* / --text* / --accent` 视觉变量。
