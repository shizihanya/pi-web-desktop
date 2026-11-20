# Plan 02 · VS Code 式分屏系统升级 — 最终交付

> 范围：只改造 Electron 桌面端的窗格布局、尺寸调整与拖拽交互，**不修改 pi-web 上游**。
> 三个里程碑均独立提交，全部 `npm run check` / `npm run build` 通过。

| 里程碑 | 提交 | 内容 |
| --- | --- | --- |
| M1 | `19ae442` | 平面 groups → 嵌套 Split Tree；递归布局；tabs.json v2 与旧配置迁移 |
| M2 | `3c66c4a` | 每个 SplitNode 一条分隔条，Pointer Events 拖动独立 ratio |
| M3 | 最新提交（`git log -1`） | 五方向投放、落位预览、上限 / 取消 / 跨窗格移动；本交付文档 |

---

## 1. 新旧布局模型对比

| | 旧（M0/M1.5） | 新 |
| --- | --- | --- |
| 结构 | `groups: PaneGroup[]` 平面数组 + 全局 `splitLayout: columns/rows/grid` | 二叉树 `LayoutNode = SplitNode \| PaneNode`；方向 / ratio 在每个 SplitNode 上 |
| 窗格标识 | 数组下标 | 稳定 UUID（`pane-…` / `split-…`），持久化后重启不变 |
| 表达能力 | 只能整体等分列 / 行 / 2×2 宫格 | 任意方向嵌套（左一右二、左二右一、三层混排） |
| 几何 | `computePaneRects(count, layout, w, h)` 平面公式 | `computeLayoutRects(root, bounds)` 递归，扣 gap、钳最小尺寸、输出 panes + sashes + nodes |
| 主 / 渲一致性 | 两边各自调用同一函数各算一次 | 主进程 `syncLayout()` 算一次并缓存；`layout()` 与 `snapshot()` 共用同一份结果随 IPC 下发 |
| 尺寸调整 | 不支持 | 每个 SplitNode 独立 `ratio`，可拖分隔条、重启恢复、窗口缩放按比例重算 |
| 拖拽 | 整块投放 + 窗口最左 / 最右边缘 | 每窗格五方向（center / left / right / top / bottom）+ 假想布局预览 |
| 上限 | `MAX_PANES = 4` 散落在多处 | 树操作、`normalizeLayout()`、TabManager、`applyTabDrop()` 共同保证 |

---

## 2. 修改文件清单

| 文件 | 动作 | 里程碑 |
| --- | --- | --- |
| `src/shared/split-model.ts` | **新增**：树模型、递归布局、split/merge/move/remove/collapse/normalize、预设与旧配置转换、ratio 工具、`applyTabDrop` | M1 / M2 / M3 |
| `src/shared/split.ts` | 常量改由新模块统一导出；`SplitSnapshot` 增加 `paneIds / focusedPaneId / tree / sashes`；旧 `computePaneRects` 保留为兼容参考 | M1 / M2 / M3 |
| `src/shared/types.ts` | `DropPreview`；`TabbarApi` / `TAB_IPC` 增加分隔条与五方向通道 | M2 / M3 |
| `src/main/tabs/tab-model.ts` | `toPersistedTabs` 支持写树（无树时仍输出 v1 平面结构） | M1 |
| `src/main/tabs/tab-persistence.ts` | `VERSION → 2`；`PersistedLayout`；读写 `layout`；保留传入 version | M1 |
| `src/main/tabs/tab-manager.ts` | 树为唯一数据源；`groups` 改为 DFS 投影；重写 preset/split/close/move/restore/layout/save；新增 sash 拖动、预览与落位 | M1 / M2 / M3 |
| `src/main/ipc.ts` | 新增 M2 / M3 的 IPC handler（含参数校验） | M2 / M3 |
| `src/preload/tabbar.ts` | 内联通道名与 API 方法同步 | M2 / M3 |
| `src/renderer/tabbar/index.html` | 新增 `#sash-layer` / `#drop-preview` | M2 / M3 |
| `src/renderer/tabbar/style.css` | 分隔条细线 / 调整光标；五方向投放区与预览层样式 | M2 / M3 |
| `src/renderer/tabbar/tabbar.ts` | 分隔条 Pointer Events；五区域命中、rAF 预览、Esc / blur 收尾；拖动中增量更新 DOM | M2 / M3 |
| `scripts/check-split-model.mjs` | **新增** 218 项纯数据 + 静态契约回归 | M1 / M2 / M3 |
| `package.json` | `check:split-model` 纳入 `check` | M1 |
| `README.md` | 分屏说明、快捷键表、目录速览、当前状态 | M1 / M2 / M3 |
| `docs/PLAN-02-split-tree-delivery.md` | 本文件 | M3 |

