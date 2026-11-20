#!/usr/bin/env node
/**
 * Split Tree 纯数据回归（里程碑一）。
 *
 * 覆盖：创建 / 左右拆分 / 上下拆分 / 嵌套拆分 / 比例计算 / 拆分限制 /
 *       移动 Tab / 合并 Pane / 删除空 Pane / 折叠单子节点 / 无效树恢复 / 旧配置迁移。
 * 全部只读纯模块 + 临时目录里的 tabs.json，不启动 Electron、不连网、不改上游。
 *
 *   npm run check:split-model
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAYOUT_SCHEMA_VERSION,
  MAX_PANES,
  PANE_GAP,
  SASH_GAP,
  SASH_LINE,
  MIN_PANE_WIDTH,
  MIN_PANE_HEIGHT,
  addEdgePane,
  canSplit,
  clampRatioForBounds,
  cloneTree,
  collectPanes,
  collectSplits,
  computeLayoutRects,
  createPane,
  createSplit,
  findPane,
  fromPersistedTree,
  layoutKind,
  layoutSignature,
  legacySplitToTree,
  mergePanes,
  moveTab,
  normalizeLayout,
  paneCount,
  presetToTree,
  pruneEmptyPanes,
  ratioFromPointer,
  removePane,
  setRatio,
  splitPane,
  toPersistedTree,
} from "../src/shared/split-model.ts";
import { toPersistedTabs } from "../src/main/tabs/tab-model.ts";
import { loadTabs, saveTabs } from "../src/main/tabs/tab-persistence.ts";

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
const bounds = (w = 1440, h = 900) => ({ x: 0, y: 0, width: w, height: h });

function overlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function validRects(root, b = bounds()) {
  const result = computeLayoutRects(root, b);
  const rects = result.panes.map((p) => p.rect);
  for (const r of rects) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return false;
    if (r.width < 1 || r.height < 1 || r.x < 0 || r.y < 0) return false;
    if (r.x + r.width > b.width + 1e-6 || r.y + r.height > b.height + 1e-6) return false;
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) if (overlap(rects[i], rects[j])) return false;
  }
  return true;
}
const allTabIds = (root) => collectPanes(root).flatMap((p) => p.tabIds);
const sortedIds = (ids) => [...ids].sort().join(",");

/* ------------------------- 创建 / 稳定 ID ------------------------- */
{
  const pane = createPane(["t1", "t2"], "t2");
  check("createPane 保留页签顺序与活动页签", pane.tabIds.join(",") === "t1,t2" && pane.activeId === "t2");
  check("Pane id 不是数组下标", !/^\d+$/.test(pane.id) && pane.id.startsWith("pane-"));
  const ids = new Set(Array.from({ length: 50 }, () => createPane().id));
  check("50 个 Pane id 互不重复", ids.size === 50, String(ids.size));
  const split = createSplit("horizontal", createPane(), createPane(), 2);
  check("createSplit 钳制越界 ratio", split.ratio <= 0.95 && split.direction === "horizontal");
  const clone = cloneTree(split);
  check("cloneTree 深拷贝：改副本不影响原树", clone !== split && clone.children[0] !== split.children[0]);
  clone.children[0].tabIds.push("x");
  check("cloneTree 深拷贝：页签数组也独立", split.children[0].tabIds.length === 0);
}

/* ------------------------- 左右 / 上下拆分 ------------------------- */
{
  const root = createPane(["a", "b"], "a");
  const result = splitPane(root, root.id, "horizontal", "after", { newPaneId: "pane-right" });
  check("splitPane 返回新树且不改动入参", result.changed && result.root !== root && paneCount(root) === 1);
  check("左右拆分后 2 个 Pane，id 稳定且不是下标", paneCount(result.root) === 2 && collectPanes(result.root)[0].id === root.id);
  eq(
    "左右拆分：两个子区域等宽、中间扣掉 SASH_GAP",
    computeLayoutRects(result.root, bounds()).panes.map((p) => rect(p.rect)),
    [
      [0, 0, 716, 900],
      [724, 0, 716, 900],
    ],
  );
  const sashes = computeLayoutRects(result.root, bounds()).sashes;
  check("每个 SplitNode 恰好一条分隔条", sashes.length === 1 && sashes[0].id === collectSplits(result.root)[0].id);
  eq("分隔条位置 / 尺寸", rect(sashes[0]).slice(0, 3).concat(sashes[0].height), [716, 0, SASH_GAP, 900]);
  check("拆分后矩形合法、不重叠、不越界", validRects(result.root));
}
{
  const root = createPane(["a"], "a");
  const result = splitPane(root, root.id, "vertical");
  eq(
    "上下拆分：两个子区域等高、中间扣掉 SASH_GAP",
    computeLayoutRects(result.root, bounds()).panes.map((p) => rect(p.rect)),
    [
      [0, 0, 1440, 446],
      [0, 454, 1440, 446],
    ],
  );
  check("上下拆分 layoutKind = rows", layoutKind(result.root) === "rows");
}
{
  const root = createPane(["a"], "a");
  const horizontal = splitPane(root, root.id, "horizontal");
  check("左右拆分 layoutKind = columns", layoutKind(horizontal.root) === "columns");
}

