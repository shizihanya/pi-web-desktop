import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SplitLayout } from "../../shared/split";

const FILE = "tabs.json";
const VERSION = 1;

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
  split?: PersistedSplit | null;
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

    return {
      version: VERSION,
      activeIndex: Number.isInteger(raw.activeIndex) ? Number(raw.activeIndex) : 0,
      tabs,
      ...(split && split.groups.length > 1 ? { split } : {}),
    };
  } catch {
    return null;
  }
}

export function saveTabs(dataDir: string, state: PersistedTabs): void {
  const file = tabsFile(dataDir);
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...state, version: VERSION }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch {
    // 保存失败不该影响使用（下次启动就是旧的页签列表）
  }
}