**未改动**：`src/main/index.ts`、`src/main/menu.ts`、`src/main/titlebar.ts`、`src/renderer/tabbar/draft-panel.ts`、`src/main/tabs/draft-*`、`tab-status*`、`notification*`、`theme*`、`compat.ts`、`tab-lifecycle.ts`、`scripts/check-split.mjs`（旧平面公式回归保持原样）。

---

## 3. Split Tree 数据结构

```ts
type LayoutNode = SplitNode | PaneNode;

interface SplitNode {
  type: "split";
  id: string;                       // 稳定 UUID
  direction: "horizontal" | "vertical"; // horizontal=左右，vertical=上下
  ratio: number;                    // 第一个子区域占比 0.05..0.95
  children: [LayoutNode, LayoutNode];
}

interface PaneNode {
  type: "pane";
  id: string;                       // 稳定 UUID，不是数组下标
  tabIds: string[];                 // 沿用 TabManager 生成的稳定 Tab UUID
  activeId: string | null;          // 与既有 SplitGroupSnapshot 同名
}
```

- `PaneNode` 只负责「这个窗格有哪些页签 / 当前显示哪个」；`SplitNode` 只负责「怎么分 / 分多少」。
- 最多 4 个 `PaneNode`；`SplitNode` 数由树自然决定（最多 3）。
- Tab id 仍是 `randomUUID()`，页面实例与 `WebContentsView` 一一对应，**从不因布局变化重建**。
- 持久化时 `tabIds` 换成 `tabs[]` 下标（页签 id 每次启动都会变），pane id 原样保存。

---

## 4. 布局计算原理

`computeLayoutRects(root, bounds)` 从根递归：

1. 按 `direction` 取轴，`avail = size - SASH_GAP`；
2. `first = floor(avail × ratio)`，最后一格吃掉余数；
3. `minSpanAlong(child, axis)` 递归算出每个子树在该轴上的最小需求；只有整棵子树都放得下最小尺寸时才把 `first` 钳到 `[needFirst, size - gap - needSecond]`，否则安全降级为按比例（不产生 NaN / 负面积）；
4. 生成两个子矩形并扣除 gap；叶子产出 `PaneLayout`，分节点产出 `SashRect` 与 `nodes[id]`。

`TabManager.syncLayout()` 用 `layoutSignature(root)`（只含 id / 方向 / ratio 的几何签名）+ 窗口尺寸做缓存，`layout()` 与 `snapshot()` 都取同一份结果：主进程用它 `WebContentsView.setBounds`，渲染层拿 `split.rects / split.sashes / split.paneIds` 画页签条、分隔条与预览，**不自己算位置**。

`layout()` 只改 `setBounds` 与「真正变化」的可见性集合 —— 分隔条拖动时 active 集合不变，零次 `setVisible`，页面不闪；也不调用 `focus()`。

---

## 5. 拖拽交互说明

### 5.1 分隔条（M2）

- 间隔 `SASH_GAP = 8px`（旧公式的 `PANE_GAP = 4` 保留给兼容回归）；命中区完全落在没有 `WebContentsView` 覆盖的像素带上，视觉只画 2px 细线。
- 悬停显示 `col-resize` / `row-resize`；`pointerdown` → `setPointerCapture` → `pointermove`（rAF 合并）→ `pointerup / pointercancel / lostpointercapture` 收尾。
- **跨原生视图的坐标**：`WebContentsView` 是原生子视图，指针移进内容区后 renderer 收不到事件，因此主进程以 `screen.getCursorScreenPoint()` + `win.getContentBounds()` 做 16ms 轮询作为可靠输入源；两条路径用时间戳丢弃晚到的旧 IPC，避免 ratio 回跳。
- `ratioFromPointer()` 按同一份 `nodes[splitId]` 换算，`clampRatioForBounds()` 保证两侧 ≥ 360×260。
- 结束信号四重兜底：`pointerup`、所有视图的 `mouseUp`、窗口 blur、30s 看门狗。
- 拖动中只改 ratio + bounds，**不写盘 / 不抢焦点 / 不刷新草稿上下文**；结束才 `persist()` 一次。

### 5.2 五方向拖拽（M3）

