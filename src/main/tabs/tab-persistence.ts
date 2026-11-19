import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SplitLayout } from "../../shared/split";
import { LAYOUT_SCHEMA_VERSION, type PersistedLayout, type PersistedLayoutNode } from "../../shared/split-model.ts";

const FILE = "tabs.json";
/** v1 = 平面 groups；v2 = Split Tree。旧版文件照样能读，读出后由 TabManager 迁移并回写。 */
const VERSION = 2;

/** 分屏布局按页签下标保存（端口/页签 id 变了也能恢复） */
export interface PersistedSplit {
  /** 每个窗格拥有的页签（tabs[] 下标），数组顺序 = 该窗格页签条顺序 */
  groups: number[][];
  /** 每个窗格当前显示的页签（tabs[] 下标），null = 没有 */
  active: (number | null)[];
  focused: number;
  layout: SplitLayout;
}

export interface PersistedTab {
  /** 相对服务地址的路径，例如 /?session=abc（端口变了也能恢复） */
  path: string;
  title: string;
  pinned: boolean;
}

export interface PersistedTabs {
  version: number;
  activeIndex: number;
  tabs: PersistedTab[];
  /** v1 平面布局；v2 仍然写一份，保证旧版本 app 降级后也能读 */
  split?: PersistedSplit | null;
  /** v2 嵌套布局树 */
  layout?: PersistedLayout | null;
}

function tabsFile(dataDir: string): string {
  return join(dataDir, FILE);
}

export function loadTabs(dataDir: string): PersistedTabs | null {
  const file = tabsFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedTabs>;
    if (!Array.isArray(raw.tabs)) return null;
    const tabs = raw.tabs
      .filter((tab): tab is PersistedTab => typeof tab?.path === "string")
      .map((tab) => ({
        path: tab.path.startsWith("/") ? tab.path : `/${tab.path}`,
        title: typeof tab.title === "string" ? tab.title : "",
        pinned: tab.pinned === true,
      }));
    // 分屏布局是 v1 文件里的可选字段：老版本 / 手工编辑的文件没有它也能正常加载
    let split: PersistedSplit | null = null;
    const rawSplit = raw.split as Partial<PersistedSplit> | null | undefined;
    if (rawSplit && Array.isArray(rawSplit.groups)) {
      const groups = rawSplit.groups
        .filter((group): group is number[] => Array.isArray(group))
        .map((group) =>
          group.filter((i): i is number => Number.isInteger(i) && Number(i) >= 0),
        );
      const active = Array.isArray(rawSplit.active)
        ? groups.map((_group, i) => {
            const value = rawSplit.active?.[i];
            return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
          })
        : groups.map(() => null);
      split = {
        groups,
        active,
        focused: Number.isInteger(rawSplit.focused) ? Number(rawSplit.focused) : 0,
        layout:
          rawSplit.layout === "rows" || rawSplit.layout === "grid" ? rawSplit.layout : "columns",
      };
    }

    // v2：Split Tree。这里只做形状兜底，引用校验 / 去重 / 折叠交给 split-model.normalizeLayout。
    let layout: PersistedLayout | null = null;
    const rawLayout = raw.layout as Partial<PersistedLayout> | null | undefined;
    if (rawLayout && rawLayout.version === LAYOUT_SCHEMA_VERSION && isRecord(rawLayout.root)) {
      layout = {
        version: LAYOUT_SCHEMA_VERSION,
        root: rawLayout.root as PersistedLayoutNode,
        focusedPaneId: typeof rawLayout.focusedPaneId === "string" ? rawLayout.focusedPaneId : "",
      };
    }

    return {
      version: Number.isInteger(raw.version) ? Number(raw.version) : VERSION,
      activeIndex: Number.isInteger(raw.activeIndex) ? Number(raw.activeIndex) : 0,
      tabs,
      ...(split && split.groups.length > 1 ? { split } : {}),
      ...(layout ? { layout } : {}),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function saveTabs(dataDir: string, state: PersistedTabs): void {
  const file = tabsFile(dataDir);
  const temp = `${file}.tmp`;
  try {
    const version = Number.isInteger(state.version) ? state.version : VERSION;
    writeFileSync(temp, `${JSON.stringify({ ...state, version }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch {
    // 保存失败不该影响使用（下次启动就是旧的页签列表）
  }
}
