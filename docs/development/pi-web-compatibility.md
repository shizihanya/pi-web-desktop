# Pi Web 上游兼容性清单与回归

> 配套：`docs/ANALYSIS.md`（上游契约分析）、`docs/PLAN.md`（里程碑）、`docs/TESTING.md`（人工自测清单）。
> 本文是「现有架构优化」第一阶段的产出：**以当前源码为准**建立依赖清单、功能级兼容性检测，
> 以及 pi-web 升级后必须执行的回归清单。所有结论都标注了验证方式，未验证的不写「完全兼容」。

## 0. 审查结论：Plan 与实际代码的差距

先审查再改动。本轮审查（`HEAD = 25d37d5`，本机全局 `@agegr/pi-web` **v0.17.0**）发现：

| # | Plan 中的假设 | 实际情况 | 处理 |
| --- | --- | --- | --- |
| 1 | 存在「大输入框 / 扩展编辑」增强，需要提高兼容性并补 `check:composer` | `25d37d5 Remove composer expand feature` 已删除 `src/main/tabs/composer-expand.ts`、`scripts/check-composer-expand.mjs`、package.json 脚本和 README 段落。当前**没有任何输入框注入** | **已确认不恢复**。第五阶段不再实施；`composerCompatible` 恒为 `disabled`，回归清单第 4 条改为「pi-web 原生输入框可用」 |
| 2 | README 提到 `check:composer` 但 package.json 没有 | README 已不再提到该命令；真实的不一致是：README 的「开发与维护」只列了 `check:theme`，漏了 `check:status`；且没有统一的 `check` | 已对齐命令并新增 `npm run check` / `check:all` |
| 3 | `tab-manager.ts` 约 1583 行 | 实际 1460 行；两轮渐进拆分后约 1375 行（见 §5） | 按实际规模评估，不做一次性重写 |
| 4 | 每 700ms 轮询所有页签、每页 600ms 缓存、每页独立请求 `/api/agent/running` | 属实（`STATUS_POLL_MS=700`、探测脚本内 `cache.at > 600`） | 已改造为共享快照，见 §4 |
| 5 | 通知补丁在 TabManager 主逻辑里 | 属实（`WINDOWS_NOTIFICATION_PATCH` 内联） | 已抽到 `notification-patch.ts` |
| 6 | 主题探测脚本在 `tab-manager.ts` | 属实 | 已抽到 `theme-probe.ts`，`check:theme` 改为检测该文件 |
| 7 | `docs/ANALYSIS.md` 记录的上游版本 0.15.0 | 本机已升到 0.17.0 | `check:contracts` 只读扫描确认 §1 的契约在 0.17.0 仍存在；但静态扫描不等于功能完全兼容 |

> **Plan 01 后续更新（本轮）**：上表第 1 行「已确认不恢复」指的是**旧设计**（`composer-expand.ts`：
> 把面板塞进 pi-web 页面 DOM、停靠私有 `#file-panel`，依赖 5 条上游私有选择器，上游一改就碎）。
> Plan 01 没有恢复那个文件，而是用**不同设计**重新引入桌面增强：Electron 窗口自己的渲染层画右侧面板，
> 主进程只收窄 `WebContentsView` bounds 让出 380px；页面 realm 里只剩「只读探针 +
> 复用原生发送按钮」，不再注入任何可见按钮。因此 `composerCompatible` 不再是恒为 `disabled`，改为按实际探针判定；
> 本文 §1 / §2 / §3 / §6 / §7 已同步更新。历史上被删的 `check-composer-expand.mjs` 没有恢复。
> 实现与调查结论见 [Plan 01 独立输入工作区](../PLAN-01-independent-input-workspace.md)。

**未经验证的兼容性一律不标记为「完全兼容」**：`check:contracts` 的结论是「契约未见破坏」，
运行时结论是 `compat.ts` 的四级判定，最终仍需 §3 的人工回归。

---

## 1. 上游依赖清单（以实际源码为准）

图例：
- **类型**：URL / API / DOM / CSS / Web API / CLI / 文件 / 事件
- **风险**：低（标准接口）/ 中（上游可重命名）/ 高（压缩产物内部结构）

