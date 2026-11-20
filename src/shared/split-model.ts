/**
 * Split Tree：VS Code「编辑器组」风格的嵌套分屏纯数据模型。
 *
 * 设计要点：
 *  - 布局树是**唯一数据源**：PaneNode 只保存「这个窗格有哪些页签 / 当前显示哪个」，
 *    SplitNode 只保存「怎么分 / 分多少（ratio）」。Tab id 沿用 TabManager 生成的稳定 UUID，
 *    Pane / Split id 也用 UUID，绝不使用数组下标当 id。
 *  - 本模块不 import electron / node: 任何东西，主进程、渲染层、纯 Node 单测都能直接加载
 *    （scripts 用 node --experimental-strip-types 直接跑 .ts）。
 *  - 所有改结构的函数都返回**新树**（先 clone），调用方把结果赋回去即可；
 *    TabManager 里对 PaneNode.tabIds / activeId 的增量修改则在活节点上原地做，
 *    仍然是同一棵树，不产生第二份状态。
 *
 * 方向约定：horizontal = 左右分割，vertical = 上下分割；ratio = 第一个子区域占比。
 */

export type LayoutKind = "columns" | "rows" | "grid";
export type PresetId = "single" | "columns-2" | "rows-2" | "columns-3" | "grid-2x2";
export type SplitDirection = "horizontal" | "vertical";
export type EdgeSide = "left" | "right" | "top" | "bottom";
export type Placement = "before" | "after";

/** 页签条高度（与 main/titlebar.ts、renderer/tabbar/style.css 一致） */
export const TABBAR_HEIGHT = 40;
/** 旧版 v1 平面公式的窗格间隔（只给 split.ts 的 computePaneRects / 旧回归用） */
export const PANE_GAP = 4;
/** Split Tree 的窗格间隔，同时也是分隔条的**有效命中宽度**。
 *  WebContentsView 是原生子视图，会盖住窗口自己的渲染层；只有这条没有视图覆盖的
 *  空隙能可靠接收 Pointer Events，所以从 4px 加宽到 8px（视觉仍只画 2px 细线）。 */
export const SASH_GAP = 8;
/** 分隔条视觉线宽（CSS 画在 SASH_GAP 正中） */
export const SASH_LINE = 2;
/** 名义命中宽度；有效值等于 SASH_GAP */
export const SASH_HIT_SIZE = SASH_GAP;
/** 一个 pi-web 页面比较吃宽度，最多 4 个窗格 */
export const MAX_PANES = 4;
/** 窗格最小尺寸：调整比例 / 继续拆分时保证两边都不小于它。
 *  计划建议 420/300；这里按实际窗口取值 360/260：主窗口最小 900×600、默认 1440×900，
 *  4 宫格 / 三栏在最小窗口下也能全部满足，不会因为钳制把某一格挤成不可用宽度。
 *  空间确实不足时 computeLayoutRects 会安全降级为按比例（不产生负面积 / NaN）。 */
export const MIN_PANE_WIDTH = 360;
export const MIN_PANE_HEIGHT = 260;
/** ratio 的硬边界，避免 0 / 1 导致某一侧完全消失 */
export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;
/** tabs.json 里 Split Tree 的版本（复用 tab-persistence.ts 的 version 机制） */
export const LAYOUT_SCHEMA_VERSION = 2;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneNode {
  type: "pane";
  id: string;
  tabIds: string[];
  /** 与既有 SplitGroupSnapshot / PaneGroup 保持同名，减少上层改动 */
  activeId: string | null;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  /** 第一个子区域占据的比例，0..1 */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = SplitNode | PaneNode;

/** 持久化版本：页签 id 每次启动都会重新生成，所以树里存 tabs[] 下标 */
export interface PersistedPaneNode {
  type: "pane";
  id: string;
  tabIds: number[];
  activeId: number | null;
}

export interface PersistedSplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  children: [PersistedLayoutNode, PersistedLayoutNode];
}

export type PersistedLayoutNode = PersistedSplitNode | PersistedPaneNode;

export interface PersistedLayout {
  version: number;
  root: PersistedLayoutNode;
  focusedPaneId: string;
}

export interface PaneLayout {
  id: string;
  rect: Rect;
}

