# pi-web-desktop 定制计划

配套文档：[方案分析](./ANALYSIS.md)

## 0. 目标定义（Definition of Done）

1. 双击桌面图标 → 服务自动启动（无需终端）→ 窗口内显示 pi-web，全程无系统浏览器弹出。
2. 窗口内有多页签：`Ctrl+T` 新页签、`Ctrl+W` 关页签、页签标题显示会话名、可拖动排序、**可固定到最左（固定后仅显图标，不可误关）**、重启应用后恢复页签与固定状态。
3. pi-web 的「Open in new tab」在应用内变成新页签；第三方链接（OAuth 登录等）交给系统浏览器。
4. 关闭窗口 = **最小化到托盘**（服务继续跑，手机/局域网仍可用）；托盘菜单「退出」才停止服务。异常退出下次启动能自愈。
5. **上游零侵入**：`npm i -g @agegr/pi-web@latest` 后重启应用即用上新版本，壳子不需改动。
6. 打包产物：**绿色版为主**（`pi-web-desktop-0.1.0-portable.exe`，免安装、配置跟随 exe）；安装版配置一并写好，需要时一条命令出 `Setup.exe`。
7. **局域网 / 手机访问**：设置里一个开关，开启即绑 `0.0.0.0` + 强制密码（沿用上游 `PI_WEB_PASSWORD` 机制），列出局域网 URL 供复制到手机（二维码不做，后续再加）。
8. **开机自启**：设置项可勾选，**默认关闭**（`app.setLoginItemSettings`）。

---

## 1. 目录结构（目标形态）

```
D:\person\pi-web-desktop\
├── package.json
├── electron.vite.config.ts          # electron-vite：main / preload / renderer 三份构建
├── electron-builder.yml             # 打包配置（NSIS 安装版 + portable 绿色版）
├── build/
│   ├── icon.ico
│   └── icon.png
├── docs/
│   ├── ANALYSIS.md
│   └── PLAN.md
├── scripts/
│   └── smoke.mjs                    # 契约冒烟测试（见 §6）
└── src/
    ├── main/
    │   ├── index.ts                 # app 生命周期、单实例、窗口创建、开机自启
    │   ├── settings.ts              # userData/settings.json 读写 + 默认值
    │   ├── server/
    │   │   ├── resolve-pi-web.ts    # 定位 pi-web 安装位置 / node 可执行文件
    │   │   ├── server-manager.ts    # 探测复用 / spawn / Ready 等待 / 收尸
    │   │   ├── run-records.ts       # 只读 ~/.pi/agent/pi-web-run/*.json
    │   │   ├── network.ts           # 局域网 IP 枚举 + 可访问 URL
    │   │   └── port.ts              # 端口探测与回退
    │   ├── security/
    │   │   └── secret-store.ts      # 密码加密存取（系统凭据加密）
    │   ├── tabs/
    │   │   ├── tab-manager.ts       # WebContentsView 增删切换排序 + 固定页签
    │   │   ├── tab-persistence.ts   # 页签状态读写（url/title/pinned）
    │   │   └── shortcuts.ts         # 全局/局部快捷键
    │   ├── ipc.ts                   # 主进程 ↔ 页签栏 UI 的 IPC 定义
    │   ├── context-menu.ts          # 页签右键菜单（固定/关闭其他/复制链接）
    │   ├── menu.ts                  # 应用菜单
    │   └── tray.ts                  # 托盘：显示/隐藏、页签切换、局域网地址、退出并停服务
    ├── preload/
    │   └── shell.ts                 # 仅给页签栏 UI 用，contextBridge 暴露小 API
    └── renderer/
        ├── tabbar/index.html
        ├── tabbar/index.ts          # 页签栏逻辑
        ├── tabbar/style.css         # 参考 pi-web 深色/浅色主题
        ├── settings/index.html      # 设置面板（远程访问 / 关闭行为 / 开机自启）
        └── splash/index.html        # 启动中/失败重试/日志面板
```

---

## 2. 里程碑

