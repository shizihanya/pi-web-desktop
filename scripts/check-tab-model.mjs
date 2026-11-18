#!/usr/bin/env node
/**
 * 页签纯逻辑回归（第八阶段）：创建 / 关闭 / 固定 / 移动 / 恢复。
 * 持久化部分直接调用真实的 saveTabs / loadTabs（临时目录），不重写实现。
 *
 *   npm run check:tab-model
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canCloseTab,
  clampActiveIndex,
  moveTargetIndex,
  pinnedReorderIndex,
  resolveInsertIndex,
  toPersistedTabs,
} from "../src/main/tabs/tab-model.ts";
import { loadTabs, saveTabs } from "../src/main/tabs/tab-persistence.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}
const tab = (pinned = false) => ({ pinned });
const tabs = (...flags) => flags.map(tab);

/* ------------------------- 创建 ------------------------- */
check("无指定位置：新页签插在固定区之后", resolveInsertIndex(tabs(true, true, false), undefined, false) === 2);
check("无固定页签：插到最左", resolveInsertIndex(tabs(false, false), undefined, false) === 0);
check("指定位置被钳到 [pinnedCount, len]", resolveInsertIndex(tabs(true, false), 0, false) === 1);
check("指定位置越界上界被钳制", resolveInsertIndex(tabs(true, false), 99, false) === 2);
check("新建的是固定页签：可以插到固定区", resolveInsertIndex(tabs(true, false, false), 1, true) === 1);
check("非整数 index 回落到固定区之后", resolveInsertIndex(tabs(true, false), 1.7, false) === 1);

/* ------------------------- 关闭 ------------------------- */
check("普通页签可以直接关闭", canCloseTab(false, false) === true);
check("固定页签默认不可关闭（Ctrl+W / 中键）", canCloseTab(true, false) === false);
check("固定页签可在右键菜单显式关闭", canCloseTab(true, true) === true);

/* ------------------------- 固定 / 取消固定 ------------------------- */
{
  const list = [
    { id: "a", pinned: true },
    { id: "b", pinned: false },
    { id: "c", pinned: false },
  ];
  // 固定 c：先摘掉，再按 pinnedReorderIndex 插回
  const c = list.splice(2, 1)[0];
  c.pinned = true;
  list.splice(pinnedReorderIndex(list), 0, c);
  check("固定后移到固定区末尾、固定区仍最左", list.map((t) => t.id).join(",") === "a,c,b");
  // 取消固定 a：应落到非固定区开头
  const a = list.splice(0, 1)[0];
  a.pinned = false;
  list.splice(pinnedReorderIndex(list), 0, a);
  check("取消固定后放到非固定区开头", list.map((t) => t.id).join(",") === "c,a,b");
}

/* ------------------------- 移动 / 拖动排序 ------------------------- */
{
  const list = tabs(true, true, false, false);
  check("非固定页签不能拖进固定区", moveTargetIndex(list, 2, 0) === 2);
  check("固定页签不能拖出固定区", moveTargetIndex(list, 0, 3) === 1);
  check("正常移动到同区末尾", moveTargetIndex(list, 2, 3) === 3);
  check("目标下标越界被钳制", moveTargetIndex(list, 3, 99) === 3);
  check("只有一个固定页签时其可移动区间为 [0,0]", moveTargetIndex(tabs(true, false, false), 0, 2) === 0);
}

/* ------------------------- 持久化映射 ------------------------- */
{
  const state = {
    tabs: [
      { id: "t1", path: "/?session=a", title: "A", pinned: true },
      { id: "t2", path: "/?session=b", title: "B", pinned: false },
      { id: "t3", path: "/", title: "C", pinned: false },
    ],
    activeId: "t3",
    groups: [
      { tabIds: ["t1", "t2"], activeId: "t2" },
      { tabIds: ["t3"], activeId: "t3" },
    ],
    focused: 1,
    layout: "columns",
  };
  const persisted = toPersistedTabs(state);
  check(
    "内存态 → tabs.json：页签按下标保存，端口 / id 变化不影响恢复",
    persisted.activeIndex === 2 &&
      persisted.tabs.map((t) => t.path).join("|") === "/?session=a|/?session=b|/" &&
      persisted.split.groups.map((g) => g.join(",")).join("|") === "0,1|2" &&
      persisted.split.active.join(",") === "1,2" &&
      persisted.split.focused === 1,
    JSON.stringify(persisted),
  );
  const withStaleIds = toPersistedTabs({
    ...state,
    groups: [{ tabIds: ["t1", "gone"], activeId: "gone" }],
  });
  check("无效页签 id 被过滤，不写坏下标", JSON.stringify(withStaleIds.split.groups) === "[[0]]" && withStaleIds.split.active[0] === null, JSON.stringify(withStaleIds.split));
}

/* ------------------------- 恢复（真实 saveTabs / loadTabs） ------------------------- */
const dir = mkdtempSync(join(tmpdir(), "pi-web-desktop-tabs-"));
try {
  const state = {
    version: 1,
    activeIndex: 2,
    tabs: [
      { path: "/?session=a", title: "A", pinned: true },
      { path: "/?session=b", title: "B", pinned: false },
      { path: "/", title: "C", pinned: false },
    ],
    split: {
      groups: [[0, 1], [2]],
      active: [1, 2],
      focused: 1,
      layout: "grid",
    },
  };
  saveTabs(dir, state);
  const loaded = loadTabs(dir);
  check(
    "重启恢复：页签 / 固定状态 / 激活页签 / 分屏布局全部还原",
    loaded.tabs.length === 3 &&
      loaded.tabs[0].pinned === true &&
      loaded.tabs[1].path === "/?session=b" &&
      loaded.activeIndex === 2 &&
      loaded.split.groups.length === 2 &&
      loaded.split.layout === "grid" &&
      loaded.split.focused === 1,
    JSON.stringify(loaded),
  );
  check("恢复时激活下标被钳到页签数量内", clampActiveIndex(loaded.activeIndex, loaded.tabs.length) === 2 && clampActiveIndex(99, 3) === 2 && clampActiveIndex(-1, 3) === 0);
  check("空页签列表时激活下标为 0", clampActiveIndex(5, 0) === 0);

  // 老版本 / 手工编辑：没有 split 字段也能恢复
  saveTabs(dir, { version: 1, activeIndex: 0, tabs: [{ path: "/", title: "X", pinned: false }] });
  const legacy = loadTabs(dir);
  check("老格式（无 split）仍可恢复，不白屏", legacy.tabs.length === 1 && legacy.split === undefined);

  // 非法 JSON / 非法 version 不崩
  writeFileSync(join(dir, "tabs.json"), "{ not json", "utf8");
  check("tabs.json 非法 JSON 时安全回落到默认", loadTabs(dir) === null);
  writeFileSync(join(dir, "tabs.json"), JSON.stringify({ version: 9, activeIndex: 1, tabs: [{ path: "?session=x" }] }), "utf8");
  const normalized = loadTabs(dir);
  check("相对路径被补成 /?session=，字段缺失有默认值", normalized.tabs[0].path === "/?session=x" && normalized.tabs[0].pinned === false && normalized.tabs[0].title === "");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("页签模型 / 持久化检查通过");