export interface SashRect {
  /** 对应的 SplitNode id：每个 SplitNode 恰好一条分隔条 */
  id: string;
  direction: SplitDirection;
  ratio: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一次布局计算的完整结果。主进程用它给 WebContentsView.setBounds，
 * 同一份结果通过 snapshot 原样发给渲染层画页签条 / 分隔条 —— 不做第二次计算。
 */
export interface LayoutResult {
  /** DFS 顺序（先左/上，后右/下），与 collectPanes() 顺序严格一致 */
  panes: PaneLayout[];
  sashes: SashRect[];
  /** 所有节点（含 SplitNode）的矩形，供比例钳制 / 拖拽预览使用 */
  nodes: Record<string, Rect>;
}

export interface LayoutOptions {
  gap?: number;
  minPaneWidth?: number;
  minPaneHeight?: number;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 生成稳定、非下标、可跨重启持久化的节点 id（浏览器与 Node 22 都有 globalThis.crypto） */
export function newLayoutId(prefix: "pane" | "split" = "pane"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${uuid ?? fallback}`;
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);
}

export function createPane(
  tabIds: readonly string[] = [],
  activeId: string | null = null,
  id: string = newLayoutId("pane"),
): PaneNode {
  return { type: "pane", id, tabIds: [...tabIds], activeId: activeId ?? tabIds[0] ?? null };
}

export function createSplit(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
  id: string = newLayoutId("split"),
): SplitNode {
  return { type: "split", id, direction, ratio: clampRatio(ratio), children: [first, second] };
}

/** 深拷贝：所有结构变更先 clone，保证纯函数不改动入参 */
export function cloneTree(root: LayoutNode): LayoutNode {
  if (root.type === "pane") {
    return { type: "pane", id: root.id, tabIds: [...root.tabIds], activeId: root.activeId };
  }
  return {
    type: "split",
    id: root.id,
    direction: root.direction,
    ratio: root.ratio,
    children: [cloneTree(root.children[0]), cloneTree(root.children[1])],
  };
}

/** 返回树里的活节点（TabManager 的 groups 就是它的投影） */
export function collectPanes(root: LayoutNode): PaneNode[] {
  if (root.type === "pane") return [root];
  return [...collectPanes(root.children[0]), ...collectPanes(root.children[1])];
}

export function collectSplits(root: LayoutNode): SplitNode[] {
  if (root.type === "pane") return [];
  return [root, ...collectSplits(root.children[0]), ...collectSplits(root.children[1])];
}

export function paneCount(root: LayoutNode): number {
  return collectPanes(root).length;
}

export function findPane(root: LayoutNode, id: string): PaneNode | null {
  const found = collectPanes(root).find((pane) => pane.id === id);
  return found ?? null;
}

export function findSplit(root: LayoutNode, id: string): SplitNode | null {
  const found = collectSplits(root).find((split) => split.id === id);
  return found ?? null;
}

/** 某个节点的父 SplitNode；根节点没有父节点 */
export function findParentSplit(root: LayoutNode, id: string): SplitNode | null {
  if (root.type === "pane" || root.id === id) return null;
  for (const child of root.children) {
    if (child.id === id) return root;
    const nested = findParentSplit(child, id);
    if (nested) return nested;
  }
  return null;
}

/** 单栏 / 纯左右 / 纯上下 / 混合嵌套，用于菜单勾选与旧 split.layout 镜像 */
export function layoutKind(root: LayoutNode): LayoutKind {
  const splits = collectSplits(root);
  if (splits.length === 0) return "columns";
  const horizontal = splits.every((split) => split.direction === "horizontal");
  const vertical = splits.every((split) => split.direction === "vertical");
  if (horizontal) return "columns";
  if (vertical) return "rows";
  return "grid";
}

/** 只含几何信息的签名：页签增减不该让布局重算，ratio / 方向 / 结构变化才重算 */
export function layoutSignature(root: LayoutNode): string {
  if (root.type === "pane") return `p:${root.id}`;
  return `s:${root.id}:${root.direction}:${root.ratio.toFixed(6)}[${layoutSignature(root.children[0])}|${layoutSignature(root.children[1])}]`;
}

/** 用 replacement 替换树里 id 对应的节点（clone 版本由调用方保证） */
function replaceNode(root: LayoutNode, id: string, replacement: LayoutNode): LayoutNode {
  if (root.id === id) return replacement;
  if (root.type === "pane") return root;
  const first = replaceNode(root.children[0], id, replacement);
  const second = replaceNode(root.children[1], id, replacement);
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

export interface SplitResult {
  root: LayoutNode;
  newPaneId: string;
  changed: boolean;
}

/**
 * Split：把目标 Pane 换成 SplitNode，原 Pane 保留全部页签，新 Pane 为空。
 * placement="after" 表示新窗格在右/下（默认），"before" 表示在左/上。
 * 已到 MAX_PANES 或目标不存在时返回原树（changed=false）。
 */
export function splitPane(
  root: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  placement: Placement = "after",
  options: { ratio?: number; tabIds?: readonly string[]; activeId?: string | null; newPaneId?: string } = {},
): SplitResult {
  if (paneCount(root) >= MAX_PANES || !findPane(root, paneId)) {
    return { root, newPaneId: "", changed: false };
  }
  const work = cloneTree(root);
  const original = findPane(work, paneId) as PaneNode;
  const fresh = createPane(
    options.tabIds ?? [],
    options.activeId ?? null,
    options.newPaneId ?? newLayoutId("pane"),
  );
  const node = createSplit(
    direction,
    placement === "before" ? fresh : original,
    placement === "before" ? original : fresh,
    options.ratio ?? 0.5,
  );
  return { root: replaceNode(work, paneId, node), newPaneId: fresh.id, changed: true };
}

/** 「拖到窗口最左/最右/最上/最下」：在整棵树外面再套一层 SplitNode */
export function addEdgePane(
  root: LayoutNode,
  side: EdgeSide,
  options: { newPaneId?: string; tabIds?: readonly string[] } = {},
): SplitResult {
  if (paneCount(root) >= MAX_PANES) return { root, newPaneId: "", changed: false };
  const count = paneCount(root);
  const before = side === "left" || side === "top";
  const direction: SplitDirection = side === "left" || side === "right" ? "horizontal" : "vertical";
  const fresh = createPane(options.tabIds ?? [], null, options.newPaneId ?? newLayoutId("pane"));
  const old = cloneTree(root);
  // 让新窗格与原有窗格等分：n+1 格时它占 1/(n+1)
  const ratio = before ? 1 / (count + 1) : count / (count + 1);
  const node = createSplit(
    direction,
    before ? fresh : old,
    before ? old : fresh,
    ratio,
  );
  return { root: node, newPaneId: fresh.id, changed: true };
}

/** 五方向投放 → 拆分方向 + 新窗格放在目标之前还是之后 */
export function directionForSide(side: EdgeSide): { direction: SplitDirection; placement: Placement } {
  return {
    direction: side === "left" || side === "right" ? "horizontal" : "vertical",
    placement: side === "left" || side === "top" ? "before" : "after",
  };
}

/* ----------------------------- M3：五方向投放（纯逻辑） ----------------------------- */

export type DropSide = "center" | "left" | "right" | "top" | "bottom";

export interface TabDropResult {
  /** 假想拖放后的树；绝不改动入参 */
  root: LayoutNode;
  /** 页签最终落在哪个 Pane */
  destinationPaneId: string;
  /** 是否新建了窗格 */
  createsPane: boolean;
  /** 是否允许这次投放（4 窗格上限时边缘投放为 false） */
  allowed: boolean;
  /** 不允许 / 无变化时的人话原因 */
  reason: string;
  /** 实际生效的方向 */
  effectiveSide: DropSide;
  /** 源 Pane 只剩最后一个 Tab 的边缘投放：调用方需要补一个空白页签保住源 Pane */
  placeholderPaneId: string | null;
  changed: boolean;
}

function findPaneOfTab(root: LayoutNode, tabId: string): PaneNode | null {
  return collectPanes(root).find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

/** 只搬 Tab、不删空窗格。边缘投放要保留源 Pane 给占位页签，不能用会 prune 的 moveTab。 */
function moveTabKeepEmpty(
  work: LayoutNode,
  tabId: string,
  targetPaneId: string,
  insertIndex?: number,
): boolean {
  const target = findPane(work, targetPaneId);
  if (!target) return false;
  let found = false;
  for (const pane of collectPanes(work)) {
    const at = pane.tabIds.indexOf(tabId);
    if (at < 0) continue;
    pane.tabIds.splice(at, 1);
    if (pane.activeId === tabId) pane.activeId = pane.tabIds[0] ?? null;
    found = true; // 全局去重：一个 Tab 只在一个 Pane 里
  }
  if (!found) return false;
  const requested = Number.isFinite(insertIndex) ? Math.trunc(insertIndex as number) : target.tabIds.length;
  const at = Math.min(Math.max(requested, 0), target.tabIds.length);
  target.tabIds.splice(at, 0, tabId);
  target.activeId = tabId;
  return true;
}

/**
 * VS Code 式五方向投放的**唯一**落位算法：预览和真正执行都调它，保证「看到的 = 得到的」。
 *
 *  - center：把 Tab 移到目标 Pane（moveTab 会在源 Pane 空时自动合并）；同 Pane 内只调顺序。
 *  - left/right/top/bottom：在**目标 Pane 自己的区域内**按 directionForSide 拆出一个新 Pane，
 *    再把 Tab 放进去（不关闭 / 不重建任何原有 Tab，Tab id 原样搬运）。
 *  - 已达 MAX_PANES：边缘投放被拒绝（allowed=false），仍可拖到 center 合并。
 *  - **最小尺寸**：bounds 是必填参数，边缘拆分前一定用 canSplit() 按目标 Pane 当前矩形检查，
 *    不满足就拒绝（allowed=false，树不变），Center 合并不受影响。约束在纯函数里，
 *    任何调用方（预览 / 落位 / 未来新入口）都绕不过去。
 *  - 源 Pane 只剩这一个 Tab 时边缘投放会让源 Pane 变空 → 返回 placeholderPaneId，
 *    由 TabManager 先补一个空白页签再重算，保证窗格数确实 +1（与 M1 splitWithTab 行为一致）。
 */
export function applyTabDrop(
  root: LayoutNode,
  tabId: string,
  targetPaneId: string,
  side: DropSide,
  bounds: Rect,
  insertIndex?: number,
  options: LayoutOptions = {},
): TabDropResult {
  const base: TabDropResult = {
    root,
    destinationPaneId: "",
    createsPane: false,
    allowed: false,
    reason: "",
    effectiveSide: side,
    placeholderPaneId: null,
    changed: false,
  };
  const source = findPaneOfTab(root, tabId);
  const target = findPane(root, targetPaneId);
  if (!source || !target) return { ...base, reason: "页签或目标窗格已不存在" };

  if (side === "center") {
    const result = moveTab(root, tabId, targetPaneId, insertIndex);
    return {
      ...base,
      root: result.root,
      allowed: result.changed,
      changed: result.changed,
      destinationPaneId: targetPaneId,
      effectiveSide: "center",
      reason: result.changed ? "" : "页签没有变化",
    };
  }

  if (paneCount(root) >= MAX_PANES) {
    return { ...base, allowed: false, reason: "最多 4 个窗格，只能拖到中心合并" };
  }

  const { direction, placement } = directionForSide(side);
  // 硬约束：按目标 Pane 当前实际矩形判断能否继续朝这个方向拆。
  // 不放在 Renderer 里 —— 预览与落位都走这里，绕过 UI 直接调 IPC 也拆不了。
  if (!canSplit(root, bounds, targetPaneId, direction, options)) {
    const minW = Math.max(1, options.minPaneWidth ?? MIN_PANE_WIDTH);
    const minH = Math.max(1, options.minPaneHeight ?? MIN_PANE_HEIGHT);
    return {
      ...base,
      allowed: false,
      reason: `窗口太小：继续拆分后每格不足 ${minW}×${minH}，只能拖到中心合并`,
    };
  }

  const split = splitPane(root, targetPaneId, direction, placement);
  if (!split.changed) return { ...base, reason: "无法在此处新建窗格" };

  const placeholderPaneId = source.tabIds.length === 1 ? source.id : null;
  if (!moveTabKeepEmpty(split.root, tabId, split.newPaneId)) {
    return { ...base, reason: "页签移动失败" };
  }
  return {
    ...base,
    root: split.root,
    destinationPaneId: split.newPaneId,
    createsPane: true,
    allowed: true,
    changed: true,
    effectiveSide: side,
    placeholderPaneId,
  };
}

export interface RemoveResult {
  root: LayoutNode;
  /** 被删窗格的页签合并进了哪个窗格 */
  mergedIntoId: string | null;
  removedTabIds: string[];
  changed: boolean;
}

/**
 * RemovePane：删掉一个 Pane，把它全部页签合并到相邻窗格，并把它父级 SplitNode
 * 直接提升为兄弟子树（Collapse：单子节点自动提升）。根 Pane 不允许删除。
 */
export function removePane(root: LayoutNode, paneId: string): RemoveResult {
  const target = findPane(root, paneId);
  if (!target || root.type === "pane") {
    return { root, mergedIntoId: null, removedTabIds: [], changed: false };
  }
  const work = cloneTree(root);
  const parent = findParentSplit(work, paneId);
  if (!parent) return { root, mergedIntoId: null, removedTabIds: [], changed: false };

  const isFirst = parent.children[0].id === paneId;
  const sibling = isFirst ? parent.children[1] : parent.children[0];
  const siblings = collectPanes(sibling);
  // 删左侧/上侧 → 合并到右侧/下侧的第一个；删右侧/下侧 → 合并到左侧/上侧的最后一个
  const mergeTarget = isFirst ? siblings[0] : siblings[siblings.length - 1];
  const removedTabIds = [...(findPane(work, paneId)?.tabIds ?? [])];
  if (mergeTarget) {
    for (const id of removedTabIds) {
      if (!mergeTarget.tabIds.includes(id)) mergeTarget.tabIds.push(id);
    }
    if (!mergeTarget.activeId || !mergeTarget.tabIds.includes(mergeTarget.activeId)) {
      mergeTarget.activeId = mergeTarget.tabIds[0] ?? null;
    }
  }
  const next = parent === work ? sibling : replaceNode(work, parent.id, sibling);
  return {
    root: next,
    mergedIntoId: mergeTarget?.id ?? null,
    removedTabIds,
    changed: true,
  };
}

/** 删掉所有空窗格（至少保留一个），并修好失效的 activeId */
export function pruneEmptyPanes(root: LayoutNode): LayoutNode {
  let work = cloneTree(root);
  for (let guard = 0; guard <= MAX_PANES; guard += 1) {
    const panes = collectPanes(work);
    if (panes.length <= 1) break;
    const empty = panes.find((pane) => pane.tabIds.length === 0);
    if (!empty) break;
    work = removePane(work, empty.id).root;
  }
  for (const pane of collectPanes(work)) {
    if (!pane.activeId || !pane.tabIds.includes(pane.activeId)) {
      pane.activeId = pane.tabIds[0] ?? null;
    }
  }
  return work;
}

export interface MoveResult {
  root: LayoutNode;
  changed: boolean;
}

/**
 * MoveTab：把 Tab 从它所在的 Pane 移到目标 Pane，不重建也不关闭任何 Tab。
 * 源 Pane 因此变空时自动删除（Collapse）；同一个 Tab 在树里只出现一次。
 */
export function moveTab(
  root: LayoutNode,
  tabId: string,
  targetPaneId: string,
  insertIndex?: number,
): MoveResult {
  const work = cloneTree(root);
  const target = findPane(work, targetPaneId);
  if (!target) return { root, changed: false };

  let found = false;
  for (const pane of collectPanes(work)) {
    const at = pane.tabIds.indexOf(tabId);
    if (at < 0) continue;
    pane.tabIds.splice(at, 1);
    if (pane.activeId === tabId) pane.activeId = pane.tabIds[0] ?? null;
    found = true;
  }
  if (!found) return { root, changed: false };

  const requested = Number.isFinite(insertIndex) ? Math.trunc(insertIndex as number) : target.tabIds.length;
  const at = Math.min(Math.max(requested, 0), target.tabIds.length);
  target.tabIds.splice(at, 0, tabId);
  target.activeId = tabId;
  return { root: pruneEmptyPanes(work), changed: true };
}

/** Merge：把一个 Pane 的全部页签并入另一个 Pane，再删掉源 Pane */
export function mergePanes(root: LayoutNode, fromPaneId: string, toPaneId: string): MoveResult {
  if (fromPaneId === toPaneId) return { root, changed: false };
  const work = cloneTree(root);
  const from = findPane(work, fromPaneId);
  const to = findPane(work, toPaneId);
  if (!from || !to) return { root, changed: false };
  for (const id of from.tabIds) {
    if (!to.tabIds.includes(id)) to.tabIds.push(id);
  }
  to.activeId = from.activeId ?? to.activeId ?? to.tabIds[0] ?? null;
  // 清空后再 removePane，避免那边又把同一批 tab 合并一次
  from.tabIds = [];
  from.activeId = null;
  return { root: removePane(work, fromPaneId).root, changed: true };
}

/** M2 用：改某个 SplitNode 的 ratio（其它 SplitNode 不受影响） */
export function setRatio(root: LayoutNode, splitId: string, ratio: number): MoveResult {
  const work = cloneTree(root);
  const split = findSplit(work, splitId);
  if (!split) return { root, changed: false };
  split.ratio = clampRatio(ratio);
  return { root: work, changed: true };
}

/* ----------------------------- 递归布局计算 ----------------------------- */

/** 一个子树在指定轴上「至少需要多少像素」（把嵌套展开算进去） */
export function minSpanAlong(
  node: LayoutNode,
  axis: SplitDirection,
  gap = SASH_GAP,
  minW = MIN_PANE_WIDTH,
  minH = MIN_PANE_HEIGHT,
): number {
  if (node.type === "pane") return axis === "horizontal" ? minW : minH;
  const first = minSpanAlong(node.children[0], axis, gap, minW, minH);
  const second = minSpanAlong(node.children[1], axis, gap, minW, minH);
  return node.direction === axis ? first + second + gap : Math.max(first, second);
}

/**
 * 从根节点递归算出所有 PaneNode 的最终 bounds。
 *  - 按 direction 决定分割方向，按 ratio 算第一个子区域；
 *  - 每处扣掉 SASH_GAP，最后一格吃掉余数；
 *  - 空间允许时钳到最小尺寸；空间不足时安全降级为按比例（不产生 NaN / 负面积）；
 *  - 同时输出每个 SplitNode 的分隔条矩形和所有节点矩形。
 */
export function computeLayoutRects(
  root: LayoutNode,
  bounds: Rect,
  options: LayoutOptions = {},
): LayoutResult {
  const gap = Math.max(0, options.gap ?? SASH_GAP);
  const minW = Math.max(1, options.minPaneWidth ?? MIN_PANE_WIDTH);
  const minH = Math.max(1, options.minPaneHeight ?? MIN_PANE_HEIGHT);
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const x0 = Number.isFinite(bounds.x) ? bounds.x : 0;
  const y0 = Number.isFinite(bounds.y) ? bounds.y : 0;
  const panes: PaneLayout[] = [];
  const sashes: SashRect[] = [];
  const nodes: Record<string, Rect> = {};

  const walk = (node: LayoutNode, rect: Rect): void => {
    nodes[node.id] = rect;
    if (node.type === "pane") {
      panes.push({ id: node.id, rect });
      return;
    }
    const axis = node.direction;
    const size = axis === "horizontal" ? rect.width : rect.height;
    const avail = Math.max(size - gap, 0);
    let first = Math.max(Math.floor(avail * clampRatio(node.ratio)), 1);
    const needFirst = minSpanAlong(node.children[0], axis, gap, minW, minH);
    const needSecond = minSpanAlong(node.children[1], axis, gap, minW, minH);
    // 只有整棵子树都放得下最小尺寸时才钳制，否则按比例降级（宁可小也别把某格挤成 1px）
    if (needFirst + needSecond + gap <= size) {
      first = Math.min(Math.max(first, needFirst), Math.max(size - gap - needSecond, 1));
    }
    const second = Math.max(size - first - gap, 1);

    const firstRect: Rect =
      axis === "horizontal"
        ? { x: rect.x, y: rect.y, width: first, height: rect.height }
        : { x: rect.x, y: rect.y, width: rect.width, height: first };
    const secondRect: Rect =
      axis === "horizontal"
        ? { x: rect.x + first + gap, y: rect.y, width: second, height: rect.height }
        : { x: rect.x, y: rect.y + first + gap, width: rect.width, height: second };
    const sash: SashRect =
      axis === "horizontal"
        ? { id: node.id, direction: axis, ratio: node.ratio, x: rect.x + first, y: rect.y, width: gap, height: rect.height }
        : { id: node.id, direction: axis, ratio: node.ratio, x: rect.x, y: rect.y + first, width: rect.width, height: gap };
    sashes.push(sash);
    walk(node.children[0], firstRect);
    walk(node.children[1], secondRect);
  };

  walk(root, { x: x0, y: y0, width, height });
  return { panes, sashes, nodes };
}

/** M2 用：把 ratio 钳到「两个子区域都满足最小尺寸」的区间 */
export function clampRatioForBounds(
  root: LayoutNode,
  splitId: string,
  ratio: number,
  bounds: Rect,
  options: LayoutOptions = {},
): number {
  const split = findSplit(root, splitId);
  const wanted = clampRatio(ratio);
  if (!split) return wanted;
  const gap = Math.max(0, options.gap ?? SASH_GAP);
  const minW = Math.max(1, options.minPaneWidth ?? MIN_PANE_WIDTH);
  const minH = Math.max(1, options.minPaneHeight ?? MIN_PANE_HEIGHT);
  const rect = computeLayoutRects(root, bounds, options).nodes[splitId];
  if (!rect) return wanted;
  const size = split.direction === "horizontal" ? rect.width : rect.height;
  const avail = size - gap;
  const needFirst = minSpanAlong(split.children[0], split.direction, gap, minW, minH);
  const needSecond = minSpanAlong(split.children[1], split.direction, gap, minW, minH);
  if (avail <= 0 || needFirst + needSecond > avail) return wanted;
  return Math.min(Math.max(wanted, needFirst / avail), 1 - needSecond / avail);
}

/**
 * M2：把「窗口内容区坐标」换算成某个 SplitNode 的目标 ratio。
 * 该 SplitNode 的矩形取自同一份 computeLayoutRects 结果（nodes），且只依赖祖先 ratio，
 * 拖动它自己的 ratio 不会让矩形漂移 —— 主进程与渲染层不需要各自换算坐标。
 */
export function ratioFromPointer(
  root: LayoutNode,
  splitId: string,
  bounds: Rect,
  x: number,
  y: number,
  options: LayoutOptions = {},
): number | null {
  const split = findSplit(root, splitId);
  if (!split) return null;
  const gap = Math.max(0, options.gap ?? SASH_GAP);
  const rect = computeLayoutRects(root, bounds, options).nodes[splitId];
  if (!rect) return null;
  const horizontal = split.direction === "horizontal";
  const avail = (horizontal ? rect.width : rect.height) - gap;
  if (avail <= 0) return null;
  const origin = horizontal ? rect.x : rect.y;
  const position = horizontal ? x : y;
  return clampRatioForBounds(root, splitId, (position - origin) / avail, bounds, options);
}

/** 继续拆分前判断：目标窗格被一分为二后两边是否都够用 */
export function canSplit(
  root: LayoutNode,
  bounds: Rect,
  paneId: string,
  direction: SplitDirection,
  options: LayoutOptions = {},
): boolean {
  if (paneCount(root) >= MAX_PANES) return false;
  const gap = Math.max(0, options.gap ?? SASH_GAP);
  const minW = Math.max(1, options.minPaneWidth ?? MIN_PANE_WIDTH);
  const minH = Math.max(1, options.minPaneHeight ?? MIN_PANE_HEIGHT);
  const rect = computeLayoutRects(root, bounds, options).panes.find((pane) => pane.id === paneId)?.rect;
  if (!rect) return false;
  return direction === "horizontal"
    ? rect.width - gap >= minW * 2 && rect.height >= minH
    : rect.height - gap >= minH * 2 && rect.width >= minW;
}

/** 「拖到窗口最左/最右/最上/最下」：在整棵树外面再套一层之前判断空间够不够。
 *  原树在该轴上的最小需求按 minSpanAlong() 展开，新窗格至少占一个最小尺寸。 */
export function canAddEdge(
  root: LayoutNode,
  bounds: Rect,
  side: EdgeSide,
  options: LayoutOptions = {},
): boolean {
  if (paneCount(root) >= MAX_PANES) return false;
  const gap = Math.max(0, options.gap ?? SASH_GAP);
  const minW = Math.max(1, options.minPaneWidth ?? MIN_PANE_WIDTH);
  const minH = Math.max(1, options.minPaneHeight ?? MIN_PANE_HEIGHT);
  const direction = directionForSide(side).direction;
  const horizontal = direction === "horizontal";
  const size = horizontal ? bounds.width : bounds.height;
  const needExisting = minSpanAlong(root, direction, gap, minW, minH);
  const needFresh = horizontal ? minW : minH;
  const otherAxisOk = horizontal ? bounds.height >= minH : bounds.width >= minW;
  return size - gap >= needExisting + needFresh && otherAxisOk;
}

/* ----------------------------- 无效树恢复 ----------------------------- */

function idRegistry(): (prefix: "pane" | "split", preferred?: unknown) => string {
  const used = new Set<string>();
  return (prefix, preferred) => {
    let id = typeof preferred === "string" && preferred.length > 0 && !used.has(preferred) ? preferred : "";
    while (!id || used.has(id)) id = newLayoutId(prefix);
    used.add(id);
    return id;
  };
}

/**
 * 恢复/校验任意来源的树：
 *  - 丢弃无法识别的节点、重复 id 重新分配；
 *  - 单子节点 SplitNode 自动提升、空 children 变回一个 Pane；
 *  - 过滤无效 Tab 引用、全局去重（先出现者胜）；
 *  - 修 activeId、补回所有「没被任何窗格认领」的 Tab；
 *  - 超过 MAX_PANES 时把多余窗格的页签合并进相邻窗格；
 *  - 删空窗格，至少保留一个。
 * 无论如何不会丢掉 validTabIds 里的任何一个页签。
 */
export function normalizeLayout(input: unknown, validTabIds: readonly string[]): { root: LayoutNode; changed: boolean } {
  const before = JSON.stringify(input ?? null);
  const valid = new Set(validTabIds);
  const seenTabs = new Set<string>();
  const nextId = idRegistry();

  const build = (raw: unknown): LayoutNode => {
    if (!isRecord(raw)) return createPane([], null, nextId("pane"));
    if (raw.type === "pane") {
      const tabIds: string[] = [];
      const list = Array.isArray(raw.tabIds) ? raw.tabIds : [];
      for (const item of list) {
        if (typeof item === "string" && valid.has(item) && !seenTabs.has(item)) {
          tabIds.push(item);
          seenTabs.add(item);
        }
      }
      const activeId = typeof raw.activeId === "string" && tabIds.includes(raw.activeId)
        ? raw.activeId
        : (tabIds[0] ?? null);
      return { type: "pane", id: nextId("pane", raw.id), tabIds, activeId };
    }
    const children = (Array.isArray(raw.children) ? raw.children : []).map((child) => build(child));
    if (children.length === 0) return createPane([], null, nextId("pane"));
    if (children.length === 1) return children[0]; // Collapse
    const direction: SplitDirection = raw.direction === "vertical" ? "vertical" : "horizontal";
    const ratio = clampRatio(
      typeof raw.ratio === "number" && Number.isFinite(raw.ratio) ? raw.ratio : 1 / children.length,
    );
    let right = children[children.length - 1];
    for (let i = children.length - 2; i >= 1; i -= 1) {
      right = createSplit(direction, children[i], right, 1 / (children.length - i), nextId("split"));
    }
    return createSplit(direction, children[0], right, ratio, nextId("split", raw.id));
  };

  let root = build(input);
  // 上限：把尾部多余窗格合并进相邻窗格（页签不丢）
  for (let guard = 0; guard <= MAX_PANES + 2 && paneCount(root) > MAX_PANES; guard += 1) {
    const panes = collectPanes(root);
    root = removePane(root, panes[panes.length - 1].id).root;
  }
  // 补齐所有没被认领的页签
  const first = collectPanes(root)[0];
  if (first) {
    for (const id of validTabIds) {
      if (!seenTabs.has(id)) {
        first.tabIds.push(id);
        seenTabs.add(id);
      }
    }
  } else {
    root = createPane(validTabIds, validTabIds[0] ?? null);
  }
  root = pruneEmptyPanes(root);
  return { root, changed: JSON.stringify(root) !== before };
}

/* ----------------------------- 预设 → 树 ----------------------------- */

/** 按旧版 reflowGroups 的规则分配页签：前 N 个各占一格，其余留在第一格 */
function distribute(count: number, tabIds: readonly string[]): string[][] {
  if (count <= 1) return [[...tabIds]];
  const heads = tabIds.slice(0, count);
  const buckets = heads.map((id) => [id]);
  for (const id of tabIds.slice(count)) buckets[0].push(id);
  return buckets;
}

function chain(panes: PaneNode[], direction: SplitDirection): LayoutNode {
  const n = panes.length;
  if (n === 1) return panes[0];
  let right: LayoutNode = panes[n - 1];
  for (let i = n - 2; i >= 1; i -= 1) {
    right = createSplit(direction, panes[i], right, 1 / (n - i));
  }
  return createSplit(direction, panes[0], right, 1 / n);
}

/** 把当前 5 个布局预设转换成 Split Tree（页签顺序与活动页签都保留） */
export function presetToTree(preset: PresetId, tabIds: readonly string[]): LayoutNode {
  const count = preset === "single" ? 1 : preset === "grid-2x2" ? 4 : preset === "columns-3" ? 3 : 2;
  const buckets = distribute(count, tabIds);
  const panes = Array.from({ length: count }, (_, i) =>
    createPane(buckets[i] ?? [], (buckets[i] ?? [])[0] ?? null),
  );
  const horizontal = (a: PaneNode, b: PaneNode) => createSplit("horizontal", a, b, 0.5);
  switch (preset) {
    case "single":
      return panes[0];
    case "rows-2":
      return createSplit("vertical", panes[0], panes[1], 0.5);
    case "columns-3":
      return createSplit("horizontal", panes[0], horizontal(panes[1], panes[2]), 1 / 3);
    case "grid-2x2":
      return createSplit(
        "vertical",
        horizontal(panes[0], panes[1]),
        horizontal(panes[2], panes[3]),
        0.5,
      );
    case "columns-2":
    default:
      return horizontal(panes[0], panes[1]);
  }
}

/* ----------------------------- 旧配置迁移 ----------------------------- */

export interface LegacySplit {
  groups: number[][];
  active: (number | null)[];
  focused: number;
  layout: LayoutKind;
}

/**
 * 旧版 tabs.json 的 split 字段 → Split Tree。
 * columns/rows 用等分链，grid 3 格 = 上两格 + 下方通栏、4 格 = 2×2（与旧公式形状一致）。
 * tabIdAt 把持久化的 tabs[] 下标映射成本次启动生成的新 Tab id。
 */
export function legacySplitToTree(
  split: LegacySplit | null | undefined,
  tabCount: number,
  tabIdAt: (index: number) => string | null,
): { root: LayoutNode; focusedPaneId: string } | null {
  if (!split || !Array.isArray(split.groups) || split.groups.length < 2) return null;
  const seen = new Set<number>();
  const groups = split.groups.slice(0, MAX_PANES).map((group) =>
    (Array.isArray(group) ? group : [])
      .filter((index): index is number => Number.isInteger(index) && index >= 0 && index < tabCount)
      .filter((index) => !seen.has(index) && (seen.add(index), true)),
  );
  if (groups.length < 2) return null;

  const panes: PaneNode[] = groups.map((indices, i) => {
    const tabIds = indices.map(tabIdAt).filter((id): id is string => typeof id === "string" && id.length > 0);
    const activeIndex = split.active?.[i];
    const activeId = typeof activeIndex === "number" ? tabIdAt(activeIndex) : null;
    return createPane(tabIds, activeId && tabIds.includes(activeId) ? activeId : (tabIds[0] ?? null));
  });
  // 老文件可能漏了某些页签：一律并进第一个窗格，绝不丢
  for (let index = 0; index < tabCount; index += 1) {
    if (!seen.has(index)) {
      const id = tabIdAt(index);
      if (id) panes[0].tabIds.push(id);
      seen.add(index);
    }
  }
  for (const pane of panes) {
    if (!pane.activeId || !pane.tabIds.includes(pane.activeId)) pane.activeId = pane.tabIds[0] ?? null;
  }

  let root: LayoutNode;
  const layout = split.layout;
  if (layout === "grid" && panes.length === 3) {
    root = createSplit("vertical", createSplit("horizontal", panes[0], panes[1], 0.5), panes[2], 0.5);
  } else if (layout === "grid" && panes.length >= 4) {
    root = createSplit(
      "vertical",
      createSplit("horizontal", panes[0], panes[1], 0.5),
      createSplit("horizontal", panes[2], panes[3], 0.5),
      0.5,
    );
  } else {
    root = chain(panes, layout === "rows" ? "vertical" : "horizontal");
  }
  const focused = Number.isInteger(split.focused)
    ? Math.min(Math.max(split.focused, 0), panes.length - 1)
    : 0;
  return { root, focusedPaneId: panes[focused].id };
}

/* ----------------------------- 持久化 ↔ 内存 ----------------------------- */

/** 内存树（Tab id）→ tabs.json 树（tabs[] 下标） */
export function toPersistedTree(root: LayoutNode, indexOf: (tabId: string) => number): PersistedLayoutNode {
  if (root.type === "pane") {
    const active = root.activeId ? indexOf(root.activeId) : -1;
    return {
      type: "pane",
      id: root.id,
      tabIds: root.tabIds.map(indexOf).filter((index) => index >= 0),
      activeId: active >= 0 ? active : null,
    };
  }
  return {
    type: "split",
    id: root.id,
    direction: root.direction,
    ratio: root.ratio,
    children: [toPersistedTree(root.children[0], indexOf), toPersistedTree(root.children[1], indexOf)],
  };
}

/** tabs.json 树 → 内存树；坏数据在这里先做形状兜底，随后再由 normalizeLayout 全面校验 */
export function fromPersistedTree(
  raw: unknown,
  idAt: (index: number) => string | null,
): LayoutNode {
  const convert = (node: unknown): LayoutNode => {
    if (!isRecord(node)) return createPane();
    if (node.type === "pane") {
      const indices = Array.isArray(node.tabIds) ? node.tabIds : [];
      const tabIds = indices
        .filter((index): index is number => Number.isInteger(index) && Number(index) >= 0)
        .map((index) => idAt(Number(index)))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const activeIndex = node.activeId;
      const activeId = Number.isInteger(activeIndex) ? idAt(Number(activeIndex)) : null;
      return {
        type: "pane",
        id: typeof node.id === "string" && node.id ? node.id : newLayoutId("pane"),
        tabIds,
        activeId: activeId && tabIds.includes(activeId) ? activeId : (tabIds[0] ?? null),
      };
    }
    const list = Array.isArray(node.children) ? node.children : [];
    const children = list.map((child) => convert(child));
    if (children.length === 0) return createPane();
    if (children.length === 1) return children[0];
    const direction: SplitDirection = node.direction === "vertical" ? "vertical" : "horizontal";
    const ratio = clampRatio(typeof node.ratio === "number" ? node.ratio : 1 / children.length);
    let right = children[children.length - 1];
    for (let i = children.length - 2; i >= 1; i -= 1) {
      right = createSplit(direction, children[i], right, 1 / (children.length - i));
    }
    return createSplit(
      direction,
      children[0],
      right,
      ratio,
      typeof node.id === "string" && node.id ? node.id : newLayoutId("split"),
    );
  };
  return convert(raw);
}