### M0 — 骨架跑通 ✅ 已完成

| # | 任务 | 产出 |
| --- | --- | --- |
| 0.1 | `npm init` + electron / electron-vite / electron-builder / typescript | ✅ electron 45.2.3 / TS 7.0.2 / vite 8.3.7 |
| 0.2 | `resolve-pi-web.ts`：设置项 → `npm root -g`（走 npm-cli.js，不用 shell）→ `where pi-web` 推导 → node 同级全局 node_modules | ✅ 实测定位到 node 22.22.1 + pi-web 0.15.0 |
| 0.3 | `server-manager.ts`：复用探测 + spawn（`--no-open -H 127.0.0.1`）+ HTTP 轮询就绪 + 日志落盘 | ✅ Ready 213ms，日志写入 `data/server.log` |
| 0.4 | 主窗口：splash 页（状态/日志/重试）→ 就绪后加载 pi-web | ✅ 截图验证 |
| 0.5 | 退出收尸：`taskkill /PID /T /F` + `before-quit` 优雅等待 | ✅ 退出后端口释放、运行记录无残留 |

额外落地（M0 期间）：
- `scripts/smoke.mjs` 契约冒烟：4 项全绿（定到 pi-web → `GET /` 200 → `/?session=<id>` 200 → 杀进程树后端口释放/记录清理）。
- 复用路径：已有外部 pi-web 时直接复用（`managed:false`），退出不杀它。
- 开发调试钩子：`PI_WEB_DESKTOP_AUTOQUIT_MS`（定时优雅退出）、`PI_WEB_DESKTOP_SCREENSHOT` / `PI_WEB_DESKTOP_SPLASH_SHOT`（自动截图）、`PI_WEB_DESKTOP_HOLD_SPLASH`（停在 splash 看 UI）。
- 修掉一个真实 bug：首启时只启动服务却未创建主窗口（现在 `start()` 的 ready 结果直接打开窗口）。

**验收结果**：`npm run dev` 后不出现系统浏览器，窗口显示 pi-web；退出后 `http://127.0.0.1:30555` 不再应答；复用 30141 时退出后仍正常应答。

### M1 — 页签（含固定/置顶）✅ 已完成

| # | 任务 | 结果 |
| --- | --- | --- |
| 1.1 | `TabManager`：每个页签一个 `WebContentsView`（`partition:persist:piweb`、`sandbox:true`） | ✅ |
| 1.2 | 页签栏 UI（窗口自身 webContents 渲染，下方留出视图区） | ✅ 截图验证 |
| 1.3 | 标题与图标：`page-title-updated` / `page-favicon-updated`（去掉 “\- Pi Web” 后缀） | ✅ |
| 1.4 | `setWindowOpenHandler`：同源 → App 内页签；外链 → `shell.openExternal` | ✅ 自测 `open 3→4` |
| 1.5 | 快捷键：Ctrl+T/W/Tab/1-9/R/Shift+R/±/0、F12、Ctrl+Shift+I | ✅ 代码就位 |
| 1.6 | 页签持久化 `data/tabs.json`（url/title/pinned + activeIndex）+ 启动恢复 | ✅ 重启后 pinned 与顺序保留 |
| 1.7 | 关最后一个页签 → 开一个新的 `/`（而不是关窗口，避免误杀服务） | ✅ 与计划略不同，见下 |
| 1.8 | **固定页签**：右键菜单固定/取消固定 → 靠最左、收窄为图标、`Ctrl+W`/中键不关 | ✅ `pinFirst=true pinnedKept=true` |
| 1.9 | 固定状态持久化；新页签插在固定区之后；拖动排序不跨越固定区 | ✅ |
| 1.10 | 右键菜单：固定/重新加载/复制会话链接/在新页签打开/关闭/关闭其他/关闭右侧 | ✅ |

**M1 的自测脚本输出（`PI_WEB_DESKTOP_SELFTEST=1`）**

```
[selftest] open 3→4（execute=true） pinFirst=true pinnedKept=true close→3
```

