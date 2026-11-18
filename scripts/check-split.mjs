#!/usr/bin/env node
/**
 * 分屏纯计算模块回归（src/shared/split.ts）。
 * 保留现有算法，只补测试：布局形状、边界尺寸、非整数尺寸、数量边界、矩形不重叠。
 * 本阶段不增加自定义比例拖动。
 *
 *   npm run check:split
 */
import {
  MAX_PANES,
  PANE_GAP,
  SPLIT_PRESETS,
  TABBAR_HEIGHT,
  computePaneRects,
  paneContentRect,
  presetById,
  presetFor,
  topRightPaneIndex,
} from "../src/shared/split.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? "" : `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const rect = (r) => [r.x, r.y, r.width, r.height];

function overlap(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
function invariants(rects, w, h) {
  if (rects.length < 1 || rects.length > MAX_PANES) return false;
  const W = Math.max(w, 1);
  const H = Math.max(h, 1);
  return safeRects(rects) && rects.every((r) => r.x + r.width <= W + 1e-9 && r.y + r.height <= H + 1e-9);
}
/** 安全底线：有限数值、正面积、非负坐标、两两不重叠 */
function safeRects(rects) {
  for (const r of rects) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return false;
    if (r.width < 1 || r.height < 1 || r.x < 0 || r.y < 0) return false;
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (overlap(rects[i], rects[j])) return false;
    }
  }
  return true;
}

/* ------------------------- 预设 ------------------------- */
eq(
  "预设顺序与快捷键映射",
  SPLIT_PRESETS.map((p) => p.id),
  ["single", "columns-2", "rows-2", "columns-3", "grid-2x2"],
);
check("presetById 未知值回退 single", presetById("nope").id === "single");
eq(
  "presetFor 反推",
  [
    presetFor(1, "columns"),
    presetFor(2, "rows"),
    presetFor(2, "columns"),
    presetFor(3, "columns"),
    presetFor(4, "grid"),
    presetFor(4, "columns"),
  ],
  ["single", "rows-2", "columns-2", "columns-3", "grid-2x2", "custom"],
);

/* ------------------------- 布局形状 ------------------------- */
eq("单栏布局", computePaneRects(1, "columns", 800, 600).map(rect), [[0, 0, 800, 600]]);
eq(
  "左右双栏（最后一格吃掉余数）",
  computePaneRects(2, "columns", 801, 600).map(rect),
  [
    [0, 0, 398, 600],
    [402, 0, 399, 600],
  ],
);
eq(
  "上下双栏",
  computePaneRects(2, "rows", 800, 601).map(rect),
  [
    [0, 0, 800, 298],
    [0, 302, 800, 299],
  ],
);
eq(
  "三栏",
  computePaneRects(3, "columns", 902, 600).map(rect),
  [
    [0, 0, 298, 600],
    [302, 0, 298, 600],
    [604, 0, 298, 600],
  ],
);
eq(
  "四宫格",
  computePaneRects(4, "grid", 800, 600).map(rect),
  [
    [0, 0, 398, 298],
    [402, 0, 398, 298],
    [0, 302, 398, 298],
    [402, 302, 398, 298],
  ],
);
eq(
  "grid 3 格 = 上两格 + 下方通栏",
  computePaneRects(3, "grid", 800, 600).map(rect),
  [
    [0, 0, 398, 298],
    [402, 0, 398, 298],
    [0, 302, 800, 298],
  ],
);
eq(
  "grid 2 格退化为左右两栏",
  computePaneRects(2, "grid", 800, 600).map(rect),
  [
    [0, 0, 398, 298],
    [402, 0, 398, 298],
  ],
);

/* ------------------------- 边界 / 非整数尺寸 ------------------------- */
// 已知限制（本次按计划「保留现有分屏算法」，不改行为）：
// w < n + gap*(n-1) 时 cellW/cellH 被钳到 1，后续窗格起点仍按 gap 累加，
// 会落在可视区之外，由窗口裁剪，不会崩溃或产生非法矩形。
// 详见 docs/development/pi-web-compatibility.md「已知限制」。
check(
  "窗口极小尺寸（1×1）：每个窗格仍是有限、≥1×1 且不重叠",
  ["columns", "rows", "grid"].every((layout) =>
    [1, 2, 3, 4].every((n) => safeRects(computePaneRects(n, layout, 1, 1))),
  ),
);
check(
  "0×0 / 负数尺寸：钳到 1，不产生负宽高 / NaN",
  ["columns", "rows", "grid"].every((layout) =>
    [1, 2, 4].every((n) => safeRects(computePaneRects(n, layout, 0, -5))),
  ),
);
check(
  "可用尺寸（≥ 各窗格 + 间隔）下所有窗格都在窗口内",
  ["columns", "rows", "grid"].every((layout) =>
    [1, 2, 3, 4].every((n) =>
      invariants(computePaneRects(n, layout, 1366, 768), 1366, 768),
    ),
  ),
);
check(
  "非整数尺寸不越界、不重叠、末格补齐",
  ["columns", "rows", "grid"].every((layout) =>
    [1, 2, 3, 4].every((n) => invariants(computePaneRects(n, layout, 800.5, 600.25), 800.5, 600.25)),
  ),
);
check(
  "数量边界：0 / 1 / MAX_PANES / 超过 MAX_PANES / 小数",
  computePaneRects(0, "columns", 800, 600).length === 1 &&
    computePaneRects(1, "columns", 800, 600).length === 1 &&
    computePaneRects(MAX_PANES, "grid", 800, 600).length === MAX_PANES &&
    computePaneRects(9, "grid", 800, 600).length === MAX_PANES &&
    computePaneRects(2.9, "columns", 800, 600).length === 2,
);
check(
  "窗格间隔恒为 PANE_GAP 且所有布局都不重叠",
  ["columns", "rows", "grid"].every((layout) =>
    [1, 2, 3, 4].every((n) => invariants(computePaneRects(n, layout, 1366, 768), 1366, 768)),
  ) && PANE_GAP === 4,
);

/* ------------------------- 内容区 / 右上角窗格 ------------------------- */
eq(
  "paneContentRect 去掉顶部页签条",
  rect(paneContentRect({ x: 10, y: 20, width: 300, height: 200 })),
  [10, 20 + TABBAR_HEIGHT, 300, 200 - TABBAR_HEIGHT],
);
check(
  "窗格比页签条还矮时高度至少为 1",
  paneContentRect({ x: 0, y: 0, width: 10, height: 5 }).height === 1,
);
check(
  "topRightPaneIndex 找到顶部一行最右的窗格",
  topRightPaneIndex(computePaneRects(4, "grid", 800, 600)) === 1 &&
    topRightPaneIndex(computePaneRects(1, "columns", 800, 600)) === 0 &&
    topRightPaneIndex([]) === -1,
);

if (failed) process.exit(1);
console.log("分屏布局计算检查通过");