| 功能 | 依赖点 | 桌面端位置 | 类型 | 上游位置（v0.17.0 只读验证） | 风险 | 失效影响 | 降级方式 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 服务启动 / 就绪 | `pi-web --no-open -p N -H H`、`pi-web version`、`GET /` | `src/main/server/{resolve-pi-web,server-manager,port}.ts`、`scripts/smoke.mjs` | CLI / HTTP | CLI 参数、`/` 路由 | 低 | 应用起不来 | splash 显示错误 + 重试；`smoke` 检测 |
| 运行记录 / 复用 | `~/.pi/agent/pi-web-run/*.json`（只读） | `src/main/server/{run-records,server-manager}.ts` | 文件 | 上游启动器写记录 | 低 | 复用判断失准 | 端口探测兜底，不依赖记录为唯一依据 |
| 会话定位 / 页签恢复 | `?session=<id>` | `src/main/tabs/tab-status.ts`（`URLSearchParams.get("session")`）、`tab-manager.ts`（`toAbsolute` / `toRelative` 持久化 URL）、`scripts/smoke.mjs` | URL | `.next/static/chunks/app/page-*.js` 中 `"?session="` | 中 | 页签恢复到错误会话 | 保留 `/` 根页；`smoke` 断言 `/?session=` 返回 200 |
| 应用内开新页签 | 同源 `?session=` / `?cwd=` 的 `window.open` | `tab-manager.ts` `setWindowOpenHandler` / `will-navigate` | URL / 事件 | 上游侧栏「在新标签页打开」 | 中 | 跳出系统浏览器 | 外链一律 `shell.openExternal`，不影响原生导航 |
| 全局运行状态 | `GET /api/agent/running` → `runningSessionIds` / `awaitingInputSessionIds` / `subagentsActiveSessionIds` | `src/main/tabs/tab-status.ts`、`status-model.ts` | API | `.next/server/app/api/agent/running/route.js` | 中 | 转圈 / 橙点不准 | 侧栏逐行 DOM 兜底；失败保留最后一次有效快照 |
| 会话 id / 逐行状态兜底 | `.session-tree-row.session-tree-session.is-selected`、`data-row-key="session:<ctx>:<id>"`、`.is-running`、`.session-tree-awaiting` | `src/main/tabs/tab-status.ts` | DOM | `.next/static/chunks/app/page-*.js` | **高** | URL 无 session 时定位不到会话 | 只用 URL 会话；无依据时 `unknown`，保留上一轮状态 |
| 页签标题 / 通知页签名 | `page-title-updated` 的 `"会话名 - Pi Web"` 后缀、正则清洗 | `tab-manager.ts` `cleanTitle()`、`notification-patch.ts` `tabTitle()` | DOM / 事件 | 页面自维护 title | 中 | 页签名带后缀、通知标题重复 | 只影响显示，不阻断发送 |
| 页签图标 | `page-favicon-updated`，只认静态 http(s) 图标（忽略 canvas data: badge） | `tab-manager.ts` | DOM / 事件 | 上游 favicon | 中 | 图标缺失 | 用文字标题；提示点由 `.tab-status` 控制 |
| 主题同步 | `:root` 上 11 个 CSS 变量（`--bg`…`--accent-contrast`）、`dataset.theme`、`localStorage["pi-theme"]`、`color-scheme`、body 背景色 | `src/main/tabs/theme-probe.ts`、`theme-persistence.ts`、`titlebar.ts` | CSS / DOM | `.next/static/css/*.css`（11 个变量各 13 处） | 中 | 页签栏 / 窗口控件配色不对 | 保留当前主题缓存；冷启动用 `theme.json`，不回落浅色 |
| Windows 通知增强 | `ServiceWorkerRegistration.prototype.showNotification`、`window.Notification`、`document.hasFocus`、`__piDesktopWindowFocused` | `src/main/tabs/notification-patch.ts`、`tab-manager.ts` `syncWindowFocus()` | Web API / DOM | `.next/static/chunks/app/page-*.js` 中 `showNotification` | **高** | 任务完成不出 toast / 失焦误判 | 注入失败记诊断；上游改实现时优先降级，保留原生 |
| 登录态 | `partition:"persist:piweb"` + Cookie / Basic Auth；接口请求在**页面 realm** 内发起 | `tab-manager.ts`、`tab-status.ts` | Web API | 上游 `/login` + `PI_WEB_PASSWORD` | 中 | 状态接口 401 | 换一个有效页面作为状态源；主进程不保存密码 |
| 服务更新 | `npm view` / `npm install -g @agegr/pi-web@x.y.z` / `pi-web version` | `src/main/server/pi-web-update.ts`、`settings-service.ts`、`runtime-update.ts` | CLI | 全局 npm 包 | **高** | 影响终端里的 pi-web、可能半更新 | 见 §6（审查 + 失败时恢复旧版本并验证，未引入多版本 Runtime） |
| **独立输入工作区（Plan 01 / 01.1）** | `.chat-input-shell textarea.chat-input-textarea`（主输入框，side chat 无此包裹）、提交按钮多语言标签 `chat.send`（发送/傳送/Send）、`chat.steer`（引导/引導/Steer）、`chat.followUp`（后续消息/後續訊息/Follow-up）、`button[title=chat.attachFiles]`（附加文件）、原生 `onPaste` 从 `clipboardData.items` 取 `image/*`、textarea 的 computed `font-family/font-size/line-height/color`、`fieldset.chat-input-shell[disabled\|aria-busy]`、`?session=` / `?cwd=`、`localStorage["pi-enter-send-mode"]`（仅诊断） | `src/main/tabs/composer-bridge.ts`（只读探针 / 入口 / 复用原生发送）、`draft-model.ts`、`draft-workspace.ts`、`src/renderer/tabbar/draft-panel.ts` | DOM / Web API | `.next/static/chunks/app/page-*.js`（`className:"chat-input-textarea"`、`chat.send`、`chat-input-shell`、`pi-enter-send-mode`） | **高** | 禁止错误发送（面板 `disabled`），但**原生输入框始终可用**；绝不自行调用 `/api/agent/*` | 探针不通过 / 作用域不明 / 注入失败 → `disabled` 且禁止发送；发送脚本二次复核会话与发送按钮；`check:composer-bridge` 锁语法与安全契约 |

