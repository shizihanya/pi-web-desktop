/**
 * 页签顺序 / 固定 / 持久化的纯计算（第八阶段：让「创建、关闭、固定、移动、恢复」可回归）。
 *
 * 只抽出 TabManager 里不依赖 Electron 的那部分判定，TabManager 仍持有 WebContentsView
 * 与窗格状态，对外接口、TabInfo / TabsSnapshot 语义、快捷键都不变。
 * 不重复实现 tab-persistence.ts：读写文件仍走那边，这里只做「内存态 ↔ 持久化态」的映射。
 */

import type { PersistedTabs } from "./tab-persistence.ts";
import type { SplitLayout } from "../../shared/split.ts";

export interface OrderedTab {
  pinned: boolean;
}

/** 新页签插入点：固定区永远在最左，新页签默认插在固定区之后 */
export function resolveInsertIndex(
  tabs: readonly OrderedTab[],
  index: number | undefined,
  pinned: boolean,
): number {
  const pinnedCount = tabs.filter((tab) => tab.pinned).length;
  if (index !== undefined && Number.isInteger(index)) {
    const min = pinned ? 0 : pinnedCount;
    return Math.min(Math.max(index, min), tabs.length);
  }
  return pinnedCount;
}

/** 拖动排序的目标下标：不能跨过固定区 */
export function moveTargetIndex(
  tabs: readonly OrderedTab[],
  from: number,
  targetIndex: number,
): number {
  const pinnedCount = tabs.filter((tab) => tab.pinned).length;
  const min = tabs[from].pinned ? 0 : pinnedCount;
  const max = tabs[from].pinned ? Math.max(pinnedCount - 1, 0) : tabs.length - 1;
  return Math.min(Math.max(targetIndex, min), max);
}

/** 固定 / 取消固定后的插入点（调用方先把该页签从数组里摘掉） */
export function pinnedReorderIndex(tabsWithoutTab: readonly OrderedTab[]): number {
  return tabsWithoutTab.filter((tab) => tab.pinned).length;
}

/** 固定页签默认不允许关闭，需要显式 force（右键菜单） */
export function canCloseTab(pinned: boolean, force: boolean): boolean {
  return !pinned || force;
}

/** 恢复时把持久化的激活下标钳到当前页签数量内 */
export function clampActiveIndex(raw: number | undefined | null, count: number): number {
  if (count <= 0) return 0;
  const value = Number.isInteger(raw) ? Number(raw) : 0;
  return Math.min(Math.max(value, 0), count - 1);
}

export interface PersistableTab {
  id: string;
  path: string;
  title: string;
  pinned: boolean;
}

export interface PersistableGroup {
  tabIds: string[];
  activeId: string | null;
}

export interface TabStateForSave {
  tabs: PersistableTab[];
  activeId: string | null;
  groups: PersistableGroup[];
  focused: number;
  layout: SplitLayout;
}

/**
 * 内存态 → tabs.json。分屏布局按「页签下标」保存，端口 / 页签 id 变了也能恢复。
 * 复用 tab-persistence.ts 的 PersistedTabs 结构，不另起一套格式。
 */
export function toPersistedTabs(state: TabStateForSave): PersistedTabs {
  const indexOf = (id: string): number => state.tabs.findIndex((tab) => tab.id === id);
  return {
    version: 1,
    activeIndex: Math.max(state.tabs.findIndex((tab) => tab.id === state.activeId), 0),
    tabs: state.tabs.map((tab) => ({ path: tab.path, title: tab.title, pinned: tab.pinned })),
    split: {
      groups: state.groups.map((group) =>
        group.tabIds.map(indexOf).filter((index) => index >= 0),
      ),
      active: state.groups.map((group) => {
        if (!group.activeId) return null;
        const index = indexOf(group.activeId);
        return index >= 0 ? index : null;
      }),
      focused: state.focused,
      layout: state.layout,
    },
  };
}