/* ------------------------- 嵌套拆分（左一右二 / 左二右一） ------------------------- */
{
  const two = splitPane(createPane(["a", "b"], "a"), "none", "horizontal").root; // 无效目标应原样返回
  check("目标 Pane 不存在时 splitPane 不产生坏树", paneCount(two) === 1);

  const base = createPane(["a"], "a");
  const first = splitPane(base, base.id, "horizontal", "after", { newPaneId: "pane-right" }).root;
  const nested = splitPane(first, "pane-right", "vertical", "after", { newPaneId: "pane-right-bottom" });
  check("嵌套拆分：3 个 Pane，方向混合 → grid", paneCount(nested.root) === 3 && layoutKind(nested.root) === "grid");
  eq(
    "左一右二：左侧通栏，右侧上下两格",
    computeLayoutRects(nested.root, bounds()).panes.map((p) => rect(p.rect)),
    [
      [0, 0, 716, 900],
      [724, 0, 716, 446],
      [724, 454, 716, 446],
    ],
  );
  check("嵌套拆分：每个 SplitNode 独立一条分隔条", computeLayoutRects(nested.root, bounds()).sashes.length === 2);
  check("嵌套拆分矩形不重叠", validRects(nested.root));

  // 左二右一：在上下双栏的右边再套一层水平分割
  const rowBase = createPane(["a", "b"], "a");
  const rowsSplit = splitPane(rowBase, rowBase.id, "vertical").root;
  check("上下双栏构造成功", paneCount(rowsSplit) === 2 && collectPanes(rowsSplit)[0].id === rowBase.id);
  const right = addEdgePane(rowsSplit, "right", { newPaneId: "pane-outer-right" });
  check("左二右一：3 个 Pane 且新窗格在最右", paneCount(right.root) === 3 && right.changed);
  const rightRects = computeLayoutRects(right.root, bounds()).panes;
  check("新窗格 x 最大（在外侧）", rightRects[2].rect.x > rightRects[0].rect.x, JSON.stringify(rightRects.map((p) => rect(p.rect))));
  check("外侧新增窗格后矩形合法", validRects(right.root));

  const leftEdge = addEdgePane(rowsSplit, "left", { newPaneId: "pane-outer-left" });
  const leftRects = computeLayoutRects(leftEdge.root, bounds()).panes;
  check("拖到最左：新窗格 x 最小", leftRects[0].rect.x < leftRects[1].rect.x);
  check("拖到最左后矩形合法", validRects(leftEdge.root));
}

/* ------------------------- 比例计算 / 最小尺寸 ------------------------- */
{
  const base = createPane(["a"], "a");
  const split = splitPane(base, base.id, "horizontal", "after", { newPaneId: "p2" }).root;
  const splitId = collectSplits(split)[0].id;
  const changed = setRatio(split, splitId, 0.25);
  const rects = computeLayoutRects(changed.root, bounds()).panes.map((p) => p.rect);
  check("ratio=0.25 时第一个子区域被最小宽度钳住", rects[0].width >= MIN_PANE_WIDTH && rects[0].width < 500, String(rects[0].width));
  check("调整一个 ratio 不改变其它 SplitNode 的 ratio（只有 1 个时恒等）", changed.root.ratio === 0.25);
  check("ratio 变化后 layoutSignature 变化", layoutSignature(changed.root) !== layoutSignature(split));

  const nested = splitPane(changed.root, "p2", "vertical").root;
  const inner = collectSplits(nested).find((s) => s.id !== splitId);
  const before = computeLayoutRects(nested, bounds()).sashes.map((s) => s.id).join("|");
  const withInner = setRatio(nested, inner.id, 0.2);
  check("嵌套布局里改内层 ratio，外层 ratio 保持不变", findSplitRatio(withInner.root, splitId) === 0.25);
  check("分隔条集合不因 ratio 改变而增删", computeLayoutRects(withInner.root, bounds()).sashes.map((s) => s.id).join("|") === before);
  check("比例计算结果仍不重叠 / 不越界", validRects(withInner.root));

  const clamped = clampRatioForBounds(changed.root, splitId, 0.01, bounds());
  check("clampRatioForBounds 保证两侧都满足最小尺寸", clamped >= MIN_PANE_WIDTH / (1440 - SASH_GAP));
  check("非整数窗口尺寸下矩形仍有限 / 不重叠", validRects(nested, bounds(800.5, 600.25)));
  check("极小窗口不产生 NaN / 负面积", validRects(nested, bounds(1, 1)) === false || safeTiny(nested));

  const sigBefore = layoutSignature(split);
  split.children[0].tabIds.push("later");
  check("页签增减不改几何签名（布局缓存只认结构 / ratio）", layoutSignature(split) === sigBefore);
  check("canSplit 在 4 个 Pane 时拒绝", !canSplit(presetToTree("grid-2x2", ["a", "b", "c", "d"]), bounds(), collectPanes(presetToTree("grid-2x2", ["a", "b", "c", "d"]))[0].id, "horizontal"));
}
function findSplitRatio(root, id) {
  return collectSplits(root).find((s) => s.id === id)?.ratio ?? null;
}
function safeTiny(root) {
  return computeLayoutRects(root, bounds(1, 1)).panes.every((p) =>
    [p.rect.x, p.rect.y, p.rect.width, p.rect.height].every(Number.isFinite) && p.rect.width >= 1 && p.rect.height >= 1,
  );
}