> 刻意**不依赖**：`pi-web:unread-session-ids`（跨页签共享的全局未读集合，会让所有页签一起亮）、
> `.next` 内部 chunk 文件名 / 内容、pi-web 源码文件、任何本地 `@agegr/pi-web` 依赖或补丁包。
> `check:contracts` 会把这几条作为硬约束守住。

---

## 2. 功能级兼容性检测

不建版本号适配系统、不建 Adapter 框架。五个增强各自给出独立结论
（`src/main/tabs/compat.ts`，纯逻辑，可被 `npm run check:compat` 直接测试）：

| 结果字段 | 判定依据（实际探测，不看版本号） | compatible | degraded / unverified / disabled |
| --- | --- | --- | --- |
| `statusProbeCompatible` | `/api/agent/running` 返回结构 + 会话定位结果 | 三个数组都存在且最近一次请求成功 | 请求失败 → 沿用最后有效快照；从未成功但有 DOM/URL 依据 → DOM 兜底；页面已加载却无依据 → `unverified`（做契约检测，不误报兼容） |
| `themeProbeCompatible` | 主题探测脚本返回的 `fromPage` 与 CSS 变量数 | 读到 ≥3 个变量 | 变量不足 / 脚本报错 → `degraded` / `disabled`，**保留当前主题缓存**，不影响 pi-web 显示 |
| `notificationCompatible` | 通知补丁注入后返回的诊断 JSON | 回落、焦点同步、标题包装都幂等安装 | Web API 缺失 / SW 补丁没装上 / 注入报错 → `degraded` / `disabled`，**优先降级而不是强行改写上游新实现** |
| `composerCompatible` | 只读探针：主输入框 + `.chat-input-shell` 作用域 + 任一原生提交按钮（send / steer / followUp）；页面 realm 入口安装结果 | 输入框 / 作用域 / 任一提交按钮齐备 | 页面未加载完 → `unverified`；所有提交按钮都找不到 → `degraded`；找不到输入框 / 作用域不明 / 注入报错 → `disabled`，**禁止发送**，原生输入框不受影响。两个易踩的坑：pi-web 空输入时 `发送` 按钮本来就是 `disabled`；Agent 运行时 `发送` 会被 `引导/后续消息` 替换——两者都不能误判为不兼容 |

处理矩阵：

| 情况 | 处理 |
| --- | --- |
| 检测通过 | 正常启用，仅在 `PI_WEB_DESKTOP_DEBUG_COMPAT=1` 时输出 `compatible` |
| 部分检测失败 | 只降级 / 关闭相关增强；页签、固定页签、分屏、托盘、服务生命周期完全不受影响 |
| 未知 pi-web 版本 | `unverified` + 跑 `check:contracts` 契约检测；版本号只记录、不参与判定 |
| 页面结构变化 | 保留 pi-web 原生功能；状态标记 `unknown` 并保留上一轮，绝不把未知当 `idle` |
| 注入脚本执行失败 | `try/catch` 吞掉，写 `[compat] … disabled — 原因` 到 `server.log`，页面照常运行 |

每个页面注入都可独立关闭（`=1` 关闭），关闭后仍做只读契约检测、pi-web 原生功能照常：