**与计划的偏差（有意）**

- 关掉最后一个页签不关窗口，而是新开一个 `/` 页签：M2 接管托盘后窗口“关≠退”，保留一个页签更符合直觉，也避免误杀服务。
- 固定页签禁止 `Ctrl+W`/中键关闭，只能在右键菜单里显式关闭。

**踩到的坑（已解决，写进 §5）**：`sandbox:true` 的 preload **不能 require 共享 chunk**；两个 preload 共用 `shared/types.ts` 里的常量会被拆成 `preload/chunks/*.js`，导致 `contextBridge` 根本没执行（表现：页签栏空白、状态恒为“…”）。现在通道名在各自 preload 里内联。

### M1+ — 页签打磨（延后到 M4）

| # | 任务 | 产出 |
| --- | --- | --- |
| 1.1 | `TabManager`：每个页签一个 `WebContentsView`（`partition:"persist:piweb"`，`sandbox:true`） | 能开/关/切换 |
| 1.2 | 页签栏 UI（窗口 `webContents` 加载本地 HTML），下方给视图留出 bounds | 页签可见可点 |
| 1.3 | 标题与图标：监听 `page-title-updated` / `page-favicon-updated` | 页签显示会话名 |
| 1.4 | `setWindowOpenHandler`：同源 URL → 新页签；其它 → `shell.openExternal` | 上游「Open in new tab」正确落到页签 |
| 1.5 | 快捷键：`Ctrl+T/W/Tab/Shift+Tab/1..9/R/Shift+R/F/+-/0`、`F12` | 体感接近浏览器 |
| 1.6 | 页签持久化 `userData/tabs.json`（含激活索引 + pinned 标记）+ 启动恢复 | 重启还原 |
| 1.7 | 关最后一个页签 = 关窗口（或留空白页，二选一，默认关窗口） | — |
| 1.8 | **固定页签**：页签右键菜单「固定 / 取消固定」，固定后移到最左侧、只显图标（hover 显示标题）、宽度收窄、`Ctrl+W` 与中键点击不关闭 | 固定可用 |
| 1.9 | 固定状态持久化；`Ctrl+Tab` 遍历包含固定页签；新页签永远插在固定区之后 | 重启保持 |
| 1.10 | 页签右键菜单其余项：关闭其他 / 关闭右侧 / 复制会话链接（`?session=`）/ 在新窗口打开 | 好用 |

**验收**：开 3 个不同会话页签，把其中一个固定，重启应用后页签与固定状态自动恢复且都停在对应会话；从 pi-web 侧栏右键「Open in new tab」不再弹外部浏览器。

**M1 实现位置**：`src/main/tabs/tab-manager.ts`（核心）、`tab-persistence.ts`、`src/preload/tabbar.ts`、`src/renderer/tabbar/*`。

### M2 — 体验与健壮性 ✅ 已完成

| # | 任务 | 结果 |
| --- | --- | --- |
| 2.1 | 启动页（splash）：进度 + 日志 + 重试 / 打开日志 / 数据目录 | ✅ 截图验证 |
| 2.2 | 复用已有服务（仅限回环 + 未要求局域网时） | ✅ |
| 2.3 | 端口回退（30142–30150），被占但不可复用时自动换口 | ✅ |
| 2.4 | 应用菜单（文件 / 编辑 / 视图 / 服务 / 帮助） | ✅ |
| 2.5 | **托盘常驻**：关窗口→隐藏，托盘菜单含页签/局域网/重启/退出 | ✅ `window=存活 visible=false tray=true` |
| 2.6 | 通知：服务失败走托盘气泡（不再用主进程 toast，避免 Electron.lnk） | ✅ |
| 2.6b | 通知：pi-web 任务完成时弹 Windows 通知（注入补丁回落 `window.Notification` + 同步窗口焦点 + 标题拼页签名 + watch 清理 `Electron.lnk`） | ✅ |
| 2.7 | 下载交给 Electron 默认流程；上传/粘贴图片 | ✅（Chromium 原生行为） |
| 2.8 | `node ≥ 22.19` 检查 + 可操作错误页 | ✅ |
| 2.9 | **设置面板**：窗口行为/置顶/开机自启/恢复页签/端口/局域网/状态 | ✅ 截图验证 |
| 2.10 | **局域网开关**：强制密码 + 系统凭据加密存储 + 环境变量传给子进程 | ✅ 见下 |
| 2.11 | 局域网地址列表（可复制） | ✅ `http://10.225.11.112:30141` |
| 2.12 | 防火墙：**只展示可复制的 netsh 命令，从不执行、不改系统** | ✅ |
| 2.13 | 开机自启（默认关闭，绿色版置灰） | ✅ |
| 2.14 | `--hidden` 启动（开机自启时直接进托盘） | ✅ |