/* ------------------------- 拆分限制 ------------------------- */
{
  const four = presetToTree("grid-2x2", ["a", "b", "c", "d"]);
  const first = collectPanes(four)[0];
  const denied = splitPane(four, first.id, "horizontal");
  check("已有 4 个 Pane 时 splitPane 被拒绝", !denied.changed && denied.root === four && paneCount(four) === MAX_PANES);
  const edge = addEdgePane(four, "left");
  check("已有 4 个 Pane 时 addEdgePane 被拒绝", !edge.changed && edge.root === four);

  // 手工造 6 个 Pane 的坏树：恢复时必须收敛到 4 个且一个页签都不丢
  const chain = ["a", "b", "c", "d", "e", "f"]
    .map((id) => createPane([id], id))
    .reduceRight((right, pane) => (right ? createSplit("horizontal", pane, right, 0.5) : pane), null);
  const recovered = normalizeLayout(chain, ["a", "b", "c", "d", "e", "f"]);
  check("无效树（6 窗格）恢复后不超过 MAX_PANES", paneCount(recovered.root) <= MAX_PANES, String(paneCount(recovered.root)));
  eq("恢复时多余窗格的页签全部合并保留", sortedIds(allTabIds(recovered.root)), "a,b,c,d,e,f");
}

/* ------------------------- 移动 Tab / 合并 / 删除空 Pane ------------------------- */
{
  const left = createPane(["a", "b"], "a");
  const right = createPane(["c"], "c");
  const root = createSplit("horizontal", left, right, 0.5);
  const moved = moveTab(root, "a", right.id, 0);
  const panes = collectPanes(moved.root);
  check("跨 Pane 移动 Tab：源窗格保留剩余页签", panes[0].tabIds.join(",") === "b");
  eq("跨 Pane 移动 Tab：按 insertIndex 插入且成为活动页签", panes[1].tabIds, ["a", "c"]);
  check("移动后活动页签指向被移动的 Tab", panes[1].activeId === "a");
  eq("同一个 Tab 全局只出现一次", allTabIds(moved.root).filter((id) => id === "a"), ["a"]);
  check("moveTab 不改动入参", root.children[0].tabIds.join(",") === "a,b");

  const three = createSplit(
    "horizontal",
    createPane(["a"], "a"),
    createSplit("horizontal", createPane(["b"], "b"), createPane(["c"], "c"), 0.5),
    1 / 3,
  );
  const onePane = collectPanes(three)[0];
  const collapsed = moveTab(three, "b", onePane.id);
  check("移走最后一个 Tab 时源 Pane 自动合并（Collapse）", paneCount(collapsed.root) === 2);
  eq("合并后所有 Tab 仍在", sortedIds(allTabIds(collapsed.root)), "a,b,c");
  check("Collapse 后树里没有单子节点", collectSplits(collapsed.root).every((s) => s.children.length === 2));

  const merged = mergePanes(three, collectPanes(three)[1].id, onePane.id);
  check("mergePanes：窗格数减一、页签并入目标", paneCount(merged.root) === 2 && allTabIds(merged.root).includes("b"));

  const empty = createSplit("horizontal", createPane(["a"], "a"), createPane([], null), 0.5);
  const pruned = pruneEmptyPanes(empty);
  check("删除空 Pane 后回到普通单窗格", paneCount(pruned) === 1 && pruned.type === "pane");

  const removed = removePane(three, collectPanes(three)[2].id);
  check("removePane 把页签合并到相邻窗格", paneCount(removed.root) === 2 && removed.mergedIntoId !== null);
  eq("removePane 不丢页签", sortedIds(allTabIds(removed.root)), "a,b,c");
}