```
PI_WEB_DESKTOP_DISABLE_STATUS_PROBE
PI_WEB_DESKTOP_DISABLE_THEME_PROBE
PI_WEB_DESKTOP_DISABLE_NOTIFICATION_PATCH   # 只在 Windows 生效
PI_WEB_DESKTOP_DISABLE_DRAFT_WORKSPACE       # 独立输入工作区（关闭后页面零注入）
```

**边界**：`check:contracts` 的静态扫描只能发现「字符串层面」的契约破坏。
「仅凭选择器存在就认定功能完全可用」是错的 —— 完整兼容性必须跑 §3。

---

## 3. 上游更新后的回归清单

每次 `npm i -g @agegr/pi-web@latest`（或设置页「检查更新」）之后，按顺序执行：

```powershell
npm run check:all      # check（typecheck + 16 项静态/纯逻辑回归）+ smoke（真起一个临时 pi-web 服务）
npm run app            # 再按下面 8 条人工过一遍
```

| # | 检查项 | 怎么验 | 不通过时的处理 |
| --- | --- | --- | --- |
| 1 | 页面正常加载 | 主窗口出现 pi-web，无白屏 / 无 splash 报错 | 看 `server.log`；`check:contracts` 结果 |
| 2 | 会话正常打开 | 侧栏点一个会话，URL 出现 `?session=`；重启应用后恢复 | `smoke` 的 `/?session=` 断言 |
| 3 | 消息正常发送 | 发一条消息并收到回答 | 与桌面增强无关；若失效先怀疑上游本身 |
| 4 | 独立输入工作区 / 原生输入框 | 面板能展开、字体与原生一致、可拖宽度、草稿按页签 + 会话隔离、图片可点开预览；提交模式**全自动**（单个主按钮随 pi-web 状态切文案，无下拉），「在原生输入框中继续」收进编辑器右键菜单；发送复用原生输入框与提交按钮；`PI_WEB_DESKTOP_SELFTEST_DRAFT=1` 看 `sendPreflight` / `noInjectedEntry` / `fontMatch` / `resized` / `singleSubmit` / `autoModeIdle` / `imgVisible` / `successHintAutoHide`。另验「增强关闭时 pi-web 原生输入框仍能正常收发消息」 | 若 `[compat] composer` 为 `disabled`，增强会禁止发送并显示原因，但原生输入框必须照常可用；若上游改了提交按钮标签，`check:contracts` 的 composer 只读扫描会先报出来 |
| 5 | Agent 状态正常显示 | 后台页签跑任务 → 转圈；回答完毕 → 蓝点；等确认 → 橙点；切到该页签后提示消失。`PI_WEB_DESKTOP_DEBUG_STATUS=1` 看 `[status]` 日志，session 应与该页签 URL 一致 | `statusProbeCompatible` 降级 → 检查 `/api/agent/running` 返回结构与侧栏选择器 |
| 6 | 主题正常同步 | 切 `mist` / `pine` / `sand` 等不同主题，页签栏与窗口控件 ≤1s 跟随；冷启动不闪浅色 | `themeProbeCompatible` 降级 → 检查 CSS 变量名 |
| 7 | 通知正常工作 | 任务完成时把窗口失焦，仍弹 Windows toast 且标题带页签名；`PI_WEB_DESKTOP_DEBUG_NOTIFY=1` 看注入日志 | `notificationCompatible` 降级 → 检查上游是否还在用 `showNotification` |
| 8 | 独立输入工作区增强关闭时 | `PI_WEB_DESKTOP_DISABLE_DRAFT_WORKSPACE=1 npm run app`：页签栏按钮置灰、页面零注入，pi-web 原生 Composer 完整可用 | 若原生输入受影响，说明注入边界被破坏，先查 `composer-bridge.ts` |

补充（回归重点）：

- 4 个页签同时打开，用 DevTools Network 看 `/api/agent/running`：**每轮只有 1 个请求**，不是 4 个。
- 关掉作为状态源的页签，状态提示仍能继续更新（自动换源）。
- 服务重启（`tabs.reloadAll()`）后状态能重新初始化，不残留旧的 running。
- 扩展增强全部关闭时（`§2` 的三个环境变量），pi-web 仍能正常收发消息。

输出：把结果记回本文（版本、日期、8 条结论、`check:all` 输出）；发现契约破坏时
先按 §2 降级，再更新 §1 清单与 `scripts/check-contracts.mjs` 的依赖表。

---

## 4. 多页签状态监控改造（本轮已实施）