**调研结论**：`WebContentsView extends View`，`View` 只有 `setVisible / setBounds / setBackgroundColor / addChildView`，**没有 `setIgnoreMouseEvents`**（那是 `BrowserWindow` 的 API），无法让内容视图鼠标穿透；独立 overlay 视图要新增 WebContents + HTML + preload + 生命周期，属于「为拖拽重写视图管理」。现有 `beginTabDrag()` 隐藏所有内容视图后，`drag-overlay` 即可铺满窗口并可靠接收全部 HTML5 drag 事件。因此沿用该层级，改用**主进程统一计算**来达成「单一数据源」，并补上 Esc / blur / dragend / 30s 看门狗保证取消可靠。

拖起页签后，每个窗格显示五块互不重叠的区域（命中判定与视觉用同一套 `dropRegions()` 坐标）：

| 区域 | 结果 |
| --- | --- |
| Center | 把 Tab 移到该窗格（可选插入位置）；同窗格内只调顺序；不新建窗格 |
| Left / Right | 在目标 Pane 自己的区域内水平拆分，新窗格在左 / 右 |
| Top / Bottom | 在目标 Pane 自己的区域内垂直拆分，新窗格在上 / 下 |

- **预览**：`previewTabDrop()` 用与落位**同一个** `applyTabDrop()` 算出假想树，再由 `computeLayoutRects()` 得到所有窗格矩形，渲染层只画半透明轮廓 + 高亮目标窗格。预览绝不改动真实树，因此取消天然恢复。
- **落位**：`dropTab()` 再次调用 `applyTabDrop()`，保证「看到的 = 得到的」；只搬 Tab id，不关闭 / 不重建 / 不重载任何页面。
- **限制**：已达 4 窗格时四个边缘置灰并拒绝投放，Center 仍可合并；一个 Tab 全局只出现一次；移走某窗格最后一个 Tab 时（Center 投放）源 Pane 自动合并并折叠父 SplitNode。
- **取消**：`Esc`、窗口失焦、`dragend`、拖出窗口都走 `endSplitDrag()`，清空预览层并恢复视图。
- **投放层不阻断无关交互**：`hidden` 时 `display:none`，预览层 `pointer-events:none` 且只在拖动期间显示。

---

## 6. 持久化迁移方案

`tabs.json` v2：

```jsonc
{
  "version": 2,
  "activeIndex": 0,
  "tabs": [{ "path": "...", "title": "...", "pinned": false }],
  "split": { /* v1 平面镜像：groups / active / focused / layout */ },
  "layout": {
    "version": 2,
    "root": { /* SplitNode / PaneNode，PaneNode.tabIds 是 tabs[] 下标 */ },
    "focusedPaneId": "pane-..."
  }
}
```

- **同时写 `split` 镜像**，旧版本 app 降级后仍可读；不存绝对像素，只存 `ratio`。
- **读取优先级**：`layout.version === 2` → `fromPersistedTree()`；否则 `legacySplitToTree(split)`（columns/rows 等分链、grid 3 = 上两格 + 下通栏、grid 4 = 2×2，保留 pane 顺序、Tab 顺序、活动页签、focused）；都不可用则单 Pane。
- 任何路径最终过 `normalizeLayout()`：去无效引用、全局去重、修 active、**补齐所有未被认领的 Tab**、折叠单子节点、限 4 窗格、删空 Pane、至少保留一个。
- 迁移成功后 `notify() → scheduleSave()` 自动回写 v2；JSON 损坏 / 未知版本安全降级，**不会丢页签**。

---

## 7. 测试执行结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 |
| `npm run check`（1 × typecheck + 17 项既有回归） | 0 |
| `npm run check:split-model` | **218 ✓ / 0 ✗** |
| `npm run build`（main / preload / renderer） | 0 |

`check-split-model.mjs` 覆盖：树创建与稳定 id、左右 / 上下 / 嵌套拆分、比例计算与最小尺寸、非整数与极小窗口、拆分上限、移动 Tab、合并 / 删除空 Pane、单子节点折叠、坏树恢复、5 个预设转换、旧配置迁移各形状、v2 往返与安全降级、M2 的 ratio 换算 / 独立比例 / 窗口缩放 / 连续拖动 / 重启恢复、M3 的五方向落位 / 上限 / 预览与落位一致 / 取消恢复 / 页签不丢，以及静态契约（不重载视图、单一布局源、IPC 一致、Pointer Events / rAF / Esc / 看门狗 / 拖动不写盘）。

**未做**：计划中的 Electron GUI 集成测试（真实多 Agent 并发下拖布局、重启恢复不重载等）。纯逻辑与静态契约已覆盖，但真实窗口行为仍需按第 9 节人工回归。

---

## 8. 未解决的问题 / 已知偏差

