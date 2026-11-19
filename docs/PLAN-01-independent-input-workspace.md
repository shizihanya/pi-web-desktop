# Plan 01：pi-web-desktop 独立输入工作区

> 目标：阅读 Agent 对话时，可以在右侧独立编辑长文本，不占用也不遮挡原来的聊天区域。
> 约束：**不修改 pi-web 上游**、不重构 Composer / TabManager、不新增第二套 Agent 发送接口。
> 状态：MVP 已实现，`npm run check` / `npm run build` / 真实 Electron GUI 自测均通过。

配套：[上游兼容性清单](development/pi-web-compatibility.md) · [自测清单](TESTING.md) · [README](../README.md)

---

## 一、实施前调查（结论以实际代码为准）

审查对象：`pi-web-desktop` HEAD `6eb6795`，本机全局 `@agegr/pi-web` **v0.17.0**
（`C:\Users\weijia\AppData\Roaming\nvm\v22.22.1\node_modules\@agegr\pi-web`）。

### 1.1 最重要的发现：上游没有源码

| 计划里点名的文件 | 实际情况 |
| --- | --- |
| `components/ChatInput.tsx` | **不存在**。已发布的 npm 包只有 `.next/` 生产构建，Composer 组件被压缩成 `dn`（`memo(forwardRef(...))`） |
| `components/AppShell.tsx` | 只存在于 `.next/static/chunks/app/page-479f7e4b8cd882bb.js`，符号被压缩成 `wv` |
| `hooks/useAgentSession.ts` | 不存在；最接近的是 `carryComposer`、`chatInputRef` |

包内目录只有 `.next/`、`bin/`、`node_modules/`、`public/`、`README.md`、`LICENSE`、
`package.json`、`next.config.ts`。`docs/integrations.md` 被 `files` 白名单排除，没随包发布。
**结论：不能按 TSX 组件接口写代码，一切依赖点只能来自对压缩产物的只读实证 + 运行时探针。**

### 1.2 Electron 主进程如何注入桌面增强

- 每个页签 = 一个 `WebContentsView`（`partition:"persist:piweb"`、`sandbox:true`、无 preload）。
- 桌面增强**全部**通过 `webContents.executeJavaScript(...)` 注入到页面 realm，
  在 `dom-ready` / `did-finish-load` 重装（脚本自身幂等），没有 `insertCSS`。
- 注入脚本必须放在独立模块（`check-contracts` 硬约束：`tab-manager.ts` 里不得出现内联 `String.raw`）。
- 页面 → 主进程的信号走 `console-message`（`ThemeManager` 用这套做主题变化）；本增强不依赖它。
- 现有模块：`tab-status.ts` / `theme-probe.ts` / `notification-patch.ts`（脚本），
  `tab-status-manager.ts` / `theme-manager.ts` / `notification-bridge.ts`（编排）。

### 1.3 Composer DOM、发送按钮、快捷键（只读逆向，v0.17.0）

来自 `.next/static/chunks/app/page-479f7e4b8cd882bb.js` 与 i18n chunk `1278-*.js`：

```js
// 主输入框（side chat 的 compact 实例没有 .chat-input-shell 包裹）
<fieldset className={compact ? undefined : "chat-input-shell"} disabled={busy} aria-busy={busy}>
  <textarea className="chat-input-textarea" rows={1}
    onChange={e => { ref.current = e.target.value; setEh(e.target.value); ... }}
    onKeyDown={tY} placeholder={t("chat.messagePlaceholder")} ... />
  ...
  <button onClick={tS} disabled={!eh.trim() && !images.length}
          title={t("chat.send")} aria-label={t("chat.send")}> ... </button>
</fieldset>
```

- **没有 `<form>`**；发送按钮 `onClick:tS`，无 `type` 属性。
- `tS`（提交）：文本非空或有图片 → `tw()` 清空输入 → `d(onSend)`；
  `onSend` → `handleSend` → `dz(sessionId, {type:"prompt", message, images})`
  → `POST /api/agent/<id>`。**失败时 `nU(...)` 会把文本放回输入框**（这是本方案判定成功/失败的依据）。
- 发送按钮在**输入框为空时本来就是 disabled**；Agent 运行时会被 Steer / Follow-up 按钮替换。
- 键盘：`"Enter" === e.key && !e.shiftKey` 为提交触发条件；
  `localStorage["pi-enter-send-mode"] === "ctrlEnter"` 时改成 Ctrl/Cmd+Enter；
  窄屏（`max-width:640px`）始终要 Ctrl/Cmd+Enter；`Shift+Enter` 换行。
- `Escape` 关弹层 / 运行时 `onAbort`；`ArrowUp` 空输入开历史；`/` 与 `@` 有补全弹层。
- **稳定选择器**：`.chat-input-shell textarea.chat-input-textarea`、
  `button[aria-label|title = Send / 发送 / 傳送 …]`、`fieldset[disabled|aria-busy]`。
  无 `id` / `name` / `data-*` / 稳定 `aria-label` 在主输入框上。