/* ------------------------- 折叠单子节点 / 无效树恢复 ------------------------- */
{
  const singleChild = { type: "split", id: "s1", direction: "horizontal", ratio: 0.5, children: [createPane(["a"], "a")] };
  const normalized = normalizeLayout(singleChild, ["a"]);
  check("单子节点 SplitNode 被自动提升为 Pane", normalized.root.type === "pane" && normalized.changed);
  check("提升后页签不丢", allTabIds(normalized.root).join(",") === "a");

  const broken = {
    type: "split",
    id: "dup",
    direction: "sideways",
    ratio: Number.NaN,
    children: [
      { type: "pane", id: "dup", tabIds: ["a", "ghost", "a"], activeId: "ghost" },
      { type: "split", id: "dup", direction: "vertical", ratio: 5, children: [] },
      { type: "pane", id: "p3", tabIds: [null, "b"], activeId: 42 },
    ],
  };
  const fixed = normalizeLayout(broken, ["a", "b", "c"]);
  check("坏树恢复：每个节点都是合法 Pane / Split", collectSplits(fixed.root).every((s) => s.children.length === 2));
  const ids = [...collectPanes(fixed.root).map((p) => p.id), ...collectSplits(fixed.root).map((s) => s.id)];
  check("坏树恢复：id 去重、无下标 id", new Set(ids).size === ids.length && ids.every((id) => !/^\d+$/.test(id)), JSON.stringify(ids));
  check("坏树恢复：ratio 有限且在合法区间", collectSplits(fixed.root).every((s) => Number.isFinite(s.ratio) && s.ratio >= 0.05 && s.ratio <= 0.95));
  eq("坏树恢复：无效引用被删、丢失的页签被补回、全局不重复", sortedIds(allTabIds(fixed.root)), "a,b,c");
  check("坏树恢复：activeId 指向自己窗格内的页签", collectPanes(fixed.root).every((p) => p.activeId === null || p.tabIds.includes(p.activeId)));
  check("坏树恢复：null 输入不崩、不丢页签", paneCount(normalizeLayout(null, ["x", "y"]).root) === 1 && sortedIds(allTabIds(normalizeLayout(null, ["x", "y"]).root)) === "x,y");
  check("坏树恢复后布局计算仍然合法", validRects(fixed.root));
}

/* ------------------------- 预设 → Split Tree ------------------------- */
{
  const expected = [
    ["single", 1, "columns"],
    ["columns-2", 2, "columns"],
    ["rows-2", 2, "rows"],
    ["columns-3", 3, "columns"],
    ["grid-2x2", 4, "grid"],
  ];
  for (const [preset, count, kind] of expected) {
    const root = presetToTree(preset, ["a", "b", "c", "d"]);
    check(`预设 ${preset}：${count} 个 Pane / ${kind}`, paneCount(root) === count && layoutKind(root) === kind);
    const layout = computeLayoutRects(root, bounds());
    check(`预设 ${preset}：窗格 id 顺序与 DFS 一致`, layout.panes.map((p) => p.id).join(",") === collectPanes(root).map((p) => p.id).join(","));
    check(`预设 ${preset}：sash 数 = SplitNode 数`, layout.sashes.length === collectSplits(root).length);
    check(`预设 ${preset}：矩形不重叠 / 不越界`, validRects(root));
    eq(`预设 ${preset}：页签全部保留`, sortedIds(allTabIds(root)), "a,b,c,d");
  }
  const three = presetToTree("columns-3", ["a", "b", "c", "d"]);
  eq("三栏：前 3 个页签各占一格，其余留在第一格", collectPanes(three).map((p) => p.tabIds.join("")), ["ad", "b", "c"]);
  const single = presetToTree("single", ["a", "b", "c"]);
  check("单栏：只有一个 Pane、所有页签都在里面", single.type === "pane" && single.tabIds.length === 3);
}

