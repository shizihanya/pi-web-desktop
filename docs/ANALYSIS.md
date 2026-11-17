# pi-web-desktop 方案分析

> 目标：把 `pi-web` 从「开终端 → 敲命令 → 弹浏览器」变成「双击桌面图标 → 服务自动就绪 → 应用内多页签不同对话」。
> 硬约束：**不侵入 pi-web 源码/构建产物**，`npm i -g @agegr/pi-web@latest` 升级后上游能力必须完整可用。

分析对象：本机 `@agegr/pi-web@0.15.0`（`C:\Users\weijia\AppData\Roaming\nvm\v22.22.1\node_modules\@agegr\pi-web`）。

---

## 1. 本机 pi-web 现状（实测）

| 项目 | 实际情况 |
| --- | --- |
| 安装方式 | nvm 全局 npm 安装，版本 `0.15.0` |
| 可执行入口 | `%APPDATA%\nvm\nodejs\pi-web.cmd` → `node node_modules\@agegr\pi-web\bin\pi-web.js` |
| 服务器本体 | Next.js 16.4.4 生产构建，`.next/` 随包发布，启动即 `next start` |
| 默认地址 | `http://127.0.0.1:30141`（当前进程实际监听 `0.0.0.0:30141`） |
| 运行时依赖 | 需要系统 Node ≥ 22.19（含原生模块 `node-pty`，**必须用系统 Node 跑，不能用 Electron 内置 Node**） |
| 进程模型 | 启动器进程 `pi-web.js` → 子进程 `next-server`；Windows 上有两跳进程树 |
| 当前使用痛点 | 每次要开终端跑 `pi-web`，浏览器里手动开新窗口/新标签来并行对话；Chrome「保存到桌面」只是 PWA 快捷方式，没有页签栏，体验割裂 |

---

## 2. 上游已提供的「集成契约」（这决定了壳子可以零侵入）

pi-web 本身是给 Electron 封装预留了接口的（README 明确写了 "Electron wrappers and other downstream integrations"）。可用的稳定契约：

### 2.1 启动与生命周期（CLI 层）

```
pi-web [--port N] [--hostname H] [--no-open]
pi-web status | stop [--port N] | open [--port N] | version | update [--check]
```

- `--no-open` / `PI_WEB_NO_OPEN=1`：**壳子自己管窗口，必须传这个**，否则会额外弹出系统浏览器。
- 运行记录：`~/.pi/agent/pi-web-run/<launcher-pid>.json`，字段 `{pid, nextPid, port, hostname, url, version, startedAt}`。
  → 壳子可以只读这些记录 + 探测 URL，判断「已经有一个 pi-web 在跑」，避免端口打架。
- `pi-web version` 可随时拿到真实安装版本；`pi-web update` 升级逻辑仍在 CLI 里，壳子不需要重做。

### 2.2 页面路由 = 页签身份（这是最关键的一条）

pi-web 是单页应用，**所有对话状态都落在 URL query 上**，并随操作实时 `router.replace` 同步：

| URL | 含义 |
| --- | --- |
| `/` | 上次打开的会话 / 空会话 |
| `/?session=<id>` | 打开指定会话 |
| `/?cwd=<path>` | 在该工作目录下开新会话 |
| `?sidebar=collapsed` | 侧栏折叠状态 |

源码实证（压缩产物 `static/chunks/app/page-*.js`）：
`function u(e){return "?session="+encodeURIComponent(e)}`、`useSearchParams().get("session")`、`$.replace("?session=...")`。

**推论：**
1. 「一个页签」= 一个 `WebContentsView` + 一个 URL，壳子不需要理解 pi-web 内部状态机。
2. 页签可以持久化（存 URL 列表），下次启动原样恢复。
3. 「复制对话链接」「在新页签打开某对话」天然可用。

### 2.3 页面自己会发起的 `window.open`（壳子必须接管）

| 触发点 | 目标 | 壳子的正确处理 |
| --- | --- | --- |
| 会话右键/菜单「Open in new tab」 | `?session=<id>`（同源） | 新建 App 内页签 |
| 项目菜单「Open in new tab」 | `?cwd=<path>`（同源） | 新建 App 内页签 |
| 导出会话 | `/api/sessions/<id>/export?inline=1`（同源） | 新页签或系统浏览器（可配置，默认新页签） |
| 模型 OAuth 登录 | `https://...` 第三方 | `shell.openExternal` |

### 2.4 其它可选集成点（不是必需，留作后续增强）