### 1.4 发送机制：没有可复用的稳定桥接

- 没有 `window.piWeb*` / `window.__PI_WEB__` / 任何全局发送桥；Composer 的
  `setText` / `pasteText` / `restoreSubmission` 只挂在 React ref 上，外部拿不到。
- 唯一给下游预留的事件是 `pi-web:session-row-contextmenu`（右键菜单接管），与发送无关。
- README 只有一句 "Integration hooks: ... replace the session row's context menu"。
- **结论**：只能走"把文本写进原生 textarea（React 受控输入必须用原生 value setter + `input` 事件）
  → 点原生发送按钮"。**绝不自行调用 `/api/agent/*`**，否则就是第二套发送接口。

### 1.5 草稿能力：上游内存态，不可复用

- pi-web 的草稿是模块级 `Map`（`oL`），key = `sessionId` 或 `new:<...>` / `parked-new:<cwd>`，
  shape `{ value, images[] }`，**不写 localStorage / sessionStorage**，页面刷新即丢。
- `pi-web:` 前缀的 localStorage 键（侧栏状态、未读集合等）与草稿无关，且
  `partition:"persist:piweb"` 是**所有页签共享**的，拿它存草稿会跨页签串用。
- 桌面端当前**没有任何草稿存储**。`dataDir()` 已有版本化 JSON 机制：
  `settings.json` / `tabs.json` / `theme.json`（`*.tmp` + `renameSync` 原子写）。
  → 复用这个模式新增 `drafts.json`，不新增数据库、不塞进 `settings.json`。

### 1.6 tabId / sessionId / cwd 如何识别

| 值 | 来源 | 说明 |
| --- | --- | --- |
| `tabId` | `randomUUID()`，`tab-manager.ts:createTab` | **每次启动都会变**，不能作为跨重启的草稿主键 |
| `path` | `toRelative(url)`，如 `/?session=abc` | 持久化在 `tabs.json`，`did-navigate` / `did-navigate-in-page` 时 `refreshPath()` 更新 |
| `sessionId` | 页面 realm 的 `TAB_SESSION_PROBE_SCRIPT` 读 `URLSearchParams.get("session")` | 也用于状态轮询；本方案不依赖它，直接从 `tab.path` 解析 |
| `cwd` | `?cwd=<path>`，壳子不单独解析，只保留在 `path` 里 | 本方案把 `cwd` 也纳入会话身份 |

### 1.7 兼容性与历史包袱

- 现有 `compat.ts` + `CompatibilityTracker`：每个增强独立 `compatible / degraded / unverified / disabled`，
  只在结论变化时回调，`[compat] feature: level — reason` 写 `server.log`；
  `PI_WEB_DESKTOP_DEBUG_COMPAT=1` 打印全部，各增强有 `PI_WEB_DESKTOP_DISABLE_*` 开关。
- `composerCompatible` 当时**恒为 `disabled`**，因为提交 `25d37d5 Remove composer expand feature`
  已删除 `src/main/tabs/composer-expand.ts` / `check-composer-expand.mjs`，文档写"确认不恢复"。
- 旧设计的失败原因值得记住：它把面板**塞进 pi-web 页面 DOM**、停靠私有 `#file-panel`、
  依赖 5 条上游私有选择器（`file-panel` / `right-panel-open` / `aria-controls="file-panel"` …），
  上游一改就碎，所以 `check-composer-expand.mjs` 需要静态断言上游 bundle。
- **Plan 01 没有恢复那个文件**，而是换了架构：Electron 窗口自己的渲染层画面板，
  页面 realm 只剩"只读探针 + 复用原生发送按钮"，不注入可见按钮。

### 1.8 布局

- 窗口自身 webContents 加载 `renderer/tabbar/index.html`（页签栏 + WCO 工具区），
  pi-web 视图作为 `contentView` 的子 view，`bounds = paneContentRect(rects[i])`，
  `TABBAR_HEIGHT = 40`。
- `snapshot().split.rects` 会同步给渲染层定位分屏页签条与窗口控件。
- **设计决策**：面板放在窗口自己的渲染层（`position:fixed; right:0; top:40px`），
  主进程给贴右边缘的 pi-web 视图 bounds 收窄 380px。**只改视图 bounds，不改
  `paneRects()` / `split.rects`**，因此页签条、分屏、WCO 窗口控件都不位移，
  对话区是"被让出空间"而不是"被盖住"。
  GUI 实测：`viewClosed=1440x860@x0` → `viewOpen=1060x860@x0`。

### 1.9 应用重启恢复的成本评估

低成本。页签 id 每次启动会变，但 `tab.path`（`/`、`/?session=…`、`/?cwd=…`）持久化在
`tabs.json` 且重启可还原。按 `path + sessionKey` **一对一**匹配即可（同一条目最多还原到一个页签，
避免同一草稿出现在两个页签）。代价约 60 行 + 一个 JSON 文件，故一并实现。

---

## 二、UI 设计