/* ------------------------- 旧版 tabs.json 迁移 ------------------------- */
{
  const idAt = (i) => `t${i}`;
  const legacy = (layout, groups, active, focused) => ({ groups, active, focused, layout });
  const cases = [
    ["columns 2 格", legacy("columns", [[0], [1]], [0, 1], 1), 2, "columns"],
    ["rows 2 格", legacy("rows", [[0], [1]], [0, 1], 0), 2, "rows"],
    ["columns 3 格", legacy("columns", [[0], [1], [2]], [0, 1, 2], 2), 3, "columns"],
    ["grid 3 格", legacy("grid", [[0], [1], [2]], [0, 1, 2], 2), 3, "grid"],
    ["grid 4 格", legacy("grid", [[0, 1], [2], [3], []], [1, 2, 3, null], 2), 4, "grid"],
  ];
  for (const [label, split, count, kind] of cases) {
    const migrated = legacySplitToTree(split, 4, idAt);
    check(`旧配置迁移 ${label}：${count} 个 Pane / ${kind}`, Boolean(migrated) && paneCount(migrated.root) === count && layoutKind(migrated.root) === kind);
    if (migrated) {
      eq(`旧配置迁移 ${label}：页签不丢`, sortedIds(allTabIds(migrated.root)), "t0,t1,t2,t3");
      check(`旧配置迁移 ${label}：focusedPaneId 对应原 focused`, migrated.focusedPaneId === collectPanes(migrated.root)[split.focused]?.id);
    }
  }
  const grid3 = legacySplitToTree(legacy("grid", [[0], [1], [2]], [0, 1, 2], 0), 3, idAt);
  check("grid 3 格形状 = 上两格 + 下方通栏", grid3.root.type === "split" && grid3.root.direction === "vertical" && grid3.root.children[0].type === "split");
  const active = legacySplitToTree(legacy("columns", [[0, 2], [1]], [2, 1], 0), 3, idAt);
  eq("旧配置迁移保留组内页签顺序", collectPanes(active.root)[0].tabIds, ["t0", "t2"]);
  check("旧配置迁移保留活动页签", collectPanes(active.root)[0].activeId === "t2");
  check("单栏旧配置不生成树（保持普通单栏）", legacySplitToTree(legacy("columns", [[0, 1]], [0], 0), 2, idAt) === null);
  check("缺失 / 坏 split 返回 null 而不是崩溃", legacySplitToTree(null, 2, idAt) === null && legacySplitToTree({ groups: "bad" }, 2, idAt) === null);

  // 越界下标 / 漏掉的页签：迁移 + 校验后一个都不能丢
  const dirty = legacySplitToTree(legacy("columns", [[99, 0], [-1, 2]], [0, 2], 0), 3, idAt);
  const cleaned = normalizeLayout(dirty.root, ["t0", "t1", "t2"]);
  eq("越界下标被丢弃、漏掉的页签被补回", sortedIds(allTabIds(cleaned.root)), "t0,t1,t2");
}