### 4.1 改造前 / 后

```
改造前：TabManager 每 700ms 遍历 N 个页签
        └─ 每个页面的 realm 各自 fetch /api/agent/running（缓存 600ms）
        → 每轮最多 N 份重复的全局状态请求

改造后：TabManager 每 700ms
        ├─ 选 1 个「状态源」页面 → 在页面 realm 里发 1 次 /api/agent/running（保留登录态）
        ├─ 得到 GlobalStatusSnapshot（三个数组）共享给所有页签
        └─ 每个页签只做 1 次只读 executeJavaScript 读 sessionId / DOM 兜底
        → 每轮 1 份全局状态请求，与页签数无关
```

请求仍在**页面 realm** 内发起：Cookie / Basic Auth 自动带上，主进程不获取、不保存用户密码。
状态源关闭或连续失败 3 次后，下一轮自动切到其它有效页面（优先当前激活页签）；
`reloadAll()`（服务恢复 / 重启）会清空快照并重新初始化。

### 4.2 刷新策略

| 约束 | 实现 |
| --- | --- |
| 避免重复请求 | 只有状态源页面执行 `GLOBAL_STATUS_READ_SCRIPT`；其余页面只读会话 |
| 上一次请求未结束不重入 | 页面侧 `polling` 标志 + 主进程 `pollingStatus` 双重保护 |
| 接口失败保留最后有效状态 | 页面侧失败只置 `ok=false`、不清数组；主进程只在 `ok=true` 时替换快照 |
| 不把未知当 idle | `status-model.ts` 无依据时返回 `unknown`，主进程保留上一轮状态 |
| 长时间失败 | 超过 `GLOBAL_STATUS_STALE_MS`（15s）转为 `unknown`，避免拿着过期数组假装准确 |
| 页面切换会话及时更新 | 每轮读 URL；`did-navigate-in-page` 额外触发一次即时重算 |
| 页签互不干扰 | 同一份全局数组 + 每个页签自己的 `sessionId` 计算，见 `check:status-model.mjs` |

**刷新频率**：状态监控**保持** `STATUS_POLL_MS=700` / 页面缓存 TTL `600`，没有为了减少请求
牺牲状态提示的及时性（改的只是请求份数，从 N 降到 1）。「先通过实际测量确定合理频率」这一步
需要在真实 GUI 下量测 running→idle 的感知延迟后另行调整，本文不声称已测量。

主题探测另做了优化（§6）：从「每秒一次完整读 11 个 CSS 变量」改成「页面内事件触发 +
5s 低频兜底」，常规状态下探测次数显著下降，响应反而更即时。

### 4.3 验收（`npm run check` 覆盖）

- 4 个页面 realm 安装探测脚本 → **0 次**接口请求；只有状态源页面每轮请求 1 次。
- TabStatusManager mock 回归：请求共享、页签独立、换源、连续失败、in-flight、reset。
- 多页签独立状态、running / awaiting / idle / 未读、接口失败保留快照、结构异常不覆盖缓存。
- 通知补丁 / NotificationBridge 幂等、重载、失焦、多页签标题、增强关闭、上游实现变化、监听清理。
- ThemeManager 事件信号合并、页面重载重装、变量不足保留缓存、缓存恢复、页面失效。
- 分屏布局、页签创建/关闭/固定/移动/恢复、生命周期状态机、Runtime 回滚决策、功能级兼容性结论。

---

## 5. 零侵入边界与本轮改动

**没有修改任何上游文件**：pi-web 源码、`node_modules/@agegr/pi-web/**`、`.next` 构建产物，
均未改动；没有 patch-package、没有上游定制分支、没有把 `@agegr/pi-web` 加为本地依赖。
`check:contracts` 只用 `readFileSync` 只读扫描上游构建，并把「无本地上游依赖 / 无 patch-package」
作为硬约束。

本轮改动文件（全部在 `pi-web-desktop` 内）：