- 入口：页签栏工具区**唯一**的 `⌗` 按钮。pi-web 页面里不注入任何可见按钮
  （早期的 `⤢` 小按钮及其整套注入 / console 信号逻辑已按用户反馈删除）。
- 点击后右侧展开 380px 面板：**独立滚动区**、顶部显示当前页签/会话与兼容性状态、
  底部字数 + `Ctrl/Cmd+Enter` 提示 + 发送按钮；`Esc` / `×` 收起（草稿保留）。
- 第一版用原生多行 `<textarea>`，不做 Markdown 富文本 / 模板管理。
- 配色复用 `applyTheme()` 已同步到 `:root` 的 pi-web CSS 变量。
- 不改页签栏结构、不改 pi-web DOM、不改 `split.ts` 算法。

---

## 三、草稿状态

草稿 key = `tabId::sessionKey`，`sessionKey` 从 `tab.path` 解析（`session:` / `cwd:` / `new`）。

| 要求 | 实现 |
| --- | --- |
| 每个页签独立 | key 含 `tabId`；`DraftStore` 按 key 存 |
| 切页签不串用 | 面板绑定 `activeId`，`notify()` → `refreshContext()` 换上下文 |
| 切会话不误发旧草稿 | key 含 `sessionKey`；`did-navigate-in-page` 更新 `path`；发送前 `verifyDraftTarget()` 复核，注入脚本再用 `location.search` 二次复核 |
| 关闭面板不丢 | `close()` 只改可见性，草稿一直在内存 + `drafts.json` |
| 发送成功清空 | 原生脚本返回 `ok` → `store.clear()` + 落盘 |
| 发送失败保留 | 任何 `!ok` / 异常都不清 store |
| 重启恢复（可选增强） | `drafts.json`（版本化 JSON、消毒读取、`.tmp`+`rename`）；按 `path + sessionKey` 一对一恢复到新 `tabId` |

> 退出时的坑（已修并加 `check:contracts` 守卫）：`TabManager.destroy()` 会逐个
> `disposeTab(tab, …, {keepWindow:true})`，那不是"用户关页签"，不能触发 `onTabClosed`
> 清空草稿，否则 `drafts.json` 每次退出都被写成空数组。

---

## 四、发送机制

全部复用 pi-web 原有 Composer，**禁止**自行调用 Agent API / 维护发送状态机 / 重复实现
模型、工具、Thinking：

1. 只读探针确认 `.chat-input-shell textarea.chat-input-textarea` 存在、作用域明确、
   原生发送按钮存在、fieldset 未禁用。