- `window` 上的可取消事件 `pi-web:session-row-contextmenu`：上游专门给 Electron 壳提供的会话行右键菜单接管点（当前版本已存在于 bundle）。
- `sessionStorage` 键 `pi-web:tab-open-session`（`{kind:"session"|"new", ...}`）：真正的浏览器新标签继承用；我们走 URL 参数即可，不依赖它。
- Service Worker + `web-push`：桌面壳里 SW 可用（`127.0.0.1` 是安全上下文），但 Electron 不支持 Push API，推送订阅会失败——桌面场景不需要，文档标注为已知限制。
- 页标题 `"<会话名> - Pi Web"` 由页面自己维护 → 页签名免费拿到。
- `localStorage` 键全部以 `pi-web:` 前缀（`pi-web:last-open-by-workspace`、`pi-web:unread-session-ids`、侧栏状态…）：同源多视图共享，页签之间侧栏/未读状态一致，符合直觉。

### 2.5 结论：壳子需要碰的东西只有三样

1. **spawn 一个外部进程**（`node …/bin/pi-web.js --no-open --port N -H 127.0.0.1`）；
2. **一个 Chromium 视图**加载 `http://127.0.0.1:N/?…`；
3. **拦截 `window.open` / 外链**，做自己的页签栏。

不读 pi-web 内部文件、不 patch `.next/`、不 fork 代码 → 上游升级零成本。

---

## 3. 技术选型

### 3.1 候选对比

| 方案 | 页签能力 | 体积 | 依赖 | 与 pi-web 契合度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Electron + `WebContentsView`** | 一个窗口内 N 个独立视图，可任意切页签、劫持 `window.open`、独立 DevTools/缩放/查找 | ~200MB（安装包 ~90MB） | Node/npm | 最高（上游就是按 Electron 封装设计的） | ✅ **推荐** |
| Tauri 2 + WebView2 | 多 webview 仍是 unstable，官方推荐「一个 webview 一个窗口」，做页签栏要绕很多 | ~10MB | Rust 工具链 | 中 | 备用 |
| WPF/WinForms + WebView2 | `TabControl` + 每页签一个 WebView2，可行且体积小 | ~60MB + WebView2 运行时 | .NET | 中（要自己写 IPC、下载、查找等） | 备用（仅 Windows） |
| Chrome/Edge `--app` + 快捷方式 | 无页签栏（现状） | 0 | 浏览器 | 低 | ❌ 已排除 |
| 用 PWA 装成应用 | 无页签栏，且和浏览器实例共享 | 0 | 浏览器 | 低 | ❌ 已排除 |

### 3.2 为什么选 Electron

1. **页签是硬需求**：`BrowserWindow.contentView` + 多个 `WebContentsView` 是 Electron 30+ 的官方模型，页签栏用普通 HTML 画，切换只改 bounds/可见性。
2. **上游明确支持**：README 里 Electron wrapper 段落 + `pi-web:session-row-contextmenu` 事件，说明这是被认可的集成方式。
3. **少踩坑**：pi-web 前端用 xterm.js、Service Worker、`Notification`、剪贴板图片粘贴、文件上传/下载、`window.open`——大部分在 Chromium 内核里与 Chrome 一致；但 Windows 下 `ServiceWorkerRegistration.showNotification()` 实测不会出 toast，且 WebContentsView 失焦后 `document.hasFocus()` 仍为 true，桌面壳注入补丁回落到 `window.Notification`、同步窗口焦点并把页签名拼进通知标题（见第 5 节）；WebView2 需要逐个验证。
4. **工程效率**：壳子本身用 TypeScript + Node 写，和 pi-web 同一技术栈，出问题好排查。

代价：安装体积大、内存比 WebView2 高（每页签一个进程）。对一个本地 AI 编程助手来说可接受。

---

## 4. 架构设计

```
pi-web-desktop.exe (Electron 主进程)
├── ServerManager       解析 pi-web 安装 → 复用或 spawn → 等 Ready → 退出时收尸
│   ├── resolver: settings.piWebCommand → npm root -g → where pi-web 推导 → 用户手填
│   ├── process:  node.exe <...>/bin/pi-web.js --no-open -p 30141 -H 127.0.0.1
│   └── probe:    GET / 轮询 + 读 ~/.pi/agent/pi-web-run/*.json 交叉验证
├── TabManager          tabs[]: {id, view: WebContentsView, url, title, favicon}
│   ├── 创建/关闭/切换/拖拽排序/恢复
│   └── setWindowOpenHandler: 同源 → 新页签；外链 → openExternal
└── 窗口 UI (window.webContents)
    ├── 页签栏 (HTML/CSS)：页签 + 新建 + 标题/图标/运行指示
    ├── 下方区域：贴当前激活的 WebContentsView
    ├── 状态浮层：服务启动日志 / 启动失败重试 / 版本升级提示
    └── 菜单、托盘、快捷键
```