1. **拖页签期间仍会隐藏内容视图**（显示半透明蒙层）。这是 `WebContentsView` 无鼠标穿透 API 的现状所致；独立 overlay 视图方案因改造面大未采用。页面状态不丢失、不重载，但视觉上会短暂看不到页面。
2. **最小尺寸取 360×260**，而非计划建议的 420×300：主窗口最小 900×600，取 420 会让三栏 / 四宫格在最小窗口下几乎全部不可行；360/260 在 1440×900 下仍生效，空间不足时按比例降级。
3. **边缘投放时源 Pane 只剩一个 Tab 会补一个空白页签**（`createTab("/")`），而不是按「自动合并」把源 Pane 删掉。理由：若删掉源 Pane，窗格数不会增加，五方向拆分的常见场景（每窗格 1 个 Tab）会完全失效；补位与 M1 `splitWithTab`、README 中「保证分屏不会因为一次拖动就没了」一致，且不关闭 / 不重载任何原有 Tab。Center 投放仍严格按计划「移走最后一个 Tab → 源 Pane 自动合并」。
4. **`Ctrl+\` 连按不再得到 3 / 4 个等宽列**，而是在目标窗格内产生嵌套形状；等宽三栏 / 四宫格请用 `▣` 下拉或 `Ctrl+Alt+3 / 4`。
5. **分隔条命中区只有 8px**：再加宽就会被 `WebContentsView` 盖住。
6. `screen.getCursorScreenPoint()` 在 Wayland 不支持；代码有 `catch` 兜底，退化成只靠 renderer 的 pointermove。目标平台是 Windows。
7. 旧的 `computePaneRects()` 保留在 `src/shared/split.ts`，仅供 `check:split` 与兼容参考，**运行时零调用**；它不是第二套布局逻辑。
8. 五方向预览只画窗格轮廓，不画拖放后的分隔条线；Center 区的 `insertIndex` 仍按水平位置估算（沿用旧行为）。
9. 未做 GUI 集成测试与真实多 Agent 并发回归（见第 9 节）。

---

## 9. 对现有多页签、草稿和状态监控的回归验证

`npm run check` 中与本次改动直接相关的既有回归全部保持绿灯：

| 能力 | 回归脚本 | 说明 |
| --- | --- | --- |
| 页签顺序 / 固定 / 关闭 / 持久化 | `check:tab-model`、`check:tab-lifecycle` | `toPersistedTabs` 无树时仍输出原 v1 结构，恢复顺序不变 |
| 独立输入工作区草稿隔离 | `check:draft-model`、`check:draft-workspace` | 草稿按 `path + sessionKey` 恢复，不依赖 Tab id；`onTabContextChanged` 在分隔条拖动期间被抑制 |
| Composer 复用原生发送 | `check:composer-bridge`、`check:composer-send` | 零注入变更 |
| 页签状态监控 / 通知 / 主题 | `check:tab-status-*`、`check:notification-bridge`、`check:theme-manager` | 按 `tabs[]` 遍历，不依赖分组结构 |
| 上游契约 / 零侵入 | `check:contracts` | 无本地 pi-web 依赖、无 patch-package、`onTabClosed` 的 `keepWindow` 守卫仍在 |

TabManager 中 `WebContentsView` 的创建 / 销毁、`loadURL`、`partition: persist:piweb`、登录态、崩溃恢复、托盘、菜单、窗口生命周期均未改动；布局变化只走 `setBounds / setVisible`。

**建议的人工回归清单**（临时配置 + 测试页面，勿在真实项目仓库做破坏性操作）：

1. 单栏开 4 个页签 → 切 `▣` 各预设 → 逐条拖分隔条 → 缩放到最小 900×600 → 重启，确认比例、页签顺序、固定状态、活动页签全部保留。
2. 造「左一右二」嵌套 → 分别拖竖线与横线 → 确认另一条 ratio 不变。
3. 五方向逐一投放 → 确认预览高亮位置与落位结果一致；第 5 个窗格被拒绝；Center 合并后页签顺序正确。
4. 拖页签过程中按 `Esc` / 拖出窗口 / 切走窗口 → 确认布局与视图完全恢复。
5. 两个页签各自跑 Agent 任务 → 拖分隔条与跨窗格移动 → 确认页面不重载、输入焦点不丢、状态点与通知正常。
6. 打开独立输入工作区写草稿 → 拖分隔条 / 拖页签 → 确认草稿不串、发送仍复用原生按钮。
7. 删除 `tabs.json` 里的 `layout` 只留 v1 `split` → 启动 → 确认自动迁移并回写 v2，页签一个不少。
