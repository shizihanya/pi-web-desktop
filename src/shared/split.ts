/**
 * 分屏布局的纯计算与共享常量。
 *
 * 模型（对齐 VSCode 的「编辑器组」）：
 *   一个窗格 = 顶部一条自己的页签条（TABBAR_HEIGHT）+ 下面的内容区。
 *   单栏时只有 1 个窗格，页签条在窗口顶部、内容区从 y=40 开始 —— 和分屏前完全一样。
 *
 * 主进程用它给 WebContentsView.setBounds，页签栏渲染进程用它给每条页签条定位，
 * 两边共用同一套公式，避免像素对不上。这里不 import electron / Node API。
 */

/** 三个排布方向：等宽列、等高行、2 列宫格 */
export type SplitLayout = "columns" | "rows" | "grid";

/** 用户可直接选择的布局预设 */
export type SplitPreset = "single" | "columns-2" | "rows-2" | "columns-3" | "grid-2x2";

/** 页签条高度（必须与 src/main/titlebar.ts 的 TITLEBAR_HEIGHT 一致） */
export const TABBAR_HEIGHT = 40;
/** 窗格之间留出的间隔（露出窗口底色，像一条细分隔线） */
export const PANE_GAP = 4;
/** 一个 pi-web 页面已经比较吃宽度，最多 4 格 */
export const MAX_PANES = 4;

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
  /** 长度 = 窗格数；1 = 没分屏（此时渲染层走原来的单条页签栏） */
  groups: SplitGroupSnapshot[];
  /** 当前获得焦点的窗格下标 */
  focused: number;
  layout: SplitLayout;
  /** 菜单里该勾哪一项；手动拆出来的布局显示 custom */
  preset: SplitPreset | "custom";
  /** 每个窗格的外框，由主进程算好直接给渲染层用（避免两边 DIP 计算有偏差） */
  rects: PaneRect[];
}