| 文件 | 改动 |
| --- | --- |
| `src/main/tabs/tab-status.ts` | 重写：拆成「全局状态脚本」+「页签会话脚本」，全局脚本安装时不发请求 |
| `src/main/tabs/status-model.ts` | 新增：纯计算（全局快照 + sessionId → running/awaiting/unknown） |
| `src/main/tabs/compat.ts` | 新增：四个功能级兼容性判定 + 去重记录器（Plan 01 后 `composer` 改为按只读探针判定） |
| `src/main/tabs/theme-probe.ts` | 新增：从 `tab-manager.ts` 抽出主题探测脚本 |
| `src/main/tabs/notification-patch.ts` | 新增：抽出 Windows 通知补丁，返回 JSON 诊断，补只读契约检测脚本 |
| `src/main/tabs/tab-manager.ts` | 接入共享快照、状态源换源、功能开关、兼容性记录；移除内联脚本 |
| `scripts/check-tab-status-probe.mjs` | 重写：覆盖请求共享 / in-flight / 失败保留 / 不读全局未读 |
| `scripts/check-theme-probe.mjs` | 改为检测 `theme-probe.ts` |
| `scripts/check-contracts.mjs` | 新增：机器可读依赖清单 + 内部漂移 + 上游只读契约扫描 |
| `scripts/check-status-model.mjs` / `check-split.mjs` / `check-compat.mjs` / `check-notification-patch.mjs` | 新增：纯逻辑 / 分屏 / 兼容性 / 通知回归 |
| `package.json` | 新增 `check` / `check:all` 及 11 个子检查命令 |
| `README.md` | 命令与文档对齐，新增「上游兼容性与增强开关」 |
| `docs/development/pi-web-compatibility.md` | 本文 |

第二轮新增（第三 / 四 / 六 / 七 / 八阶段）：

| 文件 | 改动 |
| --- | --- |
| `src/main/tabs/tab-status-manager.ts` | 新增：全局快照 / 选源 / 换源 / 每页签计算编排（不依赖 Electron，可 mock 回归） |
| `src/main/tabs/notification-bridge.ts` | 新增：通知注入、焦点同步、幂等、detach/dispose 清理 |
| `src/main/tabs/theme-manager.ts` | 新增：主题读取 / 缓存 / 事件驱动 / 低频兜底 / 兼容结论 |
| `src/main/tabs/theme-probe.ts` | 追加只读 `THEME_CHANGE_OBSERVER_SCRIPT` 与事件标记 |
| `src/main/tabs/tab-lifecycle.ts` | 新增：Loading/Ready/Crashed/Recovering/Destroyed 纯状态机 |
| `src/main/tabs/tab-model.ts` | 新增：页签创建/关闭/固定/移动的边界 + 内存态↔持久化映射 |
| `src/main/server/runtime-update.ts` | 新增：更新失败时「要不要回滚 / 怎么表述」的纯决策 |
| `src/main/settings-service.ts` | 更新失败时尝试恢复旧版本并**验证**，验证不过不声称已回滚 |
| `src/main/tabs/tab-manager.ts` | 接入 4 个抽出的管理器；崩溃状态机、显式重载入口；移除纯算法 |
| `src/shared/types.ts` / `preload/tabbar.ts` / `main/ipc.ts` | `reloadCrashed` 通道 + `TabInfo.crashed` 可选字段 |
| `src/renderer/tabbar/{tabbar.ts,style.css}` | 崩溃页签显示「↻ 重新加载」入口 |
| `scripts/check-*.mjs`（6 个新增） | 状态管理器 / 通知桥 / 主题管理器 / 生命周期 / 页签模型 / Runtime 回滚 |
| `scripts/check-contracts.mjs` | 增加事件标记一致性、注入脚本已分离、拆分模块存在性等硬约束 |
| `tsconfig.json` | `allowImportingTsExtensions`（Node strip-types 直接跑 TS 模块做回归） |
| `README.md` / `docs/TESTING.md` | 命令、崩溃恢复与更新回滚自测条目 |

`tab-manager.ts` 由 **1460 → 约 1375 行**：注入脚本、状态监控、通知、主题、生命周期、
页签顺序算法共拆出 **11 个可独立测试的模块**；对外接口、快捷键、分屏与页签管理行为、
`TabsSnapshot` 现有字段语义都没变（`TabInfo` 只新增两个可选字段）。
按「渐进式拆分、不一次性重写」的要求，下一步仍可继续抽 `TabLayout` / `TabLifecycle`
的视图操作部分，每抽一个跑一次 `npm run check`。

---

## 6. 后续阶段的实施与审查结论

- **第三阶段 TabManager 拆分（已做）**：抽出 `TabStatusManager`、`NotificationBridge`、
  `ThemeManager`、`tab-lifecycle.ts`、`tab-model.ts`，主文件净减约 85 行且 11 个模块可单测。
  `check:contracts` 会守住「`tab-manager.ts` 里不得再出现内联 `String.raw` 注入脚本」。