**M2 实测**

```
[remote] 绑定 0.0.0.0，已启用密码访问（密码不写入日志）
[port]   30141 被占用（本次要求局域网+密码，不能复用外部实例），改用下一个端口
[ready]  http://127.0.0.1:30142 (pi-web v0.15.0)
[selftest-remote] lan=http://10.225.11.112:30142  GET / → 307（重定向到 /login，密码生效）
[selftest-tray]   window=存活 visible=false tray=true
```

**安全规则（重要）**：开启局域网+密码时**绝不复用**外部实例，也不复用非回环绑定或没有运行记录的实例——保证“显示在局域网上的服务”一定是带密码的那个。

**M2 期间修掉的问题**

1. 延迟回调（截图 / 自测）在窗口被销毁后仍访问 `webContents` → 主进程报 `Object has been destroyed` 弹框。现在所有延迟回调都先 `isDestroyed()` 检查 + `try/catch`，并加了 `uncaughtException` 兵底日志。
2. `saveSettings` 会把 patch 里的 `undefined` 覆盖进配置，导致 `settings.json` 丢字段。现在忽略 `undefined`。
3. 设置页 `.remote { display:flex }` 把 `[hidden]` 覆盖了（未开局域网时仍显示密码框），加 `[hidden] { display:none !important }`。

### M2.5 — 使用反馈修复（已做）

| 问题 | 原因 | 修复 |
| --- | --- | --- |
| 不开终端时应用不可用 | 先复用了外部实例，外部实例被关后应用仍以为服务在跑，无自愈 | 新增**服务健康监护**：5s 探测一次，连续 2 次失败→ 杀残留→ 重拉；复用实例消失时**自动接管**；带 3 次/2 分钟限制避免死循环 |
| 页签栏固定深色，与 pi-web 主题不一致 | 页签栏颜色写死 | 2s 轮询 `document.documentElement.dataset.theme`（只读），页签栏跟随明/暗；新增 light/dark 变量集 |
| 顶部莫名多一个固定的 `person` 页签 | 自动化测试写入 `tabs.json` 的残留数据 | 清空为单个 `/` 页签，并在 README 解释页签/固定逻辑 |
| 任务栏/Alt+Tab 显示 Electron 原子图标 | Windows 按 AUMID 解析开始菜单快捷方式的图标，覆盖了窗口 icon | 见 M2.6 图标方案（定案） |
| 页签栏不跟深色主题（固定白色） | 主题探测脚本有语法错误（模板字符串里正则转义）→ 包在 try 里但整体抛错，永远回落到 light | 重写探测脚本（无转义 / 内部 try 返回错误文本 / 三路回退：`dataset.theme` → localStorage `pi-theme` → 背景色亮度 → 系统），并加 `PI_WEB_DESKTOP_DEBUG_THEME` 日志 |

### M2.6 — 图标方案（定案）

