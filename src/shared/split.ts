/**
 * 分屏共享常量、预设与快照类型。
 *
 * 运行时布局已经改为 split-model.ts 的嵌套 Split Tree：computeLayoutRects() 递归算一次，
 * 主进程用它给 WebContentsView.setBounds，渲染层拿同一份 split.rects / split.sashes 画页签条。
 * 下面的 computePaneRects() 是旧版「平面等分」公式，只保留给旧回归用例与兼容参考，
 * 运行时不再调用；paneContentRect() / topRightPaneIndex() 仍是共用的几何小工具。
 * 这里不 import electron / Node API。
 */

import {
  MAX_PANES,
  PANE_GAP,
  TABBAR_HEIGHT,
  type LayoutNode,
  type SashRect,
} from "./split-model.ts";

/** 三个排布方向：等宽列、等高行、2 列宫格 */
export type SplitLayout = "columns" | "rows" | "grid";

/** 用户可直接选择的布局预设 */
export type SplitPreset = "single" | "columns-2" | "rows-2" | "columns-3" | "grid-2x2";

// 常量与新模型统一放在 split-model.ts，这里重导出保持既有 import 路径不变。
export { MAX_PANES, PANE_GAP, TABBAR_HEIGHT } from "./split-model.ts";
export { MIN_PANE_WIDTH, MIN_PANE_HEIGHT, SASH_GAP, SASH_LINE, SASH_HIT_SIZE, LAYOUT_SCHEMA_VERSION } from "./split-model.ts";
export type {
  LayoutNode,
  PaneNode,
  SplitNode,
  SplitDirection,
  LayoutResult,
  SashRect,
  PersistedLayout,
  PersistedLayoutNode,
} from "./split-model.ts";

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitPresetDef {
  id: SplitPreset;
  label: string;
  count: number;
  layout: SplitLayout;
  shortcut: string;
}

/** 菜单 / 按钮下拉里的固定顺序，也是 Ctrl+Alt+1..4 的映射来源 */
export const SPLIT_PRESETS: readonly SplitPresetDef[] = [
  { id: "single", label: "单栏", count: 1, layout: "columns", shortcut: "Ctrl+Alt+1" },
  { id: "columns-2", label: "左右双栏", count: 2, layout: "columns", shortcut: "Ctrl+Alt+2" },
  { id: "rows-2", label: "上下双栏", count: 2, layout: "rows", shortcut: "" },
  { id: "columns-3", label: "三栏", count: 3, layout: "columns", shortcut: "Ctrl+Alt+3" },
  { id: "grid-2x2", label: "四宫格", count: 4, layout: "grid", shortcut: "Ctrl+Alt+4" },
];

export function presetById(id: SplitPreset): SplitPresetDef {
  return SPLIT_PRESETS.find((preset) => preset.id === id) ?? SPLIT_PRESETS[0];
}

/** 从「窗格数 + 排布」反推菜单里该勾哪一项（手动拆出来的布局可能不在预设里） */
export function presetFor(count: number, layout: SplitLayout): SplitPreset | "custom" {
  if (count <= 1) return "single";
  if (count === 2) return layout === "rows" ? "rows-2" : "columns-2";
  if (count === 3) return layout === "columns" ? "columns-3" : "custom";
  if (count === 4) return layout === "grid" ? "grid-2x2" : "custom";
  return "custom";
}

/**
 * 计算每个窗格的外框（含顶部页签条），坐标系 = 整个窗口内容区。
 *
 *  columns: n 个等宽列
 *  rows:    n 个等高行
 *  grid:    2 列；2 格 = 左右两栏，3 格 = 上两格 + 下方通栏，4 格 = 2×2
 *
 * 最后一格吃掉除不尽的余数，保证右边 / 下边不会留缝。
 *
 * 注意：这是 v1 平面布局的公式，只由旧回归（check:split）调用；
 * 运行时请用 split-model.ts 的 computeLayoutRects(root, bounds)。
 */