- **第四阶段 主题探测（已做）**：改为**事件驱动 + 低频兜底**。页面 realm 里的只读
  MutationObserver（`data-theme` / class）、`storage` 事件（`pi-theme`）、`matchMedia` 变化
  会打一条标记日志，主进程用 Electron 的 `console-message` 收到后立即读一次主题；
  同一批信号 120ms 合并；兜底轮询从 1s 降到 5s。仍然不往 pi-web 页面塞 preload，
  读不到变量时保留当前主题缓存、不影响 pi-web 显示。`check:theme-manager` 覆盖
  主题切换、自定义主题、页面未加载完、页面失效、重载、缓存恢复。
- **第五阶段 大输入框**：按确认结论**不恢复旧设计**（`composer-expand.ts` 未恢复、
  `check-composer-expand.mjs` 未恢复）。Plan 01 另起一套不同设计，见下。
- **Plan 01 独立输入工作区（已做 MVP）**：Electron 侧独立面板 + Electron 侧草稿状态，
  页面 realm 只跑只读探针 / 复用原生发送按钮（不注入可见按钮）；`composerCompatible` 改为
  按实际探针判定（不再恒为 `disabled`）。新增 `draft-model.ts`（纯逻辑）、
  `draft-persistence.ts`（`drafts.json`）、`draft-workspace.ts`（编排）、
  `composer-bridge.ts`（注入脚本）、`src/renderer/tabbar/draft-panel.ts`（面板 UI）；
  `tab-manager.ts` 只加 `reservedRightWidth` 与三个回调，不重构 Composer / TabManager。
  回归：`check:draft-model` / `check:composer-bridge` / `check:draft-workspace` +
  真实 Electron GUI 自测（`PI_WEB_DESKTOP_SELFTEST_DRAFT=1`）。
- **第六阶段 崩溃恢复（已做）**：`tab-lifecycle.ts` 明确五种状态；`render-process-gone`
  只标记 Crashed、保留页签与 `tab.path` 会话 URL、停止该页签的状态请求源，
  **不销毁页签、不自动重载、不停服务**；页签栏显示「↻ 重新加载」，右键菜单文案改为
  「重新加载崩溃页面」。`reloadCrashed()` 先用 `isServing` 验证服务端仍应答（任何 HTTP
  状态码算存活，兼容 Basic Auth），再用保存的会话 URL 恢复；服务未就绪就回到 Crashed
  并说明原因。恢复完成（did-finish-load）后回到 Ready，dom-ready / did-finish-load
  会重装状态探测、通知补丁、主题 observer，状态请求源下一轮重选。
  资源清理：disposeTab 摘掉通知/主题监听并标记 Destroyed，destroy 清理定时器与全部监听。
- **第七阶段 Runtime 更新（审查 + 低风险加固）**：仍是全局 npm 安装，**会影响终端里的
  pi-web**，这一点无法在不引入多版本 Runtime 的前提下消除，已明确记录。原流程在失败时
  只恢复「服务可用性」，全局包可能已被覆盖。本轮加了：只有确实执行过 `npm install -g`
  且解析到的版本与更新前不同才尝试恢复旧版本；恢复后必须再次 `resolveInstall()`
  **验证版本确实完整保留**，验证通过才说「已恢复并验证」；npm 回滚失败或校验不通过都
  给出可执行的手动命令。「更新成功但启动失败」这条也走同一回滚路径。
  registry 不可用 / 多实例占用 / 端口被占仍由原有分支处理；更新中断（进程被杀）时
  服务已停，下次启动由健康监护自愈，但全局包可能半更新 —— 仍属已知风险，不做自动修复。
- **第八阶段 自动化回归（已做）**：`npm run check` 现包含 typecheck + 16 项回归（见 §7，Plan 01 新增 3 项），页签创建/关闭/
  固定/移动/恢复、状态、兼容性、生命周期、Runtime 回滚决策都有不依赖 GUI 的断言。
  GUI 人工清单仍在 `docs/TESTING.md`。
- **分屏已知限制（按计划不改算法）**：`src/shared/split.ts` 保持原样。窗口内容区小于
  `n + gap*(n-1)` 的极端缩窗下，后续窗格会排在可视区外被裁剪（不会负宽高 / NaN）。
  按「保留现有分屏算法 / 不改变现有行为」仅记录。

---

## 7. 检查命令速查