| 项 | 做法 |
| --- | --- |
| 图标真源 | `build/logo.svg`；`npm run icons` 生成 `icon.ico`（16/32/48/64/128/256）、`icon.png`（窗口回落）、`tray.png`（托盘）、`src/renderer/assets/logo.png`（启动页 / 设置页） |
| 启动 | 官方 `electron.exe` 直接跑 `out\main\index.js`，不复制、不改写 Electron 二进制；`npm run dev` / `npm run app` 同一套逻辑 |
| 窗口 / 任务栏 / Alt+Tab | `windowIconPath()` 取 `icon.ico`，`applyWindowIcon()` 在窗口创建后再 `setIcon` 一次；splash / 主窗口 / 设置窗口统一 |
| 快捷方式 | `npm run shortcut` 生成项目根目录 / 桌面 / 开始菜单三个 `Pi Web Desktop.lnk`：target=`electron.exe`、参数=`out\main\index.js`、`IconLocation=icon.ico`、写入 `System.AppUserModel.ID` 与固定的 `ToastActivatorCLSID`（与主进程一致） |
| 托盘 | `tray.png` 缩到 16px，由 `Tray` 直接创建（不经过 AUMID） |
| AUMID | 主进程固定 `com.local.piweb.desktop`，并固定 `ToastActivatorCLSID`（`app.setToastActivatorCLSID`），保证重启后 toast 仍可激活；Windows 任务栏按 AUMID 去开始菜单找带同 ID 的快捷方式取图标（会覆盖窗口 icon），所以脚本每次清空该 ID 的旧注册点，再重建唯一一个并刷新 Shell 缓存 |
| 通知 | 主进程服务失败提示仍走托盘气泡；**pi-web 任务完成通知**是页面里的 `new Notification()`，属于 Windows toast，关不掉。实测 pi-web 优先用的 `ServiceWorkerRegistration.showNotification()` 在 Electron/Windows 上会「resolve 但没有 toast」，且 WebContentsView 失焦后 `document.hasFocus()` 仍为 true 会让 pi-web 判定「仍在前台」。页面加载后注入补丁：让 SW 通知 reject 回落 `window.Notification`，把 BrowserWindow 焦点同步给 `document.hasFocus()`，并包装 `Notification` 构造器把页签名拼进通知标题（多项目时能分清是谁完成了）。toast 会让 Electron 生成 `Electron.lnk`，`watchAutoShortcuts()` 在目录变化 500ms 后清理（启动 / 8 秒 / 每 10 秒兜底），任务栏图标不会被顶掉 |

排查：任务栏不是 π → 查开始菜单有没有 `Electron.lnk` → `npm run shortcut` + 重启应用（脚本会补齐 AUMID / ToastActivatorCLSID）→ 看 `server.log` 的 `[icon]` 日志，详见 [TESTING 图标专项排查](TESTING.md)。

### M3 — 打包分发（约 0.5 天）

| # | 任务 |
| --- | --- |
| 3.1 | `electron-builder.yml`：默认 target = **`portable`**（日常用）；`nsis` 配置同文件保留，打包时加一个参数即可出安装版 |
| 3.2 | 图标、产品名 `Pi Web Desktop`、版本号、`appId: com.local.piweb.desktop`（图标已由 `npm run icons` 从 `build/logo.svg` 生成：`build/icon.ico`） |
| 3.3 | 快捷方式：绿色版不创建；安装版才创建（桌面/开始菜单） |
| 3.4 | `.npmrc` 写入 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 解决下载慢 |
| 3.5 | 首次启动引导页：自动检测 pi-web 安装；未安装则提示「复制 `npm i -g @agegr/pi-web`」 |
| 3.6 | 数据目录策略：检测到 `PORTABLE_EXECUTABLE_DIR`（绿色版）→ `userData = <exe目录>/data`；否则用 `%APPDATA%\Pi Web Desktop`。两种形态共用同一套代码 |
| 3.7 | 快捷启动：放一份 `Pi Web Desktop.lnk` 到项目目录供自用（不想用 electron-builder 时也能直接跑） |