### 4.1 进程与端口策略

1. **探测**：先 `GET http://127.0.0.1:<port>/`（1.5s 超时）。**任何 HTTP 状态码都算存活**（开启密码后 `/` 会 302 到 `/login`，API 返回 401——不要只认 200，否则会把正在运行的服务误判为空闲）；再读运行记录交叉验证是不是 pi-web。命中 → **复用**，标记 `managed:false`（退出时不杀，避免误杀用户终端里起的服务）。
2. **启动**：无响应 → 用系统 `node` spawn，`windowsHide: true`、`stdio: pipe` 收日志，父进程退出/崩溃时确保子进程树被清理。
3. **端口占用**：默认 30141；若被别的程序占（探测有响应但不是 pi-web），自动退到 30142…30150 或用户在设置里指定。
4. **收尸**：Windows 用 `taskkill /PID <pid> /T /F` 杀整棵树（pi-web 启动器 + next-server 两跳），并对照 `pi-web-run` 记录确认清理干净。
5. **单实例**：`app.requestSingleInstanceLock()`，第二次启动只是把已有窗口提到前台。

### 4.2 零侵入的边界（明确写在代码里，防手滑）

- ❌ 不修改 `node_modules/@agegr/pi-web/**` 任何文件
- ❌ 不依赖 `.next/` 内部文件名、chunk 内容（只依赖 URL 契约）
- ❌ 不内置/锁死 pi-web 版本（升级后重启即生效）
- ✅ 只依赖：CLI 参数、`--no-open`、HTTP 地址、URL query 语义、运行记录 JSON
- ✅ 可选：`window` 上的 `pi-web:*` 浏览器事件（上游文档化的扩展点）

### 4.3 安全配置

- 页签视图：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`partition:"persist:piweb"`（持久化 cookie，`PI_WEB_PASSWORD` 登录态不会每次丢）。
- 只有壳子自己的页签栏 UI 用 preload（`contextBridge` 暴露极小的 `piWebShell` API）。
- 默认绑 `127.0.0.1`；局域网访问是显式开关，**开启即强制要求密码**（见 4.4）。
- 禁止任意导航：非本机 origin 一律 `openExternal`。

### 4.4 远程访问（局域网 / 手机）设计

沿用上游原有设计，不新增协议，只把「要记三条命令」变成「一个开关」：

**上游已有的机制**

| 能力 | 上游实现 |
| --- | --- |
| 绑定网卡 | `--hostname 0.0.0.0` |
| 身份验证 | `PI_WEB_PASSWORD` → 浏览器密码登录页 `/login`，API 支持 Basic Auth（用户名 `pi`） |
| 反代域名白名单 | `PI_WEB_ALLOWED_HOSTS`（按 IP 直连不需要） |
| 手机端 | 自带 PWA manifest + Service Worker，手机浏览器可「添加到主屏幕」 |
| 推送 | `web-push`（服务端已有；手机用浏览器访问时可用） |

**壳子要做的事**

1. 设置项 `remoteAccess: { enabled, password, hostname: "0.0.0.0" }`，默认关闭。
2. 开启时：
   - 强制密码（长度 ≥ 12，生成器一键生成随机密码，可复制）；
   - spawn 参数改为 `-H 0.0.0.0`，并通过 **环境变量** 传 `PI_WEB_PASSWORD`（不写进命令行，避免出现在进程列表里）；
   - 密码用 Electron `credentialStore`（Windows Data Protection API）加密后存 `userData/secure.bin`，**不落明文**、不写日志；
   - 如果 `credentialStore.isEncryptionAvailable()` 为 false，退化为「每次启动弹窗输入 / 仅本次会话有效」。