/* ------------------------- v2 持久化往返 / 降级 / 安全降级 ------------------------- */
{
  const dir = mkdtempSync(join(tmpdir(), "pi-web-desktop-split-model-"));
  try {
    const tabs = [
      { id: "a", path: "/", title: "A", pinned: false },
      { id: "b", path: "/?session=b", title: "B", pinned: true },
      { id: "c", path: "/?cwd=c", title: "C", pinned: false },
    ];
    const base = presetToTree("columns-2", ["a", "b", "c"]);
    const rightPane = collectPanes(base)[1];
    const nested = splitPane(base, rightPane.id, "vertical", "after", { newPaneId: "pane-nested" }).root;
    const persisted = toPersistedTabs({
      tabs,
      activeId: "b",
      groups: collectPanes(nested).map((p) => ({ tabIds: p.tabIds, activeId: p.activeId })),
      focused: 1,
      layout: layoutKind(nested),
      tree: nested,
      focusedPaneId: collectPanes(nested)[1].id,
    });
    check("toPersistedTabs 写 v2 版本号", persisted.version === LAYOUT_SCHEMA_VERSION);
    check("v2 同时保留旧 split 镜像（老版本 app 降级可读）", Array.isArray(persisted.split.groups));
    check("持久化树用 tabs[] 下标而不是运行时 id", JSON.stringify(persisted.layout.root).includes('"activeId":1'));

    saveTabs(dir, persisted);
    const loaded = loadTabs(dir);
    check("saveTabs/loadTabs 往返：version / layout / split 都在", loaded.version === LAYOUT_SCHEMA_VERSION && Boolean(loaded.layout) && Boolean(loaded.split));
    const restored = fromPersistedTree(loaded.layout.root, (i) => tabs[i]?.id ?? null);
    eq("往返后树结构与页签归属一致", collectPanes(restored).map((p) => p.tabIds.join("")), collectPanes(nested).map((p) => p.tabIds.join("")));
    eq("往返后 pane id / ratio / direction 不变", collectSplits(restored).map((s) => [s.id, s.direction, s.ratio]), collectSplits(nested).map((s) => [s.id, s.direction, s.ratio]));
    eq("往返后聚焦窗格 id 不变", loaded.layout.focusedPaneId, collectPanes(nested)[1].id);
    check("往返后布局计算仍合法", validRects(restored));

    // 用旧版 loader 的视角：只认 split 字段也能恢复
    const v1 = { version: 1, activeIndex: 0, tabs: tabs.map((t) => ({ path: t.path, title: t.title, pinned: t.pinned })), split: persisted.split };
    saveTabs(dir, v1);
    const legacyLoaded = loadTabs(dir);
    check("v1 文件照常读出 groups / focused / layout", legacyLoaded.split.groups.length === 3 && legacyLoaded.split.focused === 1);
    const migrated = legacySplitToTree(legacyLoaded.split, tabs.length, (i) => tabs[i].id);
    eq("v1 → Split Tree 迁移后页签全部保留", sortedIds(allTabIds(migrated.root)), "a,b,c");
    check("迁移结果通过 normalizeLayout 校验", validRects(normalizeLayout(migrated.root, tabs.map((t) => t.id)).root));

    // 无法识别的新结构 + 仍可用的旧镜像 → 安全走旧路径
    saveTabs(dir, { ...persisted, layout: { version: 99, root: { nonsense: true }, focusedPaneId: "" } });
    const fallback = loadTabs(dir);
    check("未知 layout 版本被忽略，旧 split 仍可用于迁移", !fallback.layout && Boolean(fallback.split) && Boolean(legacySplitToTree(fallback.split, tabs.length, (i) => tabs[i].id)));

    // 三者全坏：JSON 损坏 → loadTabs 返回 null，TabManager 会退到单 Pane（不丢页签）
    writeFileSync(join(dir, "tabs.json"), "{ broken", "utf8");
    check("tabs.json 损坏时安全降级（返回 null）", loadTabs(dir) === null);
    const safe = normalizeLayout(null, tabs.map((t) => t.id));
    check("安全降级：单 Pane 收纳全部页签", paneCount(safe.root) === 1 && sortedIds(allTabIds(safe.root)) === "a,b,c");

    // 老调用方（没有 tree）仍然输出 v1
    const old = toPersistedTabs({
      tabs,
      activeId: "a",
      groups: [{ tabIds: ["a", "b"], activeId: "a" }, { tabIds: ["c"], activeId: "c" }],
      focused: 1,
      layout: "columns",
    });
    check("没有 tree 时 toPersistedTabs 仍输出 v1 平面结构", old.version === 1 && !old.layout && old.split.groups.length === 2);
    saveTabs(dir, old);
    check("v1 结构仍能被 loadTabs 读出", loadTabs(dir).split.groups.length === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------- 分隔条拖动（M2 纯逻辑） ------------------------- */
{
  check("两个 gap 分离：旧公式 4px / 新布局 8px 命中区 / 视觉线 2px", PANE_GAP === 4 && SASH_GAP === 8 && SASH_LINE === 2);
  const base = presetToTree("grid-2x2", ["a", "b", "c", "d"]);
  const [rootSplit, topSplit, bottomSplit] = collectSplits(base);
  check("四宫格 = 1 个根 + 2 个内层 SplitNode，各自可独立调比例", collectSplits(base).length === 3 && rootSplit.direction === "vertical" && topSplit.direction === "horizontal");
  const b = bounds();

  // 主进程按同一份布局结果换算 ratio：vertical 用 y，horizontal 用 x
  const rRoot = ratioFromPointer(base, rootSplit.id, b, 700, 300);
  check("ratioFromPointer：vertical 分隔条按 y 换算", rRoot !== null && Math.abs(rRoot - 300 / (900 - SASH_GAP)) < 0.02, String(rRoot));
  const rTop = ratioFromPointer(base, topSplit.id, b, 300, 100);
  check("ratioFromPointer：内层 horizontal 按 x 换算且被最小宽度钳住", rTop !== null && rTop >= MIN_PANE_WIDTH / (1440 - SASH_GAP) && rTop < 0.4, String(rTop));
  check("无效 splitId 返回 null", ratioFromPointer(base, "nope", b, 1, 1) === null);

  const step1 = setRatio(base, rootSplit.id, rRoot).root;
  check("改根 ratio：两个内层 ratio 保持原值", findSplitRatio(step1, topSplit.id) === topSplit.ratio && findSplitRatio(step1, bottomSplit.id) === bottomSplit.ratio);
  const step2 = setRatio(step1, topSplit.id, rTop).root;
  check("改内层 ratio：外层与另一内层 ratio 保持原值", findSplitRatio(step2, rootSplit.id) === rRoot && findSplitRatio(step2, bottomSplit.id) === bottomSplit.ratio);
  check("ratio 改动不影响窗格 / 页签归属", JSON.stringify(collectPanes(step2).map((p) => p.tabIds)) === JSON.stringify(collectPanes(base).map((p) => p.tabIds)));
  check("ratio 改动后矩形仍合法", validRects(step2));

  for (const [label, split] of [["根（上下）", rootSplit], ["内层（左右）", topSplit]]) {
    const minRatio = ratioFromPointer(base, split.id, b, -5000, -5000);
    const minRoot = setRatio(base, split.id, minRatio).root;
    const maxRatio = ratioFromPointer(base, split.id, b, 9999, 9999);
    const maxRoot = setRatio(base, split.id, maxRatio).root;
    check(
      `${label} 拖到两端仍满足所有窗格最小尺寸`,
      [minRoot, maxRoot].every((tree) =>
        computeLayoutRects(tree, b).panes.every((p) => p.rect.width >= MIN_PANE_WIDTH && p.rect.height >= MIN_PANE_HEIGHT)),
    );
  }

  const small = bounds(1000, 700);
  const ratiosBefore = collectSplits(step2).map((s) => s.ratio);
  const widthsBefore = computeLayoutRects(step2, b).panes.map((p) => p.rect.width);
  const widthsAfter = computeLayoutRects(step2, small).panes.map((p) => p.rect.width);
  check("窗口缩放不会改写树里的 ratio", JSON.stringify(ratiosBefore) === JSON.stringify(collectSplits(step2).map((s) => s.ratio)));
  check("窗口变窄后按 ratio 重算、宽度相应缩小", widthsAfter.every((w, i) => w <= widthsBefore[i]) && widthsAfter.some((w, i) => w < widthsBefore[i]));
  check("窗口缩放后矩形合法", validRects(step2, small));

  // 连续拖动模拟（主进程轮询 / renderer pointermove 都会走这条路径）
  let sim = base;
  for (const y of [500, 470, 440, 410, 380, 350, 320]) {
    sim = setRatio(sim, rootSplit.id, ratioFromPointer(sim, rootSplit.id, b, 0, y)).root;
  }
  check("快速连续拖动后 ratio 单调下降", findSplitRatio(sim, rootSplit.id) < 0.5);
  check(
    "连续拖动不改变树结构 / 页签 / 其它比例",
    collectSplits(sim).length === 3 &&
      sortedIds(allTabIds(sim)) === "a,b,c,d" &&
      findSplitRatio(sim, topSplit.id) === topSplit.ratio,
  );
  check("连续拖动过程中布局始终合法", validRects(sim));

  const dir2 = mkdtempSync(join(tmpdir(), "pi-web-desktop-sash-ratio-"));
  try {
    const tabs = ["a", "b", "c", "d"].map((id) => ({ id, path: "/", title: id, pinned: false }));
    saveTabs(dir2, toPersistedTabs({
      tabs,
      activeId: "a",
      groups: collectPanes(sim).map((p) => ({ tabIds: p.tabIds, activeId: p.activeId })),
      focused: 0,
      layout: layoutKind(sim),
      tree: sim,
      focusedPaneId: collectPanes(sim)[0].id,
    }));
    const loaded = loadTabs(dir2);
    const restored = fromPersistedTree(loaded.layout.root, (i) => tabs[i].id);
    eq("重启后每个 SplitNode 的 ratio 都恢复", collectSplits(restored).map((s) => s.ratio), collectSplits(sim).map((s) => s.ratio));
    eq("重启后每个 SplitNode 的方向 / id 都恢复", collectSplits(restored).map((s) => [s.id, s.direction]), collectSplits(sim).map((s) => [s.id, s.direction]));
    check("恢复后按当前窗口重算布局仍合法", validRects(restored));
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

/* ------------------------- 静态契约：TabManager 接线 ------------------------- */
{
  const manager = readFileSync(new URL("../src/main/tabs/tab-manager.ts", import.meta.url), "utf8");
  const snapshot = readFileSync(new URL("../src/shared/split.ts", import.meta.url), "utf8");
  const persisted = readFileSync(new URL("../src/main/tabs/tab-model.ts", import.meta.url), "utf8");
  check("TabManager 不再调用旧的平面 computePaneRects", !manager.includes("computePaneRects("));
  check("TabManager 用 syncLayout() 给主进程和渲染层供同一份结果", manager.includes("private syncLayout()") && (manager.match(/syncLayout\(\)/g) ?? []).length >= 2);
  check("snapshot 透传 paneIds / focusedPaneId / tree / sashes", ["paneIds:", "focusedPaneId:", "tree:", "sashes:"].every((needle) => manager.includes(needle)));
  check("SplitSnapshot 声明了同一组字段", ["paneIds: string[]", "focusedPaneId: string", "tree: LayoutNode", "sashes: SashRect[]"].every((needle) => snapshot.includes(needle)));
  const layoutStart = manager.indexOf("private layout(): void {");
  const layoutTail = layoutStart >= 0 ? manager.slice(layoutStart) : "";
  const nextMethod = layoutTail.indexOf("\n  private ", 1);
  const layoutBody = nextMethod > 0 ? layoutTail.slice(0, nextMethod) : layoutTail;
  check(
    "布局调整（layout）只改 bounds / 可见性，不重建 / 不重载 WebContentsView",
    layoutBody.length > 0 && !/(loadURL|addChildView|removeChildView|new WebContentsView)\(/.test(layoutBody),
  );
  check("持久化同时写 v2 树与旧 split 镜像", persisted.includes("split: legacy") && persisted.includes("root: toPersistedTree"));
  check("最多 4 个 Pane 的限制仍在主进程侧", manager.includes("MAX_PANES"));

  /* ---- M2：分隔条拖动接线 ---- */
  const tabbar = readFileSync(new URL("../src/renderer/tabbar/tabbar.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/renderer/tabbar/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../src/renderer/tabbar/index.html", import.meta.url), "utf8");
  const types = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../src/preload/tabbar.ts", import.meta.url), "utf8");
  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  check("renderer 用 Pointer Events + pointer capture", ["pointerdown", "setPointerCapture", "pointerup", "pointercancel", "lostpointercapture", "releasePointerCapture"].every((n) => tabbar.includes(n)));
  check("拖动用 requestAnimationFrame 合并 IPC", tabbar.includes("requestAnimationFrame") && tabbar.includes("cancelAnimationFrame"));
  check("结束信号覆盖窗口失焦", tabbar.includes('addEventListener("blur", finishSashDrag)'));
  check("分隔条 DOM 按 id 复用，不整层重建", tabbar.includes("const sashEls = new Map") && !tabbar.includes("sashLayer.replaceChildren()"));
  check("拖动中只增量更新页签条位置", tabbar.includes("if (sashDragging && splitMode)"));
  check("CSS 有对应方向的调整光标与细线", css.includes("col-resize") && css.includes("row-resize") && css.includes(".sash::after"));
  check("sash 在独立层，不与 pane-layer 混用", html.includes('id="sash-layer"'));
  check("主进程拖动中不写盘", manager.includes("if (this.sashDragging) return;"));
  check("拖动结束才落盘", manager.includes("endSashDrag()") && manager.includes("this.persist();"));
  check("主进程用 screen 坐标轮询 + mouseUp / 看门狗兜底", manager.includes("getCursorScreenPoint") && manager.includes('input.type === "mouseUp"') && manager.includes("30_000"));
  check("拖动中不抢焦点 / 不刷新草稿上下文", manager.includes("if (!this.sashDragging) this.options.onTabContextChanged?.()"));
  check("跨进程晚到的旧 pointermove 被丢弃（防 ratio 回跳）", manager.includes("stamp < this.lastSashAt - 2"));
  check("layout() 只切变化的可见性（拖动零闪烁）", manager.includes("if (was !== should) tab.view.setVisible(should)"));
  check("三处 IPC 通道声明一致", [types, preload, ipc].every((f) => ["beginSashDrag", "setSashRatio", "endSashDrag"].every((n) => f.includes(n))));
}

/* ------------------------- 单一数据源 ------------------------- */
{
  const root = presetToTree("grid-2x2", ["a", "b", "c", "d"]);
  const layout = computeLayoutRects(root, bounds());
  check("主进程 / 渲染层用的是同一份 panes + sashes 结果", layout.panes.length === collectPanes(root).length && layout.sashes.length === collectSplits(root).length);
  check("同一份结果里所有节点矩形都齐备（含 SplitNode）", Object.keys(layout.nodes).length === collectPanes(root).length + collectSplits(root).length);
  check("toPersistedTree 不改运行时树", toPersistedTree(root, () => 0) && collectPanes(root).length === 4);
}

if (failed) process.exit(1);
console.log("Split Tree 模型 / 布局计算 / 旧配置迁移检查通过");