**验收**：
- `npm run dist` 产出 `pi-web-desktop-0.1.0-portable.exe` → 拷到 `D:\tools\` 双击即可用，页签/设置写在同级 `data\`；
- 想要安装包时：`npm run dist -- --win nsis` 直接出 `Setup.exe`（配置已就绪，无额外代码改动）。

### M4 — 打磨（可选，按需）

- 自定义标题栏（页签栏即标题栏，隐藏系统边框，Windows `titleBarStyle:'hidden'` + 自绘三键）
- 页签拖拽排序动画、按项目分组、「休眠页签」（长时间未用 `destroy()` 保留 URL）
- 接管 `pi-web:session-row-contextmenu`（文档化事件），在菜单里加「在应用内新页签打开」「复制会话链接」
- 多窗口（每窗口一套页签，共享同一个服务）
- 「重启以应用 pi-web 新版本」提示（比对 `pi-web version` 与启动时记录）
- 二维码（本地生成，带 `?cwd=` 直达项目）——按需再加

---

## 3. 关键实现骨架

### 3.1 定位 pi-web（容错是重点）

```ts
// src/main/server/resolve-pi-web.ts
export type Resolved = { nodePath: string; scriptPath: string; version: string };

const APP = "@agegr/pi-web";

export function candidateScripts(): string[] {
  const out: string[] = [];
  if (process.env.PI_WEB_CMD) out.push(process.env.PI_WEB_CMD);        // 用户显式指定
  for (const root of npmGlobalRoots()) out.push(join(root, APP, "bin", "pi-web.js"));
  for (const dir of wherePaths("pi-web")) out.push(join(dir, "node_modules", APP, "bin", "pi-web.js"));
  return uniq(out.filter(existsSync));
}
```

`node` 的解析：优先 `where node`（跳过 Electron 自带），其次 nvm/volta 常见路径；**绝不使用 `process.execPath`**（Electron 的 Node ABI 与 `node-pty` 不兼容）。

### 3.2 启动与就绪判定

```ts
// src/main/server/server-manager.ts（要点）
const child = spawn(nodePath, [scriptPath, "--no-open", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: homedir(), env: { ...process.env, PI_WEB_NO_OPEN: "1" },
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});

// 双保险：看 stdout 的 "Ready"，同时轮询 HTTP（首屏可能还要几秒加载 pi SDK）
await Promise.race([waitForLog(child, "Ready"), pollHttp(url, { timeoutMs: 60_000 })]);
```

退出清理：

```ts
function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else process.kill(pid, "SIGTERM");
}
```

### 3.3 页签 = WebContentsView

```ts
// src/main/tabs/tab-manager.ts（要点）
const TABBAR_HEIGHT = 40;