| 命令 | 作用 | 需要 GUI / 联网 |
| --- | --- | --- |
| `npm run check` | typecheck + 16 项静态/纯逻辑回归（契约、主题、状态、分屏、页签、生命周期、Runtime、草稿、Composer 桥接、工作区编排） | 否 / 否 |
| `npm run check:all` | `check` + `smoke`（真起临时 pi-web 服务） | 否 / 否（需本机装了 pi-web） |
| `npm run check:contracts` | 内部依赖漂移 + 上游 `.next` 只读契约扫描 + 零侵入硬约束 | 否 / 否 |
| `check:status` / `check:status-model` / `check:status-manager` | 注入脚本 / 状态计算 / 编排 | 否 / 否 |
| `check:theme` / `check:theme-manager` / `check:notification` / `check:notification-bridge` | 脚本 + 管理器 | 否 / 否 |
| `check:compat` / `check:split` / `check:lifecycle` / `check:tab-model` / `check:runtime-update` | 兼容性 / 分屏 / 生命周期 / 页签 / Runtime 回滚 | 否 / 否 |
| `check:draft-model` / `check:composer-bridge` / `check:draft-workspace` | 草稿隔离 / 注入脚本安全契约 / 工作区编排（成功清空、失败保留、连点去重、不兼容禁止发送） | 否 / 否 |
| `PI_WEB_DESKTOP_SELFTEST_DRAFT=1 npm run app` | 真实 Electron GUI 自测（打开关闭、长文本、页签隔离、视图 bounds、重启恢复、原生 Composer 探针；不发真实消息） | 是 / 视服务而定 |
| `PI_WEB_DESKTOP_DEBUG_COMPAT=1 npm run app` | 在 `server.log` 打印全部兼容性结论 | 是 / 视服务而定 |
| `docs/TESTING.md` | 人工自测清单（页签 / 分屏 / 托盘 / 通知 / 主题 / 崩溃 / 异常路径） | 是 / 视服务而定 |

> `check` 里的 TS 模块用 Node 22 的 `--experimental-strip-types` 直接加载，因此这些模块
> 避免参数属性、运行时 import 用显式 `.ts` 扩展名（`tsconfig` 已开
> `allowImportingTsExtensions`，electron-vite 构建同样能解析）。

---

## 8. 尚未完成 / 待验证（不能视为「已全部完成」）

代码层的改动都已落地并通过 `npm run check` / `check:all` / `npm run build`，
但下列项目仍未满足或未经真机验证：

| # | 项目 | 状态 | 属于 |
| --- | --- | --- | --- |
| 1 | GUI 人工回归（页签 / 分屏 / 托盘 / 通知 / 主题 / 崩溃 / 更新 / 独立输入工作区） | 独立输入工作区已有自动化 GUI 自测（`PI_WEB_DESKTOP_SELFTEST_DRAFT=1`，含不兼容模拟）；其余仍需真机按 `docs/TESTING.md` 过一遍（G~M 条） | 验收 |
| 2 | 「未知 pi-web 版本 → 显示未验证提示」 | 只写 `server.log` 的 `[compat] … unverified`，**没有 UI 提示** | Plan 3.3 |
| 3 | §3 升级回归清单的**实际执行结果** | 文档只有清单（现 8 条），没有「当前版本 / 新版本对比后的 8 条结论」记录 | Plan 3.4 |
| 4 | `TabLayout` 模块抽取 | `layout()` / `paneRects()` / `setVisible` 仍在 `tab-manager.ts` | Plan 5.1（渐进式，可选） |
| 5 | 崩溃恢复「原会话是否可恢复」 | 只验证了服务存活（`isServing`），未验证 session id 在服务端仍有效 | Plan 8.2 |
| 6 | 回滚「旧版本确实完整保留」 | 只验证 `resolveInstall().version`，未校验 `.next` 等文件完整性 | Plan 9 |
| 7 | 「通过实际测量确定合理刷新频率」 | 保持 700ms / 600ms 未改，running→idle 感知延迟未量测 | Plan 4.3 |
| 8 | 更新中断导致全局包半更新、全局安装影响终端 pi-web | 已知限制，按 Plan「不引入多版本 Runtime」有意不改 | Plan 9 |
| 9 | 分屏极端缩窗的窗格越界 | 已知限制，按「保留现有分屏算法」有意不改 | Plan 5.3 |

前 3 项与第 5~7 项仍可继续实施；第 8、9 项是经确认保留的限制。

Plan 01 已知边界（有意不做，MVP 范围）：不做富文本 / Markdown 编辑器、不做模板管理；
草稿按「页签 + 会话」隔离，同一个会话在两个页签同时打开时，重启恢复只把那份草稿还原到
其中一个页签（一对一匹配，避免同一草稿出现在两个页签）；发送成功判定依赖 pi-web
「提交时清空 textarea / 失败时放回文本」这一行为，若上游改成别的行为，会走「未能确认已送达」
分支并保留草稿（不会误清空）。
