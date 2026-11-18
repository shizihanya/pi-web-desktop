# 自测清单（打包前反复使用）

用 `npm run dev`（开发热更新）或 `npm run app`（跑构建产物，更接近打包后行为）启动。自测中发现的问题按文末格式记下来，攒一批一起改。

## 数据与日志位置

```
%APPDATA%\Pi Web Desktop\
├── settings.json     设置（端口、关闭行为、局域网开关…）
├── tabs.json         页签（路径 / 标题 / 是否固定 / 激活索引 / 分屏窗格布局）
├── secure.bin        局域网访问密码（系统凭据加密，不是明文）
├── server.log        服务日志（超过 2MB 自动轮转为 server.1.log）
└── shot-*.png        调试截图（只有设了对应环境变量才有）
```

## 主流程清单

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 启动 | 先出 splash（进度 + 日志），随后主窗口 + 页签栏，无系统浏览器弹出 |
| 2 | 点右上 `+` 或 `Ctrl+T` | 新页签打开 pi-web 根页 |
| 3 | pi-web 侧栏会话右键 →「在新标签页打开」 | 变成 App 内新页签（不是外部浏览器） |
| 4 | 页签右键 →「固定页签」 | 收到最左、只显图标；`Ctrl+W` 关不掉 |
| 4b | 在 pi-web 设置里切 `mist` / `pine` / `sand` / `contrast-dark` 等不同主题 | 页签栏、右上角窗口控件的底色/图标色都跟着变，不再是只有黑白（≤ 1 秒）；`server.log` 里 `[theme]` 能看到主题名和配色 |
| 4c | 看任务栏 / Alt+Tab 图标 | 是彩色 π 图标（而不是 Electron 的原子图标）；不对就跑 `npm run shortcut` 重建开始菜单 AUMID 注册点，必要时取消任务栏旧固定项 |
| 4d | 深色主题（如 `pine`/`zenburn`）下退出再冷启动 | 主窗口从第一帧就是深色，**不应先闪一下浅色**；`server.log` 里 `[theme]` 只有一条「窗口控件配色」、没有「切换为 …」（说明用的是 `theme.json` 缓存）。删掉 `%APPDATA%\Pi Web Desktop\theme.json` 后首次启动会看到一次切换并重建缓存，属正常 |
| 4e | 把 `theme.json` 改成非法 JSON / 改坏 `version` 再启动 | 不报错、不白屏，退回系统明暗并在探测成功后自动重建 `theme.json` |
| 5 | 拖动页签 | 顺序变化，不能跨过固定区 |
| 6 | 关闭窗口（×） | 窗口消失，**托盘图标仍在**，服务继续（手机仍可访问） |
| 7 | 托盘图标单击 / 双击 | 窗口重新出现 |
| 8 | 托盘 → `退出并停止服务` | 应用退出，`pi-web status` 里看不到它拉起的实例 |
| 9 | 重启应用 | 页签、固定状态、激活页签全部恢复 |
| 10 | 设置 → 端口改 30150 → 保存并重启服务 | 窗口重建，页签换到新端口仍能打开 |
| 11 | 设置 → 勾选局域网 → 生成密码 → 保存并重启 | 服务绑定 `0.0.0.0`，设置页列出局域网地址 |
| 12 | 手机打开设置页给的地址 | 出现登录页，输入密码后进入 pi-web |
| 13 | 设置 → 取消局域网 → 保存并重启 | 服务回到 `127.0.0.1`，手机不可访问 |
| 14 | 设置 → 开机自启（可选） | 注册表 Run 项出现/消失（默认关闭，绿色版置灰） |
| 15 | 菜单 → 服务 → 状态 | 弹出状态框：地址、版本、数据目录、局域网地址 |
| 16 | 菜单 → 服务 → 检查 pi-web 更新 | 显示当前版本与 `update --check` 输出 |
| 17 | 跑一个对话，任务完成前把窗口最小化，或让窗口仍可见但切到别的程序 | 两种情况都应在任务完成时弹出 Windows 系统通知，标题带页签名（如 `sgs_web_week — 任务完成`；会话名与页签名相同时只显一次），点击回到该会话；开始菜单不会长期残留 `Electron.lnk`（最多 500ms） |
| 18 | 后台页签里跑一个对话（切到别的页签看别的） | 该页签名后出现**转圈**（样式同 pi-web 侧栏的 running）；回答结束后变成**蓝色提示点**；切到该页签后提示点消失 |
| 19 | 对话跑到「等你确认 / 回答提问」时（后台页签） | 页签名后出现**橙色提示点**（比蓝点更急，样式同侧栏 awaiting）；处理后恢复转圈或变蓝点 |
| 20 | 固定页签里有活动对话 | 转圈/提示点显示在图标右上角的小徽标，不挤占标题区 |
| 21 | `PI_WEB_DESKTOP_SELFTEST_STATUS=1` 启动（不跑真对话） | 第一个页签每 2.2s 依次演示：转圈 → 蓝点 → 橙点 → 无，样式与上面一致 |
| 22 | 先跑过几个对话（pi-web 侧栏里留着旧会话的未读点），再在某一个页签里完成新对话 | **只有那个页签**出现提示点；其它页签名后、以及**所有页签的图标**都不能同时出现圆点。开 `PI_WEB_DESKTOP_DEBUG_STATUS=1` 可在 `server.log` 看到 `[status] 页签名: idle → running → unread`，日志里的 session 应与该页签 URL 的 `?session=` 一致 |
| 23 | 不打开分屏，看页签栏 | **和以前完全一样**：只有一条页签栏，页签上没有 `1` 徽标、没有第二行、没有边框；拖动仍然只是页签排序 |
| 24 | `Ctrl+Alt+2` / 点分屏按钮选「左右双栏」 | 变成**左右两个展示区域，各带一条页签条**，没有上下两层；两个 pi-web 页面并排、都能打字；当前窗格的 active 页签是强调色下划线，非焦点是淡线；右上工具区不与窗口控件重叠 |
| 25 | 拖动一个页签到右侧区域 / 拖到窗口最右边缘 | 前者把页签移到右组；若左组只剩这一个页签，会与右组当前页签**互换**，保证仍是两个区域；后者直接**新建一个窗格**并放入。拖动时能看到投放区，松手后内容立刻恢复 |
| 26 | 每条页签条的 `+`、右键空白页签条、`Ctrl+Shift+\` | `+` 只在该窗格开新页签；右键可「把哪个页签移动到这里」/ 关窗格 / 退出分屏；关窗格不关页签，关到 1 组自动回单栏 |
| 27 | `Ctrl+\` 连按到 4 格 / `Ctrl+Alt+3` / `Ctrl+Alt+4` | 三栏、四宫格布局正确，每条页签条都在自己区域的顶部、任意两格内容不重叠；`Ctrl+Alt+1` 回单栏，所有页签都还在 |
| 28 | `Ctrl+Alt+←/→`，然后 `Ctrl+W` / `Ctrl+R` / `F12` | 焦点只在窗格间切换；这些键只作用于当前窗格 |
| 29 | 分屏状态下重启应用 | `tabs.json` 里有 `split.groups`，重启后窗格数、布局、每组的页签和各自显示的页签都恢复 |
| 30 | 分屏里让某个可见页签跑任务到完成 | 可见页签都算「已查看」，**不再亮未读点**；未显示的后台页签仍正常提示 |

## 异常路径清单

| # | 操作 | 预期 |
| --- | --- | --- |
| A | 用任务管理器杀掉 node（pi-web）进程 | 约 1 秒内自动重拉并恢复（日志 `[health] 已自动恢复`），页签自动刷新 |
| A2 | 先复用你终端里的实例，然后把终端关掉 | 约 10–15 秒内自动**接管**（自己拉起一个，同端口），页签自动刷新 |
| A3 | 连续杀掉服务 4 次 | 达到上限后停止自动重启并弹通知，可菜单「服务 → 重启服务」手动恢复 |
| B | 先手动在终端跑 `pi-web`，再开应用 | 直接复用（状态显示「复用」，黄色圆点），退出应用不会杀掉它 |
| C | 端口 30141 被占用（非 pi-web） | 自动退到 30142，日志里有说明 |
| D | 把 `%APPDATA%\Pi Web Desktop\settings.json` 改成非法 JSON | 用默认值启动，不崩 |
| E | 开启局域网但清空密码后保存 | 拒绝保存并提示「请先设置访问密码」 |
| F | 断网 / 拔网线 | 应用照常本机可用，局域网列表为空 |
| G | 用任务管理器杀掉某个 pi-web 页签的渲染进程 | 页签**不消失**、不自动重载、服务不停；标题变成「页面崩溃（原因）」，页签栏出现「↻」，右键菜单为「重新加载崩溃页面」；点 ↻ 后恢复原会话，转圈/橙点等状态提示重新工作 |
| H | 崩溃后先把 pi-web 服务停掉，再点 ↻ | 不盲目重载，回到 Crashed 并提示「服务未就绪」；服务恢复后可再次点击 |
| I | 切 `mist` / `pine` 等主题，看 `server.log` 的 `[theme]` | 主题立即跟随（事件驱动），不再需要等 1s 轮询；5s 兜底轮询只在 observer 失效时起作用 |
| J | 设置 → 检查 pi-web 更新，故意让 npm registry 不可用 | 报「无法读取最新版本」，服务仍在跑（没被停掉），终端里的 pi-web 仍可用 |
| K | 更新成功但新版本启动失败 / npm 安装中途失败 | 设置页明确说明是否已把全局包恢复并验证到旧版本；未验证通过时给出手动 `npm i -g @agegr/pi-web@<旧版本>` 命令，不谎称「已回滚」 |

## 图标专项排查

任务栏不是 π 时：

1. 看开始菜单 `Programs` 里有没有 `Electron.lnk`（带 `com.local.piweb.desktop`、图标为空）。有就说明弹过 Windows toast 通知，Electron 自动创建了它。
2. `npm run shortcut`：重建项目 / 桌面 / 开始菜单快捷方式（target=官方 `electron.exe`、图标=`build/icon.ico`、写入 `System.AppUserModel.ID` 与固定 `ToastActivatorCLSID`），并清理所有同 AUMID 的注册点。
3. 看 `server.log` 的 `[icon] 窗口图标：` 是否为 `build/icon.ico`，以及有没有 `[icon] 已清理通知自动生成的快捷方式`（watch 命中）。
4. 任务栏上若还固定着旧图标：取消固定后重新拖上去（必要时重启资源管理器）。

原理：主进程声明 AUMID `com.local.piweb.desktop` 与固定 `ToastActivatorCLSID`，Windows 任务栏按 AUMID 找开始菜单里带同 ID 的快捷方式取图标，会覆盖窗口 icon；托盘图标由 `Tray` 直接创建，不经过 AUMID。主进程服务失败提示走 `Tray.displayBalloon()`；pi-web 页面里的任务完成通知走 `window.Notification`（Windows toast），这是功能需要，关不掉。每次 toast 都会让 Electron 生成 `Electron.lnk`，主进程通过 `watchAutoShortcuts()` 在 500ms 内清掉（启动清一次 + 10 秒兜底轮询），所以任务栏图标最多闪一下。

## 调试用环境变量

```powershell
$env:PI_WEB_DESKTOP_AUTOQUIT_MS = "20000"      # 20s 后优雅退出（自动化用）
$env:PI_WEB_DESKTOP_SELFTEST = "1"             # 页签自测：window.open 接管 / 固定 / 关闭
$env:PI_WEB_DESKTOP_SELFTEST_SPLIT = "grid-2x2"  # 分屏自测：single / columns-2 / rows-2 / columns-3 / grid-2x2
$env:PI_WEB_DESKTOP_SPLIT_SHOT = "D:\tmp\split.png"  # 配合上面，拍窗口截图
$env:PI_WEB_DESKTOP_SELFTEST_TRAY = "1"        # 关窗口→托盘 自测
$env:PI_WEB_DESKTOP_SELFTEST_REMOTE = "1"      # 局域网+密码 自测（结束后自动恢复）
$env:PI_WEB_DESKTOP_SCREENSHOT = "D:\tmp\tab.png"        # 激活页签截图
$env:PI_WEB_DESKTOP_TABBAR_SHOT = "D:\tmp\bar.png"       # 页签栏截图
$env:PI_WEB_DESKTOP_SPLASH_SHOT = "D:\tmp\splash.png"    # splash 截图
$env:PI_WEB_DESKTOP_SETTINGS_SHOT = "D:\tmp\set.png"     # 设置页截图（配 OPEN_SETTINGS）
$env:PI_WEB_DESKTOP_OPEN_SETTINGS = "1"        # 启动后自动打开设置页
$env:PI_WEB_DESKTOP_HOLD_SPLASH = "1"          # 停在 splash 不打开主窗口
$env:PI_WEB_DESKTOP_DEBUG_THEME = "1"          # 打印主题探测日志 + WCO 布局/配色
$env:PI_WEB_DESKTOP_DEBUG_NOTIFY = "1"         # 打印「已注入通知回落 + 窗口焦点同步补丁」及焦点同步日志
$env:PI_WEB_DESKTOP_SELFTEST_STATUS = "1"     # 页签状态演示：第一个页签每 2.2s 依次显示 转圈/蓝点/橙点/无
$env:PI_WEB_DESKTOP_DEBUG_STATUS = "1"        # 打印页签状态变化日志（[status] 标题: old → new）
$env:PI_WEB_DESKTOP_DEBUG_COMPAT = "1"         # 打印全部功能级兼容性结论（[compat] 功能: 级别 — 原因）
$env:PI_WEB_DESKTOP_DISABLE_STATUS_PROBE = "1" # 单独关闭页签状态探测（原生 pi-web 不受影响）
$env:PI_WEB_DESKTOP_DISABLE_THEME_PROBE = "1"  # 单独关闭主题跟随
$env:PI_WEB_DESKTOP_DISABLE_NOTIFICATION_PATCH = "1" # 单独关闭 Windows 通知增强
$env:PI_WEB_DESKTOP_SELFTEST_THEME = "1"       # 自动切主题，验证页签栏跟随
$env:PI_WEB_DESKTOP_SELFTEST_THEME_NAME = "mist" # 配合上面，可指定 pine/sand/zenburn…
$env:PI_WEB_DESKTOP_SHOT_DELAY_MS = "11000"    # 配合截图，延迟到指定毫秒再拍
$env:PI_WEB_DESKTOP_NATIVE_TITLEBAR = "1"      # 退回系统原生标题栏（不自绘）
```

## 升级 pi-web 后

先跑 `npm run check:all`（不启动 GUI 的静态/纯逻辑回归 + 契约冒烟），
再按 [上游兼容性清单](development/pi-web-compatibility.md) 的 7 条人工回归清单过一遍。
重点：4 个页签同时打开时 `/api/agent/running` 每轮只应有 **1 个**请求；
关掉作为状态源的页签后状态提示仍能更新；服务重启后状态能重新初始化；
更新失败时确认全局包版本确实恢复到了更新前的版本（不能只看服务能启动）。

## 发现问题的记录方式

1. 复现步骤写清（第几次启动、有没有开局域网、端口多少）。
2. 附 `%APPDATA%\Pi Web Desktop\server.log` 尾部（里面有 resolve / spawn / reuse / ready / stop 全过程）。
3. 涉及页签的，附 `tabs.json` 内容。