function createTab(url: string) {
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:piweb",   // cookie / localStorage 持久化（密码登录态不丢）
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: TABBAR_HEIGHT, width: W, height: H - TABBAR_HEIGHT });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSameOrigin(target)) { openTab(target); return { action: "deny" }; }
    shell.openExternal(target);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (e, target) => {
    if (!isSameOrigin(target)) { e.preventDefault(); shell.openExternal(target); }
  });
  view.webContents.loadURL(absolute(url));  // 相对 URL（"?session=xxx"）补全到服务地址
  view.webContents.on("page-title-updated", (_e, title) => notifyTabbar(tab.id, { title }));
  view.webContents.on("page-favicon-updated", (_e, icons) => notifyTabbar(tab.id, { favicon: icons[0] }));
  return view;
}
```

要点：
- 切换页签 = 非激活视图 `setVisible(false)`（或移出 `contentView`），激活的 `setBounds` 到当前窗口尺寸。
- `?session=xxx` 是相对 URL，必须用服务地址补全（上游 `window.open` 传的就是相对路径）。
- 页签身份持久化为 `{url, title}`，恢复时逐个 `loadURL`。

### 3.4 页签栏 ↔ 主进程 IPC（最小面）

```ts
// shell API（contextBridge 暴露给页签栏 UI）
type ShellApi = {
  listTabs(): Promise<TabInfo[]>;
  openTab(url?: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  moveTab(id: string, index: number): Promise<void>;
  onTabsChanged(cb: (tabs: TabInfo[], activeId: string) => void): () => void;
  onServerState(cb: (s: ServerState) => void): () => void;   // starting | ready | failed | reused
  serverAction(a: "restart" | "logs" | "status" | "update-check"): Promise<void>;
};
```

### 3.5 会话契约依赖点（升级时重点回归）

```
GET    http://127.0.0.1:30141/                    服务器存活探测
GET    http://127.0.0.1:30141/?session=<id>       页签恢复
window.open("?session=<id>" | "?cwd=<path>")      壳子劫持为页签
```

以上 3 条出现变化时，只需改 `isSameOrigin` / `openTab` 的 URL 归一化逻辑，其余不受影响。

---

## 4. 配置项（`userData/settings.json`）

```jsonc
{
  "port": 30141,                       // 首选端口
  "portFallbackRange": [30142, 30150], // 被占用时回退
  "piWebScriptPath": null,             // 覆盖自动探测
  "nodePath": null,                    // 覆盖 node 路径
  "reuseRunningServer": true,          // 已有实例时复用

  "remoteAccess": {                    // 局域网 / 手机访问（默认关闭）
    "enabled": false,
    "hostname": "0.0.0.0",
    "passwordRef": "secure.bin:remote-access"   // 密码不落明文
  },

  "closeBehavior": "tray",             // tray（默认） | quit
  "launchAtLogin": false,              // 默认关闭，设置里可勾选
  "restoreTabs": true,
  "alwaysOnTop": false,                // 窗口置顶（菜单可临时切换）
  "exportOpensInTab": false            // 导出默认走系统浏览器
}
```

---

## 5. 开发命令

```powershell
cd D:\person\pi-web-desktop
npm install          # Electron 二进制走 .npmrc 里的 npmmirror 镜像
npm run dev          # electron-vite 开发（主进程热重启 + splash 页）
npm run smoke        # 契约冒烟：启动→探测→/?session=→收尸
npm run build        # 构建到 out/
npm run typecheck    # tsc --noEmit（本机 TS 7，已无 baseUrl）
npm run dist         # electron-builder 打绿色版（M3）
```

**本机环境注意**（已在 `.npmrc` / 代码里处理，换机器时注意）：

1. `NODE_ENV=production` 会让 npm 跳过 devDependencies（现象：node_modules 只剩几个空目录、提示 `up to date`）。项目 `.npmrc` 里写了 `include=dev`。
2. Electron 的 postinstall 可能不执行（无 `node_modules/electron/dist`）。补：`node node_modules/electron/install.js`。
3. 全局 npm 的查询不能用 `shell: true` 碰 `npm.cmd`（会报 DEP0190；且 Electron 下 `process.execPath` 不是 node）。现在走 `node <node目录>/node_modules/npm/bin/npm-cli.js root -g`。
4. **`sandbox:true` 的 preload 不能 require 共享 chunk**：多个 preload 共用模块会被 Rollup 拆出 `out/preload/chunks/*.js`，sandbox 下 require 失败且静默——`contextBridge` 不执行（页面拿不到 `window.piWebTabs`）。所以 preload 里内联通道常量，只用 `import type`。

---

## 6. 契约冒烟脚本（`scripts/smoke.mjs`，防上游改动）

不启动 GUI，只用 Node 验证四件事：

1. `pi-web version` 可执行 → 拿到版本号；
2. spawn `--no-open -p <随机空闲端口>` 后 60s 内 `/` 返回 200；
3. `/?session=<随便一个 id>` 返回 200（说明 query 路由仍存在）；
4. `taskkill /T /F` 后端口不再响应，`~/.pi/agent/pi-web-run` 无残留记录。

> 每次 `pi-web` 升级后跑一次；CI/本地均可，5 秒级反馈。

---

## 7. 排期与优先级

| 阶段 | 内容 | 优先级 |
| --- | --- | --- |
| M0 | 服务托管 + 单窗口 | ✅ 已完成 |
| M1 | 页签（含固定/置顶） | ✅ 已完成 |
| M2 | 启动页 / 复用 / 菜单 / 托盘 / 局域网 / 开机自启 | P0（下一步） |
| M2 | 启动页 / 复用 / 菜单 / 托盘 / 局域网 / 开机自启 | P1 |
| M3 | 打包（绿色版为主） | P1（否则双击不到） |
| M4 | 标题栏 / 分组 / 右键菜单接管 / 多窗口 / 二维码 | P2 |

预估总工作量：**3–3.5 个工作日**（M0–M3，含固定页签），M4 按需追加。

---

## 8. 已确认决策

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 关窗口行为 | **最小化到托盘**（`closeBehavior: "tray"`），托盘「退出」才停服务 |
| 2 | 手机 / 局域网 | **要**。沿用上游 `--hostname 0.0.0.0` + `PI_WEB_PASSWORD` 机制，做成设置开关 + 局域网地址列表，开启即强制密码 |
| 3 | 开机自启 | 设置里可勾选，**默认关闭** |
| 4 | 分发形态 | **只用绿色版**（自用）；安装版配置同步就位，需要时一条命令即出（见 §9） |
| 5 | 固定页签 / 置顶 | **要**，已从 M4 提前到 **M1**（固定后靠最左、仅显图标、不可误关） |
| 6 | 端口 | 30141 优先，被占用自动回退 30142–30150 |
| 7 | 二维码 | **不做**，列入 M4 可选（需要时再加） |
| 8 | 同一会话多页签 | 不特处理，保持 pi-web 原生行为，M4 实测后再定 |

---

## 9. 绿色版为主，安装版「以后想要就有」（零额外成本）

| | 绿色版（便携，**默认产出**） | 安装版（备用，配置已写好） |
| --- | --- | --- |
| 产物 | `pi-web-desktop-0.1.0-portable.exe`（自解压单文件） | `pi-web-desktop-Setup-0.1.0.exe` |
| 安装 | 免安装，双击即跑 | 选目录安装，建桌面/开始菜单快捷方式，可从「设置→应用」卸载 |
| 数据（设置/页签/日志） | exe 同级 `./data/`（`PORTABLE_EXECUTABLE_DIR`）→ 拷走就带着配置 | `%APPDATA%\Pi Web Desktop` |
| 开机自启 | 可用（路径固定的话）；路径常变时设置项置灰 | 天然支持 |
| 命令 | `npm run dist` | `npm run dist -- --win nsis` |

关键的「0 成本」含义：
1. **同一份代码**，靠运行时判断 `PORTABLE_EXECUTABLE_DIR` 决定数据目录，不需要两套构建；
2. `electron-builder.yml` 里 `nsis` 与 `portable` **两个 target 同时写好**，平时只跑 `portable`，想装就加一个参数；
3. 图标与 appId 在开发模式 / 快捷方式 / 打包配置里保持一致，避免「只有打包版图标才对」。

唯一要注意的差别：两个形态的**数据目录不同**（`./data` vs `%APPDATA%`）；以后从绿色版转安装版时，把 `./data` 里的 `settings.json` / `tabs.json` 拷到 `%APPDATA%\Pi Web Desktop\` 即可（或加一个首次启动迁移提示，M4 可做）。

> 两者都仍需要本机已装 **Node ≥ 22.19 + `@agegr/pi-web`**（上游依赖不进包，才能保证 `pi-web update` 后即时生效）。若以后想要「装了就能用、不带 Node」，可加 M5：内置 Node + 自带一份 pi-web，与「可独立升级」有冲突，需单独权衡。

---

## 10. 待确认（不影响开工）

1. 窗口「置顶」（Always On Top，边看边干别的）要不要做成菜单开关？成本极低（一行 `setAlwaysOnTop`），已预留配置项 `alwaysOnTop`。
2. 固定页签在重启后是否需要自动“激活并加载”（而非惰性加载）？默认：固定页签启动即加载（保证在线）。
3. 是否需要在页签栏右侧显示当前服务的运行状态/端口（小圆点）？默认：做，出问题时一眼看得出。