3. 显示可访问地址：枚举本机 IPv4（排除回环/虚拟网卡），列出 `http://192.168.x.x:30141`，每个带复制按钮；
4. 局域网地址列表：枚举本机 IPv4，逐个列出 `http://192.168.x.x:30141` 并提供一键复制（二维码暂不做，后续需要时再加：本地生成即可，且可带 `?cwd=` 直达项目）；
5. 安全提示（对齐上游警告文案）：HTTP 明文传输，密码只在信任的局域网使用；跨网/公网请用 Tailscale/WireGuard 或 HTTPS 反代；
6. Windows 防火墙：首次绑定 `0.0.0.0` 时给出提示与命令（`netsh advfirewall firewall add rule ...`，需管理员）；壳子不静默提权；
7. 关闭开关 → 恢复 `127.0.0.1` 并重启服务；
8. 与「复用已有服务」的交互：若探测到的实例绑的是 `0.0.0.0` 而本地设置为关闭，则提示「检测到局域网已开放，是否关闭远端实例或改本地设置」，不擅自改他人进程。

**实现落点**：`src/main/server/network.ts`（网卡枚举 + URL 生成）、`src/main/security/secret-store.ts`（系统凭据加密封装）、设置面板的「远程访问」分区。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 上游改 URL 契约（`?session=`） | 页签恢复失效 | 只把 URL 当前提，不当核心依赖；失败时回退到 `/`；锁定检测点见 `npm test` 冒烟脚本 |
| 全局安装路径千奇百怪（nvm/volta/pnpm/bun） | 找不到 pi-web | 解析链：设置项 → `npm root -g` → `where pi-web` 推导 → `PI_WEB_CMD` 环境变量 → 用户手填；失败时弹出可操作的错误面板（附「复制命令」按钮） |
| Windows 进程树残留 | 端口被占，下次启动失败 | `taskkill /T /F` + 启动前清理僵尸记录 + 端口探测兜底 |
| 用 Electron 内置 Node 跑 pi-web | `node-pty` ABI 不匹配直接崩 | 强制用系统 `node`，启动前检查 `node -v ≥ 22.19` 并给出明确提示 |
| Electron 二进制下载慢（tsinghua/taobao 源） | 首次安装失败 | 设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 写入 `.npmrc` |
| 多页签内存 | 每页签一个 Chromium 渲染进程 | 后台页签 `setBackgroundThrottling(true)`；可选「休眠页签」策略（M4） |
| pi-web 升级后页面结构变化 | 页签栏功能（标题/图标）可能变差 | 页签只依赖 `page-title-updated`/`page-favicon-updated` 标准事件，不解析 DOM |
| pi-web 的 ServiceWorker 通知在 Electron 里不落 toast / 失焦判定不准 / 多项目分不清是谁完成了 | 任务完成没有系统通知，或通知看不出是哪个项目 | 页面加载后注入补丁让 `showNotification` reject，回落 `window.Notification`，把 BrowserWindow 焦点同步给 `document.hasFocus()`，并包装 `Notification` 构造器把页签名拼进通知标题；Push API 仍不可用，桌面端靠页面事件流通知，服务失败用托盘气泡兜底 |
| 开启局域网访问后 Windows 防火墙拦截 | 手机连不上 | 设置页给出 netsh 命令 + 检测失败时提示；不静默提权 |
| 密码以环境变量传给子进程 | 同机其他进程理论上可读（Windows 上需相应权限） | 仅按需开启远程访问；口令经系统凭据加密后存入 secure.bin；文案明确「局域网专用，公网请走 VPN/HTTPS」 |
| 托盘常驻导致「以为已退出」 | 服务仍在跑 | 托盘图标 tooltip 显示状态；托盘菜单显式「退出并停止服务」；托盘首次最小化给气泡提示 |

---

## 6. 与「现有 Chrome 方案」的差异（用户视角收益）

| 场景 | 现在 | pi-web-desktop |
| --- | --- | --- |
| 启动 | 开终端 → `pi-web` → 浏览器自动开 | 双击图标（或开机自启），服务就绪后自动出窗口 |
| 多对话 | 浏览器里开多标签，手动复制 URL，容易和别的网页混在一起 | 应用内页签栏，标题即会话名，重启后自动恢复 |
| 关窗口 | 服务还在后台跑，得回终端 Ctrl+C | 默认最小化到托盘，托盘菜单「退出」才停服务 |
| 手机/局域网用 | 每次手敲 `PI_WEB_PASSWORD=... pi-web -H 0.0.0.0` | 设置里一个开关 + 自动生成密码 + 局域网地址列表（复制到手机打开） |
| 升级 | `pi-web stop` + `pi-web update` | 菜单「检查更新 / 重启服务」，一条路径 |
| 外部链接/登录 | 正常 | 自动交给系统浏览器，不污染 App 窗口 |