export function computePaneRects(
  count: number,
  layout: SplitLayout,
  width: number,
  height: number,
): PaneRect[] {
  const n = Math.max(1, Math.min(MAX_PANES, Math.floor(count) || 1));
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const gap = PANE_GAP;

  if (n === 1) return [{ x: 0, y: 0, width: w, height: h }];

  if (layout === "rows") {
    const cellH = Math.max(Math.floor((h - gap * (n - 1)) / n), 1);
    return Array.from({ length: n }, (_, i) => ({
      x: 0,
      y: i * (cellH + gap),
      width: w,
      height: i === n - 1 ? Math.max(h - i * (cellH + gap), 1) : cellH,
    }));
  }

  if (layout === "grid") {
    const leftW = Math.max(Math.floor((w - gap) / 2), 1);
    const rightW = Math.max(w - leftW - gap, 1);
    const topH = Math.max(Math.floor((h - gap) / 2), 1);
    const bottomH = Math.max(h - topH - gap, 1);
    const firstRow: PaneRect[] = [
      { x: 0, y: 0, width: leftW, height: topH },
      { x: leftW + gap, y: 0, width: rightW, height: topH },
    ];
    if (n === 2) return firstRow;
    if (n === 3) return [...firstRow, { x: 0, y: topH + gap, width: w, height: bottomH }];
    return [
      ...firstRow,
      { x: 0, y: topH + gap, width: leftW, height: bottomH },
      { x: leftW + gap, y: topH + gap, width: rightW, height: bottomH },
    ];
  }

  const cellW = Math.max(Math.floor((w - gap * (n - 1)) / n), 1);
  return Array.from({ length: n }, (_, i) => ({
    x: i * (cellW + gap),
    y: 0,
    width: i === n - 1 ? Math.max(w - i * (cellW + gap), 1) : cellW,
    height: h,
  }));
}

/** 窗格里真正放 WebContentsView 的区域 = 外框去掉顶部那条页签条 */
export function paneContentRect(rect: PaneRect): PaneRect {
  return {
    x: rect.x,
    y: rect.y + TABBAR_HEIGHT,
    width: rect.width,
    height: Math.max(rect.height - TABBAR_HEIGHT, 1),
  };
}

/** 顶部一行里最右边的窗格：只有它需要给 WCO 窗口控件 / 工具按钮让位 */
export function topRightPaneIndex(rects: PaneRect[]): number {
  if (rects.length === 0) return -1;
  const minY = Math.min(...rects.map((rect) => rect.y));
  let index = 0;
  let bestX = -1;
  rects.forEach((rect, i) => {
    if (rect.y === minY && rect.x >= bestX) {
      bestX = rect.x;
      index = i;
    }
  });
  return index;
}

/** 一个窗格（编辑器组）：它拥有的页签 + 当前显示的那个 */
export interface SplitGroupSnapshot {
  tabIds: string[];
  activeId: string | null;
}

/** 渲染进程需要的分屏状态 */
export interface SplitSnapshot {
  /** 长度 = 窗格数；1 = 没分屏（此时渲染层走原来的单条页签栏）
   *  顺序 = Split Tree 的 DFS 顺序，与 paneIds / rects / sashes 一致 */
  groups: SplitGroupSnapshot[];
  /** 当前获得焦点的窗格下标 */
  focused: number;
  layout: SplitLayout;
  /** 菜单里该勾哪一项；手动拆出来的布局显示 custom */
  preset: SplitPreset | "custom";
  /** 每个窗格的外框，由主进程算好直接给渲染层用（避免两边 DIP 计算有偏差） */
  rects: PaneRect[];
  /* ---- Split Tree（主进程算好一次，渲染层原样使用，不另算一套） ---- */
  /** 稳定的窗格 id，与 groups / rects 同序；不再用数组下标当 id */
  paneIds: string[];
  /** 当前聚焦窗格的稳定 id */
  focusedPaneId: string;
  /** 完整布局树（供预览 / 分隔条渲染；序列化友好） */
  tree: LayoutNode;
  /** 每个 SplitNode 一条分隔条，M2 起由渲染层画出来 */
  sashes: SashRect[];
}