2. 发送前主进程复核"目标页签仍对应原会话"；注入脚本再读 `location.search` 复核一次。
3. 用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set`
   写值 + 派发 `input` 事件（React 受控输入必需），保留原生输入框里已有的文字（追加 `\n\n`）。
4. 等一拍让 React 状态同步、发送按钮从 disabled 变可用，然后 **`current.click()`**。
   **不派发模拟键盘事件**（Agent 运行时 Enter 会触发 steer，属于"错误发送"）。
5. 只观察 pi-web 自身行为判定结果：提交时清空 textarea → `ok`；
   失败时文本被放回 → 1.5s 后判 `!ok` 并**保留草稿**；任何前置失败都 `restore()` 还原原生输入框。
6. `SendGate`（主进程，按草稿 key）+ `__piDesktopDraftSending`（页面 realm）双保险，
   连续快速点击只提交一次。

不兼容时（选择器变化 / 作用域不明 / 注入失败 / 会话已变）：一律 `!ok` 且**不执行发送脚本**，
草稿保留，pi-web 原生输入框完全不受影响。

---

## 五、兼容性

- `composerCompatible` 接入现有 `CompatibilityTracker`，结论与原因写 `server.log` 的
  `[compat] composer: …`，面板顶部直接显示给用户。
- 页面未加载完 → `unverified`（探针短轮询 1.8s 再下结论，避免把"React 还没渲染"误判为不兼容）；
  找不到输入框 / 作用域不明 / 注入失败 → `disabled` 且禁止发送；
  发送按钮暂缺（Agent 运行中）→ `degraded`，发送脚本二次复核。
- 注意：pi-web **输入框为空时发送按钮本来就是 disabled**，不能据此判定不兼容（第一次 GUI 跑暴露过）。
- `PI_WEB_DESKTOP_DISABLE_DRAFT_WORKSPACE=1` 整体关闭：面板不展开、页面零注入、
  页签栏按钮置灰，原生 Composer 照常收发。
- `check:contracts` 新增 `composer` 特性做上游 `.next` 只读契约扫描；
  `check:composer-bridge` 锁注入脚本语法 + "绝不自己发 `/api/agent/*`" + payload 特殊字符。

---

## 六、测试

### 自动化（`npm run check`，16 项）

| 命令 | 覆盖 |
| --- | --- |
| `check:draft-model` | 会话身份解析、页签/会话隔离、大量文本（>10 万字符）、关闭不丢、成功清空 / 失败保留、目标复核、连点去重、重启一对一恢复 |
| `check:composer-bridge` | 三个脚本语法、探针只读、入口幂等、React 原生 setter + input 事件、失败 restore、绝不发 API / 绝不模拟键盘、6 种特殊 payload 嵌入 |
| `check:draft-workspace` | mock WebContents：打开关闭、页签/会话隔离、成功清空、失败保留、**挂起 Promise 下连点 3 次只提交 1 次**、会话切换禁止发送、DOM 变化 → disabled 且零发送脚本、注入失败自动禁用、增强关闭零注入、重启恢复 |
| `check:compat` / `check:contracts` | 兼容性四级判定（含"空输入 disabled 仍兼容"）、上游契约只读扫描、`onTabClosed` 的 `keepWindow` 守卫 |

### 真实 Electron GUI（`npm run app`）

```powershell
$env:PORTABLE_EXECUTABLE_DIR = "D:\person\pi-web-desktop\.pi\gui-test"  # 隔离单实例锁 / 数据目录
$env:PI_WEB_DESKTOP_SELFTEST_DRAFT = "1"
$env:PI_WEB_DESKTOP_SELFTEST_DRAFT_INCOMPAT = "1"  # 可选：模拟 Composer DOM 变化
$env:PI_WEB_DESKTOP_AUTOQUIT_MS = "32000"
npm run app
```

实测输出（v0.17.0，1440×900 窗口）：

```
[selftest-draft] firstTab=yes viewClosed=1440x860@x0 open=true largeText=84000
  tabIsolation=true backToA=true closeKeepsDraft=true secondTabIsolated=true
  compat=compatible nativeComposer=true sendButton=true viewOpen=1060x860@x0
  simulate=broken incompat=disabled nativeStillUsable=true
  blockedSend=true draftKept=true restored=compatible
[draft] 重启恢复 2 条草稿
```

- `viewClosed` → `viewOpen` 证明对话区被收窄而非遮挡。
- `incompat=disabled` + `nativeStillUsable=true` + `blockedSend=true` + `draftKept=true`
  证明上游 DOM 变化时禁止错误发送、原生输入仍可用。
- `重启恢复 2 条草稿` 证明 `drafts.json` 在退出后保留、重启能还原。

> 发送成功 / 失败 / 连点去重的**真实发送**由 mock 回归覆盖，GUI 自测刻意不发真实消息，
> 避免污染用户会话。手工回归清单见 `docs/TESTING.md` 第 31~41、L、M 条。

---

## 七、验收标准对照

| # | 要求 | 结果 |
| --- | --- | --- |
| 1 | 一边看对话、一边在右侧编辑长文本 | ✅ 面板独立滚动；8.4 万字草稿 GUI 实测 |
| 2 | 编辑器不遮挡 / 不破坏对话布局 | ✅ 只收窄视图 bounds（1440→1060），`paneRects()` / 页签条 / WCO 不变 |
| 3 | 草稿不跨页签 / 会话串用 | ✅ key = `tabId::sessionKey`；GUI + 纯逻辑双重验证 |
| 4 | 发送完全复用 pi-web 原有逻辑 | ✅ 原生 textarea + 原生发送按钮；零 `/api/agent/*` 调用 |
| 5 | 关闭桌面增强后原生 Composer 不受影响 | ✅ `DISABLE_DRAFT_WORKSPACE=1` 页面零注入；不兼容时原生输入框仍可用 |

---

## 八、改动文件

**新增**（`src/main/tabs/` 保持纯逻辑与注入脚本分离，`tab-manager.ts` 不出现内联 `String.raw`）：

```
src/main/tabs/draft-model.ts          草稿 key / 隔离 / 目标复核 / SendGate / 重启匹配（纯逻辑）
src/main/tabs/draft-persistence.ts    drafts.json（版本化 JSON + 原子写 + 读取消毒）
src/main/tabs/composer-bridge.ts     三个页面 realm 注入脚本 + 安全 payload 组装
src/main/tabs/draft-workspace.ts      编排（结构接口，可 mock）
src/renderer/tabbar/draft-panel.ts    面板 UI
scripts/check-draft-model.mjs
scripts/check-composer-bridge.mjs
scripts/check-draft-workspace.mjs
```

**修改**：`src/shared/types.ts`（`DraftApi` / `DRAFT_IPC`）、`src/preload/tabbar.ts`（`piWebDrafts`，通道名内联以兼容 sandbox）、
`src/main/ipc.ts`（`registerDraftIpc`）、`src/main/tabs/tab-manager.ts`（`reservedRightWidth` +
3 个回调 + `draftContext` / `allDraftContexts` / `activeViewBounds`，无重构）、
`src/main/tabs/compat.ts`（`evaluateComposer` 改为按探针判定）、
`src/main/index.ts`（装配 + GUI 自测钩子）、
`src/renderer/tabbar/{index.html,style.css,tabbar.ts}`（按钮 + 面板）、
`src/renderer/global.d.ts`、`package.json`（3 个 check 命令）、
`README.md` / `docs/TESTING.md` / `docs/development/pi-web-compatibility.md`。

---

## 九、已知边界（MVP 有意不做）

1. 不做 Markdown **所见即所得编辑器 / 预览**（原生输入框本身也是纯文本 textarea，能力一致）、不做模板管理。
   图片支持粘贴 / 拖入 / 选图并委托给原生 `onPaste`，附件 chip 可点开面板内大图预览；草稿文本仍只存 `drafts.json`，图片只存内存、重启不恢复。
   `@` 文件提及以文本形式写出（等价于原生补全后插入的路径文本）；**不复刻原生的补全弹层**——需要弹层、模型/工具切换时用编辑器右键菜单（或 `Ctrl+Shift+Enter`）里的「在原生输入框中继续…」一键切过去。
2. 同一会话在两个页签同时打开时，重启恢复按 `path + sessionKey` 一对一匹配，只还原到其中一个页签。
3. 发送成功判定依赖 pi-web「提交时清空 textarea / 失败时放回文本」的行为；若上游改成别的行为，
   会走「未能确认已送达」分支并**保留草稿**（不会误清空），需要人工确认。
4. 面板是全局右侧区域，分屏时收窄所有贴右边缘的窗格；不做"只在某个窗格旁展开"。
   面板展开会让 pi-web 的**视口变窄**，从而触发它自身的响应式重排（例如右侧文件面板可能
   自动折叠）——这是"不遮挡、只让出空间"这一取舍必然带来的效果；对话消息区仍完整显示、
   可正常滚动，收起面板即恢复原视口宽度。
5. `drafts.json` 单条上限 20 万字符、最多 200 条；超长草稿只保留在内存中（不截断用户输入）。
6. 无头/虚拟显示环境下 `BrowserWindow.capturePage()` 不含子 `WebContentsView`，
   GUI 自测改用视图 `getBounds()` 做数值断言。

---

## 十、Plan 01.1：首轮真实 GUI 反馈修复

用户实际用起来后反馈 5 个问题，逐条定位与修复（均有真实 GUI 断言，非推测）：

| # | 反馈 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 字体不好看，应与原生一致 | 面板 CSS 写死等宽 `Consolas`，原生是 `-apple-system, "Segoe UI", sans-serif` / 14px / 22.4px | 探针读原生 `textarea` 的 computed `fontFamily/fontSize/lineHeight/color/letterSpacing`，经快照透传给面板 inline style；GUI 断言 `fontMatch=true` |
| 2 | 能力要和原生一致：Markdown / 图片 / 文件提及 / steer / next | 初版只有纯文本 + 单一「发送」按钮 | 图片经 `ClipboardEvent('paste')` 委托原生 `onPaste`；多语言标签表加入 `引导 / 后续消息`（`chat.steer` / `chat.followUp`）并按模式点原生按钮；新增「原生输入框 ↗」把草稿+图片搬进原生 Composer 并聚焦，从而可继续使用 `@` 补全 / `/` 命令 / 模型 / 工具 |
| 3 | 希望拖动左右范围 | 宽度写死 380 | 面板左边缘加 resizer，`setWidth` 钳到 280–720（≤60% 窗宽），同步 `setReservedRightWidth`，持久化到 `drafts.json`；GUI 断言 `resized=920x860@x0`（520px） |
| 4 | 只看到顶部按钮，没看到发送按钮左侧 `⤢` | `onTabsReplaced()` 里的 `detachAll()` 把 `init()` 刚注册好的 `dom-ready` 监听摘掉了，入口脚本从未注入（诊断 `entryFlag:false, entry:null`） | 清理旧监听改在 `TabManager.destroy()` **之前**由调用方做；`onTabsReplaced()` 不再 detach；`probeActive()` 无条件幂等补装入口。GUI 断言 `nativeEntryButton=true (flex)` |
| 5 | 点发送提示「找不到可用的原生发送按钮」 | 诊断显示空输入时 `发送` 按钮 `disabled:true` 是 pi-web 正常行为，而旧脚本**在写入文本之前**就检查了 `send.disabled`，必然失败 | 先写入文本 + 派发 `input` 让 React 更新状态，等 140ms 后再按模式找按钮并点击；仍不可用时 `restore()` 还原原生输入框并保留草稿。GUI 断言 `sendPreflight=true (disabled true→false)` |

真实 GUI 自测输出（`PI_WEB_DESKTOP_SELFTEST_DRAFT=1 PI_WEB_DESKTOP_SELFTEST_DRAFT_INCOMPAT=1 npm run app`）：

```
viewClosed=1440x860@x0 open=true largeText=84000 tabIsolation=true backToA=true
closeKeepsDraft=true compat=compatible nativeComposer=true sendButton=true
viewOpen=1060x860@x0 sendPreflight=true (disabled true→false)
nativeEntryButton=true (flex) fontMatch=true resized=920x860@x0
simulate=broken incompat=disabled nativeStillUsable=true blockedSend=true
draftKept=true restored=compatible
```

新增回归：`check:composer-bridge` 锁「先写入再检查 disabled」的源码顺序、多语言标签、
steer/followUp 脚本语法、图片 paste、原生输入框脚本不点提交按钮；
`check:draft-workspace` 覆盖宽度钳制/持久化、字体透传、steer 模式、图片增删、
`onTabsReplaced` 不摘监听、一键切原生；`check:draft-model` 覆盖宽度钳制；
`check:compat` 覆盖「Agent 运行时 send 被替换仍 compatible」。

---

## 十一、Plan 01.2：第二轮 UI 收敛反馈

用户按真实使用体验要求把面板做得更像原生输入框，5 条全部落地：

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 传入的图片不能再次点击打开查看 | 新增 `DRAFT_IPC.getImage` 按需取回 base64（**不塞进每次 emit 的快照**）；附件 chip 整块可点，面板内 lightbox 大图预览，点背景 / × / `Esc` 关闭。GUI 断言 `imagePreview=true` |
| 2 | 「发送/引导/后续消息」一排按钮没存在必要，集中到发送按钮 | 删掉独立 `draft-modebar`；底部改为**一个主按钮 + `▾` 下拉**，模式项与「在原生输入框中继续…」收进菜单；主按钮文案随当前模式变化（类似原生按钮随状态切换）。GUI 断言 `singleSubmit=true submitMenu=true` |
| 3 | 「原生输入框 ↗」和「发送到对话」不必同时存在 | 去掉独立按钮，能力移入 `▾` 菜单，默认界面只露一个提交按钮 |
| 4 | 上传文件按钮很丑，要和原生一致 | 从上游 bundle 只读提取原生 `chat.attachFiles` 按钮的 SVG（15×15 图片图标）与样式（`background:none / border:none / border-radius:9 / color:var(--text-muted) / hover→var(--bg-hover)`），照搬进面板。GUI 断言 `nativeSvgIcon=true (borderStyle=none)` |
| 5 | 最下面的提示文本一直不消失 | 主进程 `setText()` / `open()` 清 `lastResult`；renderer 对**成功**提示 4 秒后淡出隐藏，失败原因保留、重新输入即清除。GUI 断言 `successHintAutoHide=true` |

真实 GUI 断言（`[selftest-draft-ui]`）：

```
singleSubmit=true nativeSvgIcon=true (none) sendLabel=发送到对话
imageStored=true imagePreview=true submitMenu=true successHintAutoHide=true
```

新增回归：`check:contracts` 守住「不得退回独立模式栏 / 第二个原生输入框按钮」；
`check:draft-workspace` 覆盖图片按需取回且 base64 不进快照、重新输入清除旧提示。

---

## 十二、Plan 01.3：提交模式改为全自动

用户确认「自动切换」后，把 §十一 剩下的 `▾` 下拉也收掉：

- **删除** `setMode` API / `drafts:set-mode` 通道、`draft-submit-more`、`draft-menu`，底部只剩**一个**主按钮。
- `DraftWorkspace.autoMode()` 按探针拿到的 `modes` 自动判定，规则对齐 pi-web 原生 `tY` 的 Enter 分支
  （bundle 实证：`f&&(u||h) ? tV(e.altKey&&h||!u ? "followup" : "steer") : tS()`）：
  1. `modes.send` → `send`（按钮 `发送到对话`）
  2. 否则 `modes.steer` → `steer`（按钮 `发送引导`）
  3. 否则 `modes.followUp` → `followUp`（按钮 `排队后续消息`）
  4. 都没有 → 回落 `send`（此时 `canSend` 也会因 compat 判定被关掉）
- `send()` **不再接受外部 mode 参数**，避免把旧会话草稿按错误模式发出；探针一更新 `modes` 就 `emit()`，按钮文案 / title 自动跟着变。
- 「在原生输入框中继续」从 `▾` 菜单移到**编辑器右键菜单** + `Ctrl+Shift+Enter`，不占任何可见按钮位。
- `check:contracts` 改为守住「只允许单个主按钮，不得有 ▾ / 手动模式栏」；
  `check:draft-workspace` 新增自动模式三态断言，并验证 streaming 时发送脚本用的确实是 `"mode":"steer"`。

真实 GUI 断言：

```
[selftest-draft] … simulate=broken incompat=disabled nativeStillUsable=true
  blockedSend=true draftKept=true restored=compatible
[selftest-draft-ui] singleSubmit=true nativeSvgIcon=true (none) sendLabel=发送到对话
  autoModeIdle=true hiddenNativeEntry=true imageStored=true imagePreview=true
  contextNative=true successHintAutoHide=true (ok=true shown=true gone=true)
```

> 测试模拟的一处坑：React 可能直接**替换** textarea 节点而不是改 class，
> 只观察旧节点的 MutationObserver 会漏，导致「不兼容模拟」失效。已改为观察
> `document.body` 整棵子树并对所有 `textarea.chat-input-textarea` 生效。

---

## 十三、Plan 01.4：预览修正 + 删除页面内 ⤢ 入口

| # | 反馈 | 根因 / 处理 |
| --- | --- | --- |
| 1 | 点附件预览看不到图、阴影也不对 | 诊断 dump 出 `complete:true, nw:1, nh:1, w:1, h:1`（测试图只有 1 像素）且遮罩 `lw:1440, lh:900` **盖住整个窗口**。改为**面板内浮层**（`position:absolute; inset:0` 相对 `.draft-panel`），只盖右侧编辑区、不压暗左侧对话；用主题背景 + 标题栏 + `×`，图片在 body 里 `max-width/max-height:100%` + `object-fit:contain` 居中，带白底和轻阴影。GUI 断言改用 64×64 PNG 验证 `imgVisible=true`（`nw=64` 且渲染尺寸 > 0，且遮罩宽度 < 800） |
| 2 | 删掉原生输入框「发送」左侧 `⤢` 小按钮及注入逻辑，只留顶部按钮 | 用户认为独立输入框用得不频繁，没必要在原生 Composer 附近常驻。**删除** `COMPOSER_ENTRY_SCRIPT`、`DRAFT_OPEN_MARKER`、`ensureEntry()`、`console-message` 监听、`entryFailed` 状态、`setInterval(place)` 常驻定时器；`attach()` 简化为只注册 `dom-ready`/`did-finish-load` 重装**只读探针**（字体 / 自动模式 / 兼容性仍靠它）。GUI 断言改为 `noInjectedEntry=true` |

注意：§十 第 4 条记录的是当时把 ⤢ 修好的过程，§十三 之后该入口已整体移除；
保留历史条目是为了说明 `onTabsReplaced()` 不能 `detachAll()` 这个结论仍然成立
（现在保护的是只读探针的重装，不是入口按钮）。

真实 GUI 断言：

```
[selftest-draft] … sendPreflight=true (disabled true→false) noInjectedEntry=true
  fontMatch=true resized=920x860@x0 simulate=broken incompat=disabled
  nativeStillUsable=true blockedSend=true draftKept=true restored=compatible
[selftest-draft-ui] singleSubmit=true nativeSvgIcon=true (none) sendLabel=发送到对话
  autoModeIdle=true hiddenNativeEntry=true imageStored=true
  imgVisible=true (nw=64 w=64 lw=379) imagePreview=true contextNative=true
  successHintAutoHide=true
```

回归同步：`check:composer-bridge` 改为断言「不得存在 `COMPOSER_ENTRY_SCRIPT` / `__piDesktopDraftEntry` /
`__PI_DESKTOP_DRAFT_OPEN__` / 常驻 `setInterval`」；`check:draft-workspace` 删掉入口信号测试，
改为「不再绑定 `console-message`」「每次 dom-ready 只跑一次只读探针」「探针注入失败 → disabled」；
`check:contracts` 保留「单个主按钮」守卫。

---

## 十四、提交 `ade9ca3` 定向复核

复核上游 `.next/static/chunks/app/page-*.js` 的真实 Composer JSX（不是猜）：

```js
("fieldset", { disabled: eq, "aria-busy": eq, className: es ? void 0 : "chat-input-shell", … })
```

- `eq = useState(!1)`，setter `eV` **只在 `tj`（斜杠命令异步执行）里**置 true，`finally` 立即复位。
  → **Agent 运行时 fieldset 不 disabled**（真实 GUI 也量到 `idleFieldset=false busy=false`）。
- steer / followUp / send 三个按钮都在这个 fieldset 内；`tT = !!eh.trim() || ew.length>0`，
  steer / followUp `disabled:!tT`，send `disabled:!eh.trim()&&!ew.length`，`tS` / `tV` 的入口条件都是
  `(t || ew.length)` → **上游本身支持纯图片，也支持运行中纯图片 steer / followUp**。
- Enter 分支：`f&&(u||h) ? tV(e.altKey&&h||!u ? "followup" : "steer") : tS()`（§十二 的自动模式依据）。

| # | 复核问题 | 结论 / 处理 |
| --- | --- | --- |
| 1 | 发送脚本会不会在找 steer/followUp 之前就因 `fieldset.disabled` 拒绝？ | **代码里确实有这条路径**：`SEND_BODY` 在写入文本、找按钮之前就 `if (fieldset && (fieldset.disabled \|\| aria-busy==='true')) return fail('pi-web 输入框当前不可用')`，对所有模式一刀切。当前 pi-web 版本下 Agent 运行时不命中（fieldset 不锁），但逻辑脆弱且会遮掉按模式判断的能力。**已删掉前置一刀切**，改为 `buttonUsable(b)` 按「本次模式实际要点的按钮」判断（自身 `disabled` / `aria-disabled` / `:disabled` 继承），失败原因带模式名；`fieldset` 锁住但按钮仍可点时 steer 照常可发 |
| 2 | 纯图片能不能发？ | **不能，确认 bug**：`SEND_BODY` 有 `if (!P.text \|\| !P.text.trim()) return fail('草稿为空')`（编排层 `send()` 是对的，但页面脚本挡住了）；且成功判定 `value.indexOf(P.text) === -1` 在空串时恒为 0，必然等 1500ms 超时误报失败。改为 `hasText \|\| hasImages` 才允许、纯图片不往 textarea 塞空行；成功判定改用「写入后的完整文本 `baselineText` 被清空 **或** 图片附件 chip（`img[src^=blob:]` / `data:`）消失」，两者皆无变化才超时。发送前等 React 渲染完附件 chip（≤600ms）再记基线 |
| 3 | 连点是否只提交一次？ | 主进程 `SendGate` 拦住 IPC 路径，但**页面 realm 的 `__piDesktopDraftSending` 闸门只在 `setTimeout` 回调里（点击前）才置位**，两次紧邻调用会各进一次等待、各点一次。已把闸门提到脚本最开头（任何 `setTimeout` 之前），所有出口统一 `finish()` 释放，外层 `catch` 也复位 |
| 4 | Agent 开始/结束后按钮文案是否及时更新？ | **确认不会**：`probeActive()` 只由 `dom-ready` / `did-finish-load` / 会话签名变化触发；Agent 运行时按钮整组替换但不触发这些。已让 `refreshContext()`（`TabManager.notify()` 状态轮询 700ms 必经）按 900ms 节流重跑只读探针，`open()` 也立刻探一次 → 文案在 ~1s 内跟着切，且文案与 `autoMode()` 同源 |
| 5 | 图片重启丢失有无 UI 提示？ | 之前没有。有附件时面板显示「图片仅保留在本次运行期间，重启应用后需重新附加」 |
| 6 | 长文本频繁落盘是否阻塞主进程？ | 渲染层已有 80ms debounce（只在停顿时写一次，非每击键）。实测 `saveDrafts` 同步写：1–2 条 84KB 草稿 ≈ 1–2ms；极端 20 条 × 70KB（2.29MB 文件）median 15.8ms / p95 30ms。**正常场景不明显，不改动**：改异步写会引入「退出时未 flush 丢草稿」的新风险，收益不抵复杂度 |
| 7 | 本次改动自身有无性能回退？ | **有，已修**：加了 900ms 节流重跑探针后，`probeActive()` 仍无条件 `emit()`，而 `onChange` 会把含整篇草稿文本 + 附件的**全量 snapshot 广播到所有窗口** → 100KB 长草稿每 ~1.4s 一次序列化 + IPC，渲染层还会反复重建附件 chip，且非聚焦时可能用旧快照覆盖刚输入的字符。改为只在 `typography` / `modes` / `compat` **真的变化**时才广播（`setCompat` 已按 verdict 去重），结果不变的轮询零广播。`check:draft-workspace` 新增「3 轮状态轮询零额外快照」与「模式真变化时确实广播」两条断言。其余开销实测：探针本身每 ~1.4s 一次 `executeJavaScript`（2.5KB 脚本 + 几次 querySelector / getComputedStyle，<1ms，面板关闭时零探针）；发送时 `attachmentCount()` 最多 5+10 次 querySelectorAll，可忽略；`atob` + 逐字节解码 1MB 图 4ms / 5MB 图 8ms / 10×5MB 79ms（一次性、原路径，纯图片现在也会走到） |

新增 `check:composer-send`（`npm run check:composer-send`）：用最小 DOM 桩在 `vm` 里**真正执行**
`buildComposerSendScript`，按 pi-web 真实语义建模（空输入按钮置灰、`tw()` 成功清空 / `nU()` 失败放回、
附件 `img[blob:/data:]`），覆盖空闲 send、运行中 steer / followUp、纯文字、文字+图片、纯图片、
两者皆空、发送失败保留、连点去重、会话变化、fieldset 锁住按模式拒绝等 19 条断言。
`check:composer-bridge` / `check:draft-workspace` 同步补齐静态守卫与编排层用例。

真实 GUI（`PI_WEB_DESKTOP_SELFTEST_DRAFT=1`）：在**真实 pi-web 页面**上复现 streaming 的按钮组
（send → 引导 / 后续消息），拦截 `button.click` 不真发消息，再执行真正的发送脚本：

```
[selftest-draft-stream] install=installed idleFieldset=false busy=false steerButtons=2
  send=true (ok=true clicked=true) steer=true (ok=true clicked=true)
  followUp=true (ok=true clicked=true) imageOnly=true (clicked=true ok=true)
  lockedByMode=true
```

> 真实 Agent 运行需要 LLM 凭据，自动化里不触发对话；这里的 streaming 状态是**等价 DOM 复现**，
> 加上只读探针实测的 fieldset 属性，合起来验证「发送脚本在 Agent 运行期间的行为」。
> 恢复脚本会还原 DOM / `HTMLButtonElement.prototype.click` / textarea，并 reload 页签清掉临时附件。
