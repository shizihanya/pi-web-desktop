import {
  clipboard,
  Menu,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import type { TabInfo, TabStatus, TabsSnapshot, ThemeSnapshot } from "../../shared/types";
import { DRAFT_MAX_WIDTH, sessionKeyFromPath, type DraftContext } from "./draft-model";
import type { CompatVerdict } from "./compat";
import { TAB_IPC, type DropPreview } from "../../shared/types";
import {
  MAX_PANES,
  paneContentRect,
  presetById,
  presetFor,
  SPLIT_PRESETS,
  type SplitLayout,
  type SplitPreset,
} from "../../shared/split";
import {
  addEdgePane,
  applyTabDrop,
  canAddEdge,
  canSplit,
  collectPanes,
  computeLayoutRects,
  createPane,
  directionForSide,
  type DropSide,
  findPane,
  findSplit,
  fromPersistedTree,
  layoutKind,
  layoutSignature,
  legacySplitToTree,
  moveTab,
  normalizeLayout,
  paneCount,
  presetToTree,
  ratioFromPointer,
  removePane,
  type Rect,
  setRatio,
  splitPane,
  type LayoutNode,
  type LayoutResult,
  type PaneNode,
  type SplitDirection,
} from "../../shared/split-model.ts";
import { defaultSymbolColor, setTitleBarColors, TITLEBAR_HEIGHT, toOpaqueHex } from "../titlebar";
import {
  GLOBAL_STATUS_PROBE_SCRIPT,
  TAB_SESSION_PROBE_SCRIPT,
  type TabStatusProbe,
} from "./tab-status";
import { TabStatusManager, type StatusSource } from "./tab-status-manager";
import { CompatibilityTracker } from "./compat";
import { NotificationBridge } from "./notification-bridge";
import { ThemeManager } from "./theme-manager";
import {
  INITIAL_TAB_LIFECYCLE,
  beginRecovery,
  canRecover,
  crashTitle,
  failRecovery,
  isCrashed,
  onDidFinishLoad,
  onDidStartLoading,
  onRenderProcessGone,
  markDestroyed,
  type TabLifecycleState,
} from "./tab-lifecycle";
import { isServing } from "../server/port";
import {
  canCloseTab,
  clampActiveIndex,
  moveTargetIndex,
  pinnedReorderIndex,
  resolveInsertIndex as computeInsertIndex,
  toPersistedTabs,
} from "./tab-model";
import { loadTabs, saveTabs, type PersistedTabs } from "./tab-persistence";

/** 页签栏高度（CSS 里的 --tabbar-height、shared/split.ts 里的 TABBAR_HEIGHT 必须一致） */
export const TABBAR_HEIGHT = TITLEBAR_HEIGHT;

const SAVE_DEBOUNCE_MS = 300;
/** 页签状态轮询间隔（和主题探测一样是主进程主动读，页面里不装常驻定时器）
 *  比 pi-web 自己的 2.5s 轮询快，尽量不漏掉短回答的 running→idle 跳变 */
const STATUS_POLL_MS = 700;

type ShortcutHandler = (event: Electron.Event, input: Electron.Input) => void;

/** 一个窗格 = Split Tree 里的 PaneNode（它有哪些页签、当前显示哪个）。
 *  保留别名让上层代码不必关心树节点的 type / id 字段。 */
type PaneGroup = PaneNode;

interface Tab {
  id: string;
  view: WebContentsView;
  /** 相对服务根的路径（/?session=xxx），用于持久化与比较 */
  path: string;
  title: string;
  favicon: string | null;
  pinned: boolean;
  loading: boolean;

  /* ---------------- 当前选中对话的状态 ---------------- */
  /** 页签栏要显示的状态 */
  status: TabStatus;
  /** 探测脚本报上来的当前会话 id */
  sessionId: string | null;
  /** 上一次探测时是否在跑，用来识别「回答完毕」这一跳变 */
  running: boolean;
  awaiting: boolean;
  /** 「回答完毕未查看」的时间戳：running→idle 且当时不是前台页签 */
  pendingUnreadAt: number | null;
  /** 已经看过的那一轮未读，避免切走又切回时重复提示 */
  seenUnreadAt: number | null;
  /** Loading / Ready / Crashed / Recovering / Destroyed */
  lifecycle: TabLifecycleState;
}

export interface TabManagerOptions {
  win: BrowserWindow;
  /** 形如 http://127.0.0.1:30141 */
  baseUrl: string;
  dataDir: string;
  restoreTabs: boolean;
  /** 页签变化（托盘菜单刷新用） */
  onTabsChanged?: (snapshot: TabsSnapshot) => void;
  /** 仅调试：输出主题探测日志 */
  onDebug?: (message: string) => void;
  /** 是否启用了自绘标题栏（WCO），用于同步窗口控件配色 */
  customTitleBar?: boolean;
  /** 上次缓存的主题；有它就能让冷启动首帧直接用正确配色 */
  initialTheme?: ThemeSnapshot | null;
  /** 独立输入工作区（桌面增强）：新页签创建时把 WebContents 交给它装入口/探针 */
  onTabCreated?: (tabId: string, wc: WebContents) => void;
  onTabClosed?: (tabId: string) => void;
  /** 页签切换 / 会话切换 / 分屏焦点变化；在 notify() 里触发，调用方自行去重 */
  onTabContextChanged?: () => void;
}

/**
 * 一个页签 = 一个 WebContentsView + 一个 URL。
 * 与 pi-web 的全部交互只有两件事：loadURL，以及接管它自己发起的 window.open。
 */
export class TabManager {
  private readonly tabs: Tab[] = [];

  /* ---------------- 分屏状态：Split Tree（唯一数据源） ----------------
   * root 里的 PaneNode 就是原来的「编辑器组」：它拥有哪些页签、当前显示哪个。
   * groups 只是 collectPanes(root) 的 DFS 投影（返回活节点，原地改 tabIds 会写回树），
   * focusedGroup 只是 focusedPaneId 的下标视图；两者都不再单独保存一份状态。
   * activeId 恒等于焦点 PaneNode 的 activeId（syncActive 维护），
   * 这样标题、主题探测、托盘勾选等原有逻辑都不用改。
   */
  private root: LayoutNode = createPane();
  private focusedPaneId: string = collectPanes(this.root)[0].id;
  /** 一次递归布局计算的结果：layout() 与 snapshot() 共用同一份，禁止两边各算一套 */
  private computed: { signature: string; width: number; height: number; result: LayoutResult } | null = null;
  /** 拖动页签期间临时隐藏内容视图，让渲染层的投放层露出来 */
  private dragging = false;
  /** 当前正在显示的内容视图：layout() 只切变化的那几个，避免拖动时反复隐藏/显示造成闪烁 */
  private shownTabIds = new Set<string>();

  /* ---------------- 分隔条拖动（M2） ----------------
   * 不抢焦点、不重建视图、不写盘；主进程轮询屏幕坐标作为可靠输入源，
   * renderer 的 Pointer Events 只负责开始 / 低延迟更新 / 结束信号。 */
  private sashDragging = false;
  private sashDragSplitId: string | null = null;
  private sashTimer: NodeJS.Timeout | null = null;
  private sashWatchdog: NodeJS.Timeout | null = null;
  /** 最近一次采用的坐标时间戳：丢弃跨进程晚到的旧 pointermove，防止 ratio 回跳 */
  private lastSashAt = 0;
  /** 拖页签期间渲染层崩溃时的兜底：30s 后强制恢复内容视图 */
  private tabDragWatchdog: NodeJS.Timeout | null = null;

  /** 窗格列表（DFS 顺序）：与 computeLayoutRects().panes 严格同序 */
  private get groups(): PaneGroup[] {
    return collectPanes(this.root);
  }

  /** 兼容既有代码：焦点窗格下标 ⇄ 稳定 pane id */
  private get focusedGroup(): number {
    const index = this.groups.findIndex((pane) => pane.id === this.focusedPaneId);
    return index >= 0 ? index : 0;
  }

  private set focusedGroup(index: number) {
    const panes = this.groups;
    const at = Math.min(Math.max(Math.trunc(index) || 0, 0), Math.max(panes.length - 1, 0));
    this.focusedPaneId = panes[at]?.id ?? "";
  }

  /** 当前窗口内容区矩形：布局计算、最小尺寸检查、拖放预览与落位全部用同一份 bounds */
  private layoutBounds(): Rect {
    const [width, height] = this.options.win.isDestroyed() ? [1, 1] : this.options.win.getContentSize();
    return { x: 0, y: 0, width, height };
  }

  /** 每个窗格当前实际允许投放的方向（主进程用 canSplit 算，渲染层只显示） */
  private dropSides(): DropSide[][] {
    const bounds = this.layoutBounds();
    const atLimit = paneCount(this.root) >= MAX_PANES;
    return this.groups.map((pane) => {
      const sides: DropSide[] = ["center"];
      if (!atLimit) {
        for (const side of ["left", "right", "top", "bottom"] as const) {
          if (canSplit(this.root, bounds, pane.id, directionForSide(side).direction)) sides.push(side);
        }
      }
      return sides;
    });
  }

  /** 布局计算（带缓存）：几何签名 / 窗口尺寸没变就复用上次结果 */
  private syncLayout(): LayoutResult {
    const { width, height } = this.layoutBounds();
    const signature = layoutSignature(this.root);
    if (
      !this.computed ||
      this.computed.signature !== signature ||
      this.computed.width !== width ||
      this.computed.height !== height
    ) {
      this.computed = {
        signature,
        width,
        height,
        result: computeLayoutRects(this.root, { x: 0, y: 0, width, height }),
      };
    }
    return this.computed.result;
  }
  /** 主窗口 webContents 上的快捷键监听：destroy 时要摘掉，否则服务地址变化重建 TabManager 会重复绑定 */
  private readonly windowShortcutHandler: ShortcutHandler;
  private activeId: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly debugStatus = Boolean(process.env.PI_WEB_DESKTOP_DEBUG_STATUS);
  /** 仅自测：不跑真实对话，依次演示四种页签状态，方便截图验收样式 */
  private readonly demoStatus = process.env.PI_WEB_DESKTOP_SELFTEST_STATUS === "1";
  private lastChromeSignature = "";
  private destroyed = false;
  /** 独立输入工作区展开时给 pi-web 内容视图让出的右侧宽度（不盖住对话） */
  private reservedRightWidth = 0;

  /* ---------------- 功能级兼容性（每个增强独立检测/关闭/降级） ---------------- */
  private readonly compat: CompatibilityTracker;
  /** 每个页面注入都可独立关闭；关闭后只影响该增强，pi-web 原生功能照常 */
  private readonly statusProbeEnabled = process.env.PI_WEB_DESKTOP_DISABLE_STATUS_PROBE !== "1";
  private readonly themeProbeEnabled = process.env.PI_WEB_DESKTOP_DISABLE_THEME_PROBE !== "1";
  private readonly notificationPatchEnabled =
    process.platform === "win32" && process.env.PI_WEB_DESKTOP_DISABLE_NOTIFICATION_PATCH !== "1";
  private readonly notifications: NotificationBridge;
  private readonly themes: ThemeManager;

  /* ---------------- 状态监控：TabStatusManager 负责共享快照 / 选源 / 计算 ---------------- */
  private readonly statuses: TabStatusManager;

  private readonly onWindowFocus = (): void => this.syncWindowFocus(true);
  private readonly onWindowBlur = (): void => {
    this.syncWindowFocus(false);
    // 窗口失焦时鼠标很可能已经在别处松开：结束拖动并落盘，避免 ratio 卡在拖动态
    if (this.sashDragging) this.endSashDrag();
  };

  constructor(private readonly options: TabManagerOptions) {
    this.compat = new CompatibilityTracker({
      onChange: (result) => {
        if (result.level !== "compatible" || process.env.PI_WEB_DESKTOP_DEBUG_COMPAT) {
          this.options.onDebug?.(`[compat] ${result.feature}: ${result.level} — ${result.reason}`);
        }
      },
    });
    this.themes = new ThemeManager({
      dataDir: options.dataDir,
      systemDark: nativeTheme.shouldUseDarkColors,
      initialTheme: options.initialTheme,
      onRefresh: () => void this.refreshTheme(),
      onCompatibility: (verdict) => this.compat.set("themeProbe", verdict),
      onDebug: (message) => this.options.onDebug?.(message),
    });
    this.notifications = new NotificationBridge({
      enabled: this.notificationPatchEnabled,
      checkOnlyWhenDisabled: process.platform === "win32",
      contents: () => this.tabs.map((tab) => tab.view.webContents),
      focusState: () => !this.options.win.isDestroyed() && this.options.win.isFocused(),
      onVerdict: (verdict) => this.compat.set("notification", verdict),
      onDebug: (message) => this.options.onDebug?.(message),
    });
    if (!this.notificationPatchEnabled) {
      this.compat.set("notification", {
        level: "disabled",
        reason: "通知增强已关闭（非 Windows 或环境变量禁用）",
      });
    }
    if (!this.statusProbeEnabled) {
      this.compat.set("statusProbe", { level: "disabled", reason: "状态探测已由环境变量关闭" });
    }
    if (!this.themeProbeEnabled) {
      this.compat.set("themeProbe", { level: "disabled", reason: "主题探测已由环境变量关闭" });
    }
    this.statuses = new TabStatusManager({
      sources: () =>
        this.tabs.map(
          (tab): StatusSource => ({
            key: tab.id,
            get running() {
              return tab.running;
            },
            get awaiting() {
              return tab.awaiting;
            },
            isDestroyed: () => tab.view.webContents.isDestroyed(),
            executeJavaScript: (code, gesture) =>
              tab.view.webContents.executeJavaScript(code, gesture),
          }),
        ),
      activeSourceKey: () => this.activeId,
      onProbe: (key, probe) => {
        const tab = this.tabs.find((item) => item.id === key);
        return tab ? this.applyTabStatus(tab, probe) : false;
      },
      onChanged: () => this.notify(),
      onCompatibility: (verdict) => this.compat.set("statusProbe", verdict),
    });
    // 窗口尺寸变了要重排视图，并把新的窗格矩形同步给页签栏渲染层
    const relayout = (): void => {
      this.layout();
      this.notify();
    };
    this.options.win.on("resize", relayout);
    this.options.win.on("maximize", relayout);
    this.options.win.on("unmaximize", relayout);
    this.windowShortcutHandler = this.attachShortcuts(this.options.win.webContents);
    this.options.win.on("focus", this.onWindowFocus);
    this.options.win.on("blur", this.onWindowBlur);
    // 首帧就按缓存主题给窗口控件/底色上色，不等页面探测
    this.applyChromeTheme();
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** 展开 / 收起独立输入工作区：只调整内容视图 bounds，不改 pi-web DOM、不动页签栏 */
  setReservedRightWidth(px: number): void {
    const clamped = Math.max(0, Math.min(DRAFT_MAX_WIDTH, Math.round(px)));
    if (clamped === this.reservedRightWidth) return;
    this.reservedRightWidth = clamped;
    this.layout();
    this.notify();
  }

  /** 当前页签的草稿上下文（会话身份只从 URL 解析，不依赖 pi-web 内部状态） */
  draftContext(tabId: string): DraftContext | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    return {
      tabId: tab.id,
      title: tab.title,
      path: tab.path,
      sessionKey: sessionKeyFromPath(tab.path),
    };
  }

  allDraftContexts(): DraftContext[] {
    return this.tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      path: tab.path,
      sessionKey: sessionKeyFromPath(tab.path),
    }));
  }

  draftContents(tabId: string) {
    const tab = this.tabs.find((item) => item.id === tabId);
    return tab ? tab.view.webContents : null;
  }

  /** GUI 自测用：当前 pi-web 视图的实际 bounds，用来确认面板是「让出空间」而不是盖住对话 */
  activeViewBounds(): { x: number; y: number; width: number; height: number } | null {
    const tab = this.activeTab();
    return tab ? tab.view.getBounds() : null;
  }

  /** 把独立输入工作区的兼容性结论接回现有的 CompatibilityTracker（复用 [compat] 日志） */
  setComposerCompat(verdict: CompatVerdict): void {
    this.compat.set("composer", verdict);
  }

  async init(): Promise<void> {
    const persisted = this.options.restoreTabs ? loadTabs(this.options.dataDir) : null;
    if (persisted && persisted.tabs.length > 0) {
      for (const tab of persisted.tabs) {
        this.createTab(tab.path, { activate: false, pinned: tab.pinned, title: tab.title });
      }
      const index = clampActiveIndex(persisted.activeIndex, this.tabs.length);
      this.activate(this.tabs[index].id);
      this.restoreLayout(persisted, index);
    } else {
      this.createTab("/");
    }
    // 主题：事件驱动（页面 observer → console 信号）+ 5s 低频兜底轮询
    if (this.themeProbeEnabled) this.themes.start();

    // 页签状态：每轮只让一个页面请求全局接口，其余页面只读自己的 sessionId
    if (this.statusProbeEnabled) {
      this.statusTimer = setInterval(() => void this.refreshTabStatuses(), STATUS_POLL_MS);
      this.statusTimer.unref?.();
      void this.refreshTabStatuses();
    }
  }

  /** 主题变化入口：读取 / 缓存交给 ThemeManager，这里只做布局与通知 */
  async refreshTheme(): Promise<void> {
    if (this.destroyed || !this.themeProbeEnabled) return;
    const changed = await this.themes.refresh(this.activeContents());
    if (changed) {
      // 窗格边框也跟着主题换色
      this.layout();
      this.notify();
    }
    this.applyChromeTheme();
  }

  /** 把主题色同步到自绘标题栏的窗口控件和窗口底色 */
  private applyChromeTheme(): void {
    if (!this.options.customTitleBar || this.options.win.isDestroyed()) return;
    const theme = this.themes.current;
    const bg = toOpaqueHex(theme.vars["--bg"], theme.scheme);
    const fg = toOpaqueHex(
      theme.vars["--text"],
      theme.scheme,
      defaultSymbolColor(theme.scheme),
    );
    const signature = `${bg}|${fg}`;
    if (signature === this.lastChromeSignature) return;
    this.lastChromeSignature = signature;
    setTitleBarColors(this.options.win, bg, fg);
    if (process.env.PI_WEB_DESKTOP_DEBUG_THEME) {
      this.options.onDebug?.(`[theme] 窗口控件配色 ${bg} / ${fg}`);
    }
    try {
      this.options.win.setBackgroundColor(bg);
    } catch {
      // 窗口可能已销毁
    }
  }

  /**
   * Electron 的 WebContentsView 在主窗口失焦后仍报告 document.hasFocus() === true，
   * 而 pi-web 靠它判断「页面是否在前台」。把 BrowserWindow 的焦点状态同步给所有页签，
   * 让页面里的 document.hasFocus() 与 Chrome 行为一致。
   */
  syncWindowFocus(focused = !this.options.win.isDestroyed() && this.options.win.isFocused()): void {
    this.notifications.syncFocus(
      this.tabs.map((tab) => tab.view.webContents),
      focused,
    );
  }

  /** 服务恢复后把所有页签重新加载一遍 */
  reloadAll(): void {
    // 服务重启后页面 realm 会重建：全局快照与请求源必须重新初始化
    this.statuses.reset();
    for (const tab of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
  }

  snapshot(): TabsSnapshot {
    // 主进程算一次，渲染层拿到的就是同一份结果（页签条 / 分隔条都不再自己算位置）
    const layout = this.syncLayout();
    const panes = this.groups;
    return {
      tabs: this.tabs.map((tab) => this.toInfo(tab)),
      activeId: this.activeId,
      baseUrl: this.options.baseUrl,
      theme: this.themes.current,
      customTitleBar: this.options.customTitleBar === true,
      split: {
        groups: panes.map((pane) => ({ tabIds: [...pane.tabIds], activeId: pane.activeId })),
        focused: this.focusedGroup,
        layout: this.effectiveLayout(),
        preset: presetFor(panes.length, this.effectiveLayout()),
        rects: layout.panes.map((pane) => pane.rect),
        paneIds: layout.panes.map((pane) => pane.id),
        focusedPaneId: this.focusedPaneId,
        tree: this.root,
        sashes: layout.sashes,
        dropSides: this.dropSides(),
      },
    };
  }

  createTab(
    input?: string,
    options: {
      activate?: boolean;
      pinned?: boolean;
      index?: number;
      title?: string;
      /** 指定归属窗格（默认当前焦点窗格） */
      group?: number;
    } = {},
  ): string | null {
    if (this.destroyed) return null;
    const url = this.toAbsolute(input);
    if (!url) return null;

    const view = new WebContentsView({
      webPreferences: {
        // 与浏览器一致的持久化分区：PI_WEB_PASSWORD 登录态、localStorage 都保留
        partition: "persist:piweb",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    const tab: Tab = {
      id: randomUUID(),
      view,
      path: this.toRelative(url),
      title: options.title?.trim() || "新页签",
      favicon: null,
      pinned: options.pinned === true,
      loading: true,
      status: "idle",
      sessionId: null,
      running: false,
      awaiting: false,
      pendingUnreadAt: null,
      seenUnreadAt: null,
      lifecycle: { ...INITIAL_TAB_LIFECYCLE },
    };

    const wc = view.webContents;
    this.attachShortcuts(wc, tab.id);
    // 点进哪个窗格，哪个窗格就是「当前窗格」：Ctrl+W / Ctrl+R / 缩放等都作用于它
    wc.on("focus", () => this.noteGroupFocus(tab.id));

    // 页面 realm 重建（reload / 切会话）后要重装；两个脚本都幂等。
    // 全局状态脚本只装、不自己发请求：只有被主进程选为「状态源」的页面才会真的 fetch，
    // 会话脚本纯只读（URL / 侧栏选中行），刻意不读共享的 pi-web:unread-session-ids。
    if (this.statusProbeEnabled) {
      const installStatusProbes = (): void => {
        if (wc.isDestroyed()) return;
        void wc.executeJavaScript(TAB_SESSION_PROBE_SCRIPT, true).catch(() => {});
        void wc.executeJavaScript(GLOBAL_STATUS_PROBE_SCRIPT, true).catch(() => {});
      };
      wc.on("dom-ready", installStatusProbes);
      wc.on("did-finish-load", installStatusProbes);
    }

    // 通知增强 / 主题观察器各自独立安装，互不阻断
    this.notifications.attach(wc);
    if (this.themeProbeEnabled) this.themes.attach(wc);

    // pi-web 的「在新标签页打开」/导出等都会走 window.open —— 这里接管成 App 内页签
    wc.setWindowOpenHandler(({ url: target }) => {
      const absolute = this.toAbsolute(target);
      if (absolute) {
        this.createTab(absolute, { activate: true });
      } else if (target && target !== "about:blank") {
        void shell.openExternal(target);
      }
      return { action: "deny" };
    });

    wc.on("will-navigate", (event, target) => {
      if (this.toAbsolute(target)) return;
      event.preventDefault();
      void shell.openExternal(target);
    });

    wc.on("page-title-updated", (_event, title) => {
      tab.title = cleanTitle(title) || tab.title;
      this.notify();
    });

    wc.on("page-favicon-updated", (_event, icons) => {
      // pi-web 会用 canvas 给 favicon 画一个「全局未读/待确认计数」角标（data: URL），
      // 那个计数是所有页签共享的，会让每个页签的图标同时出现圆点。
      // 只认页面自带的静态图标，忽略动态 badge；提示点统一交给 .tab-status 控制。
      const clean = icons.find(
        (icon) => icon.length > 0 && (icon.startsWith("http://") || icon.startsWith("https://")),
      );
      if (clean) {
        tab.favicon = clean;
        this.notify();
      }
    });

    wc.on("did-start-loading", () => {
      tab.lifecycle = onDidStartLoading(tab.lifecycle);
      if (!isCrashed(tab.lifecycle)) tab.loading = true;
      this.notify();
    });

    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.refreshPath(tab);
      this.notify();
      void this.refreshTheme();
    });

    wc.on("did-finish-load", () => {
      const before = tab.lifecycle.phase;
      tab.lifecycle = onDidFinishLoad(tab.lifecycle);
      if (before === "recovering" || before === "crashed") {
        // realm 已重建：dom-ready / did-finish-load 会重装状态探测、通知、主题 observer，
        // 状态请求源下一轮重新选，服务本身不受影响。
        tab.loading = false;
        tab.title = cleanTitle(wc.getTitle()) || "新页签";
        this.statuses.noteSourceClosed(tab.id);
        this.options.onDebug?.(`[lifecycle] 页面已恢复：${tab.path}`);
      }
      this.notify();
      void this.refreshTheme();
    });

    wc.on("did-navigate", () => this.refreshPath(tab));
    wc.on("did-navigate-in-page", () => {
      this.refreshPath(tab);
      // 页签内切换会话：立刻重算一次，不等下一轮轮询
      void this.refreshTabStatuses();
    });

    wc.on("render-process-gone", (_event, details) => {
      // 只标记，不销毁页签、不自动重载、不停 pi-web 服务；保留 tab.path 里的会话 URL。
      tab.lifecycle = onRenderProcessGone(tab.lifecycle, details.reason);
      tab.loading = false;
      tab.title = crashTitle(details.reason);
      this.statuses.noteSourceClosed(tab.id);
      this.options.onDebug?.(
        `[lifecycle] 页面崩溃（${details.reason}）：保留页签与 ${tab.path}，等待用户显式重新加载`,
      );
      this.notify();
    });

    // 独立输入工作区：在 loadURL 之前挂好 dom-ready / console-message 监听
    this.options.onTabCreated?.(tab.id, wc);

    this.options.win.contentView.addChildView(view);
    view.setVisible(false);

    const insertAt = computeInsertIndex(this.tabs, options.index, tab.pinned);
    this.tabs.splice(insertAt, 0, tab);
    // 新页签属于一个窗格（默认当前焦点窗格），并排在该窗格页签条末尾
    const groupIndex = Math.min(
      Math.max(options.group ?? this.focusedGroup, 0),
      this.groups.length - 1,
    );
    this.groups[groupIndex].tabIds.push(tab.id);

    this.layout();
    void wc.loadURL(url);
    if (options.activate !== false) this.activate(tab.id);
    else this.notify();

    return tab.id;
  }

  /** 关闭页签；固定页签默认不允许关闭（需 force，比如右键菜单显式选择） */
  closeTab(id: string, force = false): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (!canCloseTab(this.tabs[index].pinned, force)) return;
    this.disposeTab(this.tabs[index], index);
  }

  closeOthers(id: string): void {
    for (const tab of [...this.tabs]) {
      if (tab.id !== id && !tab.pinned) this.closeTab(tab.id);
    }
  }

  closeRight(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    for (const tab of this.tabs.slice(index + 1)) {
      if (!tab.pinned) this.closeTab(tab.id);
    }
  }

  duplicateTab(id: string): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return;
    const groupIndex = this.groupIndexOf(id);
    const newId = this.createTab(tab.path, { activate: false, pinned: tab.pinned, group: groupIndex });
    if (!newId) return;
    // 新页签紧跟在原页签后面（同一组内），和浏览器的「复制标签页」一致
    const group = this.groups[groupIndex];
    group.tabIds = group.tabIds.filter((item) => item !== newId);
    group.tabIds.splice(group.tabIds.indexOf(id) + 1, 0, newId);
    this.activate(newId);
  }

  /* ------------------------- 分屏 API ------------------------- */

  /** 布局预设：单栏 / 左右双栏 / 上下双栏 / 三栏 / 四宫格（全部转换成 Split Tree） */
  setSplitPreset(id: SplitPreset): void {
    if (this.destroyed) return;
    const preset = presetById(id);
    this.ensureTabCount(preset.count);
    const before = this.groups;
    const sameCount = before.length === preset.count;
    // 只换方向（columns-2 ↔ rows-2）时保留用户已经拖好的分组
    const kept = sameCount
      ? before.map((pane) => ({ tabIds: [...pane.tabIds], activeId: pane.activeId }))
      : [];
    const focused = this.focusedGroup;
    const activeId = this.activeId;
    const shape = presetToTree(preset.id, sameCount ? [] : this.orderedTabIds());
    if (sameCount) {
      const panes = collectPanes(shape);
      kept.forEach((entry, i) => {
        if (!panes[i]) return;
        panes[i].tabIds = entry.tabIds;
        panes[i].activeId = entry.activeId;
      });
    } else if (preset.count === 1) {
      // 回到单栏：原来正在看的页签继续显示
      const pane = collectPanes(shape)[0];
      if (activeId && pane?.tabIds.includes(activeId)) pane.activeId = activeId;
    }
    this.root = normalizeLayout(shape, this.tabs.map((tab) => tab.id)).root;
    this.focusedGroup = Math.min(focused, this.groups.length - 1);
    this.afterGroupChange();
  }

  /** Ctrl+\ / 菜单「向右拆分」：把一个页签放进当前窗格之后的新窗格 */
  splitRight(id?: string, orientation: "columns" | "rows" = "columns"): void {
    this.splitWithTab(id ?? null, orientation);
  }

  /** 右键「在右侧 / 下方分屏显示」、Alt+点击页签、Ctrl+\ 走这里 */
  splitWithTab(id: string | null, orientation: "columns" | "rows" = "columns"): void {
    if (this.destroyed) return;
    const target = id && this.tabs.some((tab) => tab.id === id) ? id : null;
    if (!target) {
      this.splitRightAuto(orientation);
      return;
    }
    const srcIndex = this.groupIndexOf(target);
    const src = this.groups[srcIndex];
    if (!src) return;
    // 已经在某个窗格里显示着：不重复开窗格，只聚焦过去
    if (src.activeId === target && this.groups.length >= 2) {
      this.focusGroup(srcIndex);
      return;
    }
    if (this.groups.length >= MAX_PANES) {
      this.moveTabToGroup(target, (srcIndex + 1) % this.groups.length);
      return;
    }
    const direction: SplitDirection = orientation === "rows" ? "vertical" : "horizontal";
    // 最小尺寸硬约束：按源 Pane 当前实际矩形判断能否继续拆（与五方向投放共用 canSplit）
    if (!canSplit(this.root, this.layoutBounds(), src.id, direction)) {
      this.options.onDebug?.(
        `[split] 窗口太小，${orientation} 方向继续拆分会让窗格小于最小尺寸，改为移动页签`,
      );
      this.moveTabToGroup(target, (srcIndex + 1) % this.groups.length);
      return;
    }
    // 源窗格只剩这一个页签时补一个新的，避免出现空窗格（原有 Tab 不关闭、不重载）
    if (src.tabIds.length === 1) {
      this.createTab("/", { activate: false, group: srcIndex });
    }
    // 在目标 Pane 自己的区域内拆：这样才表达得出「左一右二」这类不同方向的嵌套布局
    const result = splitPane(this.root, src.id, direction, "after");
    if (!result.changed) return;
    this.root = result.root;
    this.root = moveTab(this.root, target, result.newPaneId).root;
    this.focusedPaneId = findPane(this.root, result.newPaneId)?.id ?? this.groups[0].id;
    this.afterGroupChange();
  }

  /** Ctrl+\ 不指定页签：优先拿当前组里没在显示的那个，否则复制当前页签 */
  private splitRightAuto(orientation: "columns" | "rows"): void {
    if (this.groups.length >= MAX_PANES) {
      this.focusGroupBy(1);
      return;
    }
    const current = this.groups[this.focusedGroup];
    const candidate =
      current.tabIds.find((tabId) => tabId !== current.activeId) ??
      this.orderedTabIds().find((tabId) => !this.groups.some((group) => group.activeId === tabId));
    if (candidate) {
      this.splitWithTab(candidate, orientation);
      return;
    }
    const path = this.tabs.find((tab) => tab.id === this.activeId)?.path ?? "/";
    const newId = this.createTab(path, { activate: false, group: this.focusedGroup });
    if (newId) this.splitWithTab(newId, orientation);
  }

  /** 关掉一个窗格；页签本身不关闭，合并到相邻窗格，父 SplitNode 自动 Collapse */
  closeGroup(index = this.focusedGroup): void {
    if (this.destroyed || this.groups.length <= 1) return;
    const panes = this.groups;
    const at = Math.min(Math.max(index, 0), panes.length - 1);
    const result = removePane(this.root, panes[at].id);
    if (!result.changed) return;
    this.root = result.root;
    // 焦点落到接收了被删窗格页签的那个窗格
    this.focusedPaneId = result.mergedIntoId ?? this.groups[0].id;
    this.afterGroupChange();
  }

  focusGroup(index: number): void {
    if (this.destroyed || this.groups.length === 0) return;
    this.focusedGroup = Math.min(Math.max(index, 0), this.groups.length - 1);
    this.syncActive();
    this.markVisibleSeen();
    this.notify();
    this.focusActive();
    void this.refreshTheme();
  }

  focusGroupBy(step: number): void {
    if (this.groups.length < 2) return;
    this.focusGroup((this.focusedGroup + step + this.groups.length) % this.groups.length);
  }

  /** 把页签拖到第 n 个窗格（VSCode 式分组移动）；insertIndex 是该组页签条上的插入位置 */
  moveTabToGroup(id: string, groupIndex: number, insertIndex?: number): void {
    if (this.destroyed) return;
    // drop 会先于 dragend 到达：这里直接结束拖动态，让新布局立即生效
    this.dragging = false;
    const panes = this.groups;
    const target = panes[Math.min(Math.max(groupIndex, 0), panes.length - 1)];
    if (!target) return;
    const src = panes.find((pane) => pane.tabIds.includes(id));
    // 源窗格只剩这一个页签时，先把它和目标窗格当前显示的页签互换：
    // 否则空窗格会被 RemovePane 规则关掉，「分两个展示区域」一下就没了。
    if (src && src !== target && src.tabIds.length === 1 && panes.length > 1) {
      const borrow = target.activeId ?? target.tabIds[0] ?? null;
      if (borrow && borrow !== id) {
        target.tabIds = target.tabIds.filter((tabId) => tabId !== borrow);
        src.tabIds.push(borrow);
        src.activeId = borrow;
        if (target.activeId === borrow) target.activeId = target.tabIds[0] ?? null;
      }
    }
    // 上面直接改的是树里的活节点；moveTab 返回的新树保持所有 pane id 不变
    this.root = moveTab(this.root, id, target.id, insertIndex).root;
    this.focusedPaneId = findPane(this.root, target.id)?.id ?? this.groups[0].id;
    this.afterGroupChange();
  }

  /** 拖到窗口最左 / 最右：在整棵树外面套一层 SplitNode 并放入该页签 */
  splitTabToEdge(id: string, side: "left" | "right"): void {
    if (this.destroyed) return;
    this.dragging = false;
    if (this.groups.length >= MAX_PANES) {
      this.moveTabToGroup(id, side === "left" ? 0 : this.groups.length - 1);
      return;
    }
    // 在整棵树外面套一层前，同样按当前窗口尺寸检查最小尺寸
    if (!canAddEdge(this.root, this.layoutBounds(), side)) {
      this.options.onDebug?.("[split] 窗口太小，无法在窗口边缘新建窗格，改为移动页签");
      this.moveTabToGroup(id, side === "left" ? 0 : this.groups.length - 1);
      return;
    }
    const src = this.groups.find((pane) => pane.tabIds.includes(id));
    if (src && src.tabIds.length === 1 && this.groups.length === 1) {
      this.createTab("/", { activate: false, group: this.groups.indexOf(src) });
    }
    const result = addEdgePane(this.root, side);
    if (!result.changed) return;
    this.root = result.root;
    this.root = moveTab(this.root, id, result.newPaneId).root;
    this.focusedPaneId = findPane(this.root, result.newPaneId)?.id ?? this.groups[0].id;
    this.afterGroupChange();
  }

  newTabInGroup(index: number): void {
    if (this.destroyed) return;
    const panes = this.groups;
    const at = Math.min(Math.max(index, 0), panes.length - 1);
    const paneId = panes[at].id;
    const id = this.createTab("/", { activate: false, group: at });
    if (!id) return;
    const pane = findPane(this.root, paneId);
    if (pane) pane.activeId = id;
    this.focusedPaneId = paneId;
    this.afterGroupChange();
  }

  /** 拖动期间隐藏所有内容视图，让页签栏渲染层的「投放区」露出来 */
  beginTabDrag(): void {
    if (this.destroyed) return;
    this.dragging = true;
    for (const tab of this.tabs) tab.view.setVisible(false);
    this.shownTabIds.clear();
    this.stopTabDragWatchdog();
    this.tabDragWatchdog = setTimeout(() => this.endTabDrag(), 30_000);
    this.tabDragWatchdog.unref?.();
  }

  endTabDrag(): void {
    if (this.destroyed) return;
    this.dragging = false;
    this.stopTabDragWatchdog();
    this.layout();
    this.focusActive();
  }

  private stopTabDragWatchdog(): void {
    if (this.tabDragWatchdog) clearTimeout(this.tabDragWatchdog);
    this.tabDragWatchdog = null;
  }

  /* ------------------------- 分隔条拖动（M2） ------------------------- */

  /** 开始拖某个 SplitNode 的分隔条 */
  beginSashDrag(splitId: string): void {
    if (this.destroyed || !findSplit(this.root, splitId)) return;
    this.stopSashTimers();
    this.sashDragging = true;
    this.sashDragSplitId = splitId;
    this.lastSashAt = Date.now();
    // WebContentsView 是原生子视图，指针移到内容区后 renderer 收不到鼠标事件。
    // 主进程以屏幕坐标轮询作为可靠输入源（16ms ≈ 一帧），不隐藏 / 不重建任何视图。
    this.sashTimer = setInterval(() => this.pollSashRatio(), 16);
    this.sashTimer.unref?.();
    // 渲染层崩溃 / 鼠标释放事件全部丢失时的最后兜底（30s，正常拖动不会触发）
    this.sashWatchdog = setTimeout(() => this.endSashDrag(), 30_000);
    this.sashWatchdog.unref?.();
  }

  /** renderer 的 pointermove（低延迟路径）；与主进程轮询结果一致，靠时间戳 + ratio 差量去重 */
  setSashRatio(splitId: string, x: number, y: number, stamp: number): void {
    if (this.destroyed || !this.sashDragging || splitId !== this.sashDragSplitId) return;
    this.applySashRatio(splitId, x, y, stamp);
  }

  /** 轮询屏幕坐标：换算成窗口内容区坐标后交给同一份布局结果算 ratio */
  private pollSashRatio(): void {
    if (!this.sashDragging || !this.sashDragSplitId || this.options.win.isDestroyed()) return;
    try {
      const stamp = Date.now();
      const point = screen.getCursorScreenPoint();
      const bounds = this.options.win.getContentBounds();
      this.applySashRatio(this.sashDragSplitId, point.x - bounds.x, point.y - bounds.y, stamp);
    } catch {
      // 个别平台不支持 getCursorScreenPoint：退化成只由 renderer 的 pointermove 驱动
    }
  }

  /** 只改 ratio + bounds：不动可见性集合、不 focus、不写盘 */
  private applySashRatio(splitId: string, x: number, y: number, stamp: number): void {
    // 比主进程轮询更旧的 IPC 直接丢弃（2ms 容忍度覆盖跨进程时钟误差）
    if (stamp < this.lastSashAt - 2) return;
    const [width, height] = this.options.win.isDestroyed() ? [1, 1] : this.options.win.getContentSize();
    const ratio = ratioFromPointer(this.root, splitId, { x: 0, y: 0, width, height }, x, y);
    if (ratio === null) return;
    const current = findSplit(this.root, splitId)?.ratio;
    if (current !== undefined && Math.abs(current - ratio) < 0.0005) {
      this.lastSashAt = Math.max(this.lastSashAt, stamp);
      return;
    }
    this.lastSashAt = Math.max(this.lastSashAt, stamp);
    this.root = setRatio(this.root, splitId, ratio).root;
    this.layout();
    this.notify();
  }

  /** 松开 / 取消：停轮询、退出拖动态、一次性落盘最终比例 */
  endSashDrag(): void {
    if (!this.sashDragging) return;
    this.sashDragging = false;
    this.sashDragSplitId = null;
    this.stopSashTimers();
    this.notify(); // 把最终比例推给渲染层（顺带排一次 debounce 保存）
    this.persist(); // 立即落盘，并清掉上面的 debounce，全程只写一次
  }

  private stopSashTimers(): void {
    if (this.sashTimer) clearInterval(this.sashTimer);
    this.sashTimer = null;
    if (this.sashWatchdog) clearTimeout(this.sashWatchdog);
    this.sashWatchdog = null;
  }

  /* ------------------------- 五方向拖拽（M3） ------------------------- */

  /** 预览：用与落位**同一个** applyTabDrop 算出「假想拖放后的树」，再递归算一次布局。
   *  绝不改动 this.root，所以拖放取消天然恢复原状；位置与最小尺寸约束仍由主进程唯一计算。 */
  previewTabDrop(
    id: string,
    targetPaneId: string,
    side: DropSide,
    insertIndex?: number,
  ): DropPreview {
    const bounds = this.layoutBounds();
    const result = applyTabDrop(this.root, id, targetPaneId, side, bounds, insertIndex);
    const layout = computeLayoutRects(result.root, bounds);
    return {
      allowed: result.allowed,
      reason: result.reason,
      side: result.effectiveSide,
      targetPaneId,
      destinationPaneId: result.destinationPaneId,
      createsPane: result.createsPane,
      paneCount: paneCount(result.root),
      panes: layout.panes,
      sashes: layout.sashes,
    };
  }

  /** 落位：与预览共用同一个纯函数，保证「预览看到的 = 真正得到的」 */
  dropTab(id: string, targetPaneId: string, side: DropSide, insertIndex?: number): void {
    if (this.destroyed) return;
    const bounds = this.layoutBounds();
    const probe = applyTabDrop(this.root, id, targetPaneId, side, bounds, insertIndex);
    if (!probe.allowed || !probe.changed) {
      this.endTabDrag();
      return;
    }
    // 源 Pane 只剩最后一个 Tab：先补一个空白页签保住它（与 M1 splitWithTab 一致，
    // 不关闭、不重建、不重载任何原有 Tab，且窗格数确实 +1）
    if (probe.placeholderPaneId) {
      const index = this.groups.findIndex((pane) => pane.id === probe.placeholderPaneId);
      if (index >= 0) this.createTab("/", { activate: false, group: index });
    }
    const final = applyTabDrop(this.root, id, targetPaneId, side, bounds, insertIndex);
    if (!final.allowed || !final.changed) {
      this.endTabDrag();
      return;
    }
    this.root = final.root;
    this.focusedPaneId = findPane(this.root, final.destinationPaneId)?.id ?? this.groups[0].id;
    this.afterGroupChange(); // dragging=false → layout() 恢复视图，不重建、不重载
  }

  /** 页签栏右侧「分屏」按钮的下拉菜单 */
  showSplitMenu(x: number, y: number): void {
    if (this.destroyed) return;
    const current = presetFor(this.groups.length, this.effectiveLayout());
    const items: MenuItemConstructorOptions[] = SPLIT_PRESETS.map((preset) => ({
      label: preset.shortcut ? `${preset.label}\t${preset.shortcut}` : preset.label,
      type: "checkbox",
      checked: current === preset.id,
      click: () => this.setSplitPreset(preset.id),
    }));
    items.push(
      { type: "separator" },
      {
        label: "向右拆分当前页签\tCtrl+\\",
        enabled: this.groups.length < MAX_PANES,
        click: () => this.splitRight(),
      },
      {
        label: "关闭当前窗格\tCtrl+Shift+\\",
        enabled: this.groups.length > 1,
        click: () => this.closeGroup(),
      },
    );
    if (this.groups.length > 1) {
      items.push({
        label: "焦点移到窗格",
        submenu: this.groups.map((group, index) => {
          const tab = this.tabs.find((item) => item.id === group.activeId);
          return {
            label: `窗格 ${index + 1} · ${tab?.title || "新页签"}`,
            type: "radio" as const,
            checked: index === this.focusedGroup,
            click: () => this.focusGroup(index),
          };
        }),
      });
    }
    items.push(
      { type: "separator" },
      { label: "拖动页签到任意一侧 · Ctrl+数字仍是切换页签", enabled: false },
    );
    Menu.buildFromTemplate(items).popup({
      window: this.options.win,
      x: Math.round(x),
      y: Math.round(y),
    });
  }

  /** 某个窗格的右键/更多菜单：把哪个页签移动到这里 */
  showGroupMenu(index: number, x: number, y: number): void {
    if (this.destroyed) return;
    const at = Math.min(Math.max(index, 0), this.groups.length - 1);
    const group = this.groups[at];
    if (!group) return;
    const items: MenuItemConstructorOptions[] = this.tabs.map((tab) => ({
      label: `${tab.pinned ? "📌 " : ""}${tab.title || "新页签"}`,
      type: "checkbox",
      checked: tab.id === group.activeId,
      click: () => this.moveTabToGroup(tab.id, at),
    }));
    items.push(
      { type: "separator" },
      { label: "在此窗格新建页签", click: () => this.newTabInGroup(at) },
      { label: "关闭此窗格", enabled: this.groups.length > 1, click: () => this.closeGroup(at) },
      {
        label: "退出分屏",
        enabled: this.groups.length > 1,
        click: () => this.setSplitPreset("single"),
      },
    );
    Menu.buildFromTemplate(items).popup({
      window: this.options.win,
      x: Math.round(x),
      y: Math.round(y),
    });
  }

  /** 点页签 / Ctrl+数字 / 托盘：切到它所在的窗格并让它显示（单栏时行为与以前完全一致） */
  activate(id: string): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return;
    const groupIndex = this.groupIndexOf(id);
    this.focusedGroup = groupIndex;
    this.groups[groupIndex].activeId = id;
    this.afterGroupChange();
  }

  activateIndex(position: number): void {
    // Ctrl+9 = 最后一个页签
    if (position === 9) {
      const last = this.tabs.at(-1);
      if (last) this.activate(last.id);
      return;
    }
    const tab = this.tabs[position - 1];
    if (tab) this.activate(tab.id);
  }

  cycle(step: number): void {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (index + step + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  move(id: string, targetIndex: number): void {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const tab = this.tabs[from];
    const to = moveTargetIndex(this.tabs, from, targetIndex);
    if (to === from) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.reorderGroupsByTabs();
    this.notify();
  }

  setPinned(id: string, pinned: boolean): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tab = this.tabs[index];
    if (tab.pinned === pinned) return;
    this.tabs.splice(index, 1);
    tab.pinned = pinned;
    // 固定 → 放到固定区末尾；取消固定 → 放到非固定区开头；两者插入点相同
    this.tabs.splice(pinnedReorderIndex(this.tabs), 0, tab);
    this.notify();
  }

  reloadActive(ignoreCache = false): void {
    const wc = this.activeContents();
    if (!wc) return;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  }

  toggleDevTools(): void {
    this.activeContents()?.toggleDevTools();
  }

  zoomBy(step: number): void {
    const wc = this.activeContents();
    if (!wc) return;
    const next = Math.min(Math.max(wc.getZoomLevel() + step, -3), 4);
    wc.setZoomLevel(next);
  }

  resetZoom(): void {
    this.activeContents()?.setZoomLevel(0);
  }

  /** 调试/验证用：截当前激活页签的画面 */
  async captureActive(): Promise<Electron.NativeImage | null> {
    const wc = this.activeContents();
    if (!wc) return null;
    try {
      return await wc.capturePage();
    } catch {
      return null;
    }
  }

  /** 关闭窗口时销毁所有视图 */
  destroy(): void {
    this.destroyed = true;
    if (!this.options.win.isDestroyed()) {
      this.options.win.off("focus", this.onWindowFocus);
      this.options.win.off("blur", this.onWindowBlur);
      if (!this.options.win.webContents.isDestroyed()) {
        this.options.win.webContents.off("before-input-event", this.windowShortcutHandler);
      }
    }
    this.themes.stop();
    this.stopTabDragWatchdog();
    if (this.sashDragging) this.endSashDrag();
    this.stopSashTimers();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.notifications.dispose();
    for (const tab of [...this.tabs]) {
      this.disposeTab(tab, 0, { keepWindow: true });
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }

  showMenu(id: string, x: number, y: number): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return;
    const splitItems: MenuItemConstructorOptions[] = [
      { label: "在右侧分屏显示\tCtrl+\\", click: () => this.splitWithTab(id, "columns") },
      { label: "在下方分屏显示", click: () => this.splitWithTab(id, "rows") },
    ];
    if (this.groups.length > 1) {
      splitItems.push({
        label: "移动到窗格",
        submenu: this.groups.map((group, index) => {
          const tab = this.tabs.find((item) => item.id === group.activeId);
          return {
            label: `窗格 ${index + 1} · ${tab?.title || "新页签"}${group.tabIds.includes(id) ? "（已在此）" : ""}`,
            click: () => this.moveTabToGroup(id, index),
          };
        }),
      });
    }
    const menu = Menu.buildFromTemplate([
      { label: tab.pinned ? "取消固定" : "固定页签", click: () => this.setPinned(id, !tab.pinned) },
      { type: "separator" },
      ...splitItems,
      { type: "separator" },
      {
        label: isCrashed(tab.lifecycle) ? "重新加载崩溃页面" : "重新加载",
        click: () => void this.reloadCrashed(id),
      },
      { label: "复制会话链接", click: () => clipboard.writeText(this.absoluteLink(tab.path)) },
      { label: "在新页签打开", click: () => this.duplicateTab(id) },
      { type: "separator" },
      { label: "关闭页签", click: () => this.closeTab(id, true) },
      { label: "关闭其他页签", click: () => this.closeOthers(id) },
      { label: "关闭右侧页签", click: () => this.closeRight(id) },
    ]);
    menu.popup({ window: this.options.win, x: Math.round(x), y: Math.round(y) });
  }

  /* ----------------------------- 内部 ----------------------------- */

  private disposeTab(tab: Tab, index: number, options: { keepWindow?: boolean } = {}): void {
    // destroy()/回到启动页会带 keepWindow:true 逐个销毁视图，那不是「用户关页签」，
    // 绝不能清掉草稿，否则应用重启恢复就永远拿不到数据。
    if (!options.keepWindow) this.options.onTabClosed?.(tab.id);
    this.tabs.splice(index, 1);
    tab.lifecycle = markDestroyed(tab.lifecycle);
    // 状态请求源被关闭：下一轮自动选别的页面；同时摘掉这个页面的通知监听
    this.statuses.noteSourceClosed(tab.id);
    this.notifications.detach(tab.view.webContents);
    this.themes.detach(tab.view.webContents);
    try {
      this.options.win.contentView.removeChildView(tab.view);
    } catch {
      // 窗口可能已经销毁
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    // 从它所属的 PaneNode 里摘掉；空窗格 / 失效 active / 单子节点由 normalizeLayout 统一整理
    for (const pane of this.groups) {
      pane.tabIds = pane.tabIds.filter((tabId) => tabId !== tab.id);
      if (pane.activeId === tab.id) pane.activeId = null;
    }

    if (this.tabs.length === 0) {
      this.root = createPane();
      this.focusedPaneId = this.groups[0].id;
      this.syncActive();
      if (options.keepWindow || this.destroyed) {
        this.notify();
        return;
      }
      // 不留空窗口：最后一个页签关掉就开一个新的
      this.createTab("/");
      return;
    }

    this.root = normalizeLayout(this.root, this.tabs.map((item) => item.id)).root;
    this.focusedPaneId = findPane(this.root, this.focusedPaneId)?.id ?? this.groups[0].id;
    this.afterGroupChange();
  }

  private activeTab(): Tab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }

  activeContents(): WebContents | undefined {
    return this.activeTab()?.view.webContents;
  }

  private focusActive(): void {
    this.activeContents()?.focus();
  }

  /* ------------------------- 分屏内部 ------------------------- */

  /** 布局类型由树里的 SplitNode 方向推导（单栏恒为 columns） */
  private effectiveLayout(): SplitLayout {
    return this.groups.length > 1 ? layoutKind(this.root) : "columns";
  }

  private syncActive(): void {
    this.activeId = this.groups[this.focusedGroup]?.activeId ?? null;
  }

  /** 分组/焦点变化后统一收尾（重排、聚焦、通知、刷新主题） */
  private afterGroupChange(): void {
    this.dragging = false;
    this.stopTabDragWatchdog();
    this.syncActive();
    this.markVisibleSeen();
    this.layout();
    this.focusActive();
    this.notify();
    void this.refreshTheme();
  }

  /** 所有「正在显示」的页签都算已查看，不该再弹未读点 */
  private markVisibleSeen(): void {
    for (const group of this.groups) {
      const tab = this.tabs.find((item) => item.id === group.activeId);
      if (!tab) continue;
      tab.pendingUnreadAt = null;
      tab.seenUnreadAt = null;
      if (tab.status === "unread") tab.status = tab.awaiting ? "awaiting" : "idle";
    }
  }

  /** 页面 focus / 页面内按键告诉我们「用户正在用哪个窗格」 */
  private noteGroupFocus(id: string, focusView = false): void {
    const index = this.groups.findIndex((group) => group.activeId === id);
    if (index < 0) return;
    if (index !== this.focusedGroup) {
      this.focusedGroup = index;
      this.syncActive();
      this.markVisibleSeen();
      this.notify();
      void this.refreshTheme();
    }
    if (focusView) this.focusActive();
  }

  private groupIndexOf(id: string): number {
    const index = this.groups.findIndex((group) => group.tabIds.includes(id));
    return index >= 0 ? index : 0;
  }

  /** 所有页签按「窗格顺序 + 组内顺序」展开（用于重新分配 / Ctrl+数字） */
  private orderedTabIds(): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const group of this.groups) {
      for (const id of group.tabIds) {
        if (!seen.has(id) && this.tabs.some((tab) => tab.id === id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    for (const tab of this.tabs) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id);
        ids.push(tab.id);
      }
    }
    return ids;
  }

  private ensureTabCount(count: number): void {
    while (this.tabs.length < count && !this.destroyed) {
      if (!this.createTab("/", { activate: false })) break;
    }
  }

  /** 单栏拖动排序后，让各组的页签条顺序跟着 tabs[] 走 */
  private reorderGroupsByTabs(): void {
    const owner = new Map<string, number>();
    this.groups.forEach((group, i) => group.tabIds.forEach((id) => owner.set(id, i)));
    for (const group of this.groups) group.tabIds = [];
    for (const tab of this.tabs) {
      const i = owner.get(tab.id) ?? 0;
      this.groups[Math.min(i, this.groups.length - 1)].tabIds.push(tab.id);
    }
  }

  /** 重启恢复：优先 v2 Split Tree，其次迁移 v1 split；任何异常都安全降级为单窗格 */
  private restoreLayout(persisted: PersistedTabs, activeIndex: number): void {
    const ids = this.tabs.map((tab) => tab.id);
    const idAt = (index: number): string | null => ids[index] ?? null;
    let root: LayoutNode | null = null;
    let focusedPaneId: string | null = null;

    // loadTabs 已经校验过 layout.version；没有 layout 时退回旧版 groups/layout 迁移
    if (persisted.layout) {
      root = fromPersistedTree(persisted.layout.root, idAt);
      focusedPaneId = persisted.layout.focusedPaneId;
    } else if (persisted.split && persisted.split.groups.length >= 2) {
      const migrated = legacySplitToTree(persisted.split, ids.length, idAt);
      if (migrated) {
        root = migrated.root;
        focusedPaneId = migrated.focusedPaneId;
      }
    }
    if (!root) return; // 没有分屏数据：保持启动时的普通单窗格

    this.root = normalizeLayout(root, ids).root;
    if (paneCount(this.root) < 2) {
      // 只剩一个 Pane → 自动恢复普通单窗格布局
      this.focusedPaneId = this.groups[0].id;
      this.afterGroupChange();
      return;
    }
    this.focusedPaneId = findPane(this.root, focusedPaneId ?? "")?.id ?? this.groups[0].id;

    // 持久化里的激活页签要显示在它所属的窗格里（活动页签语义不变）
    const activeTabId = ids[activeIndex];
    if (activeTabId) {
      const owner = this.groups.find((pane) => pane.tabIds.includes(activeTabId));
      if (owner) {
        owner.activeId = activeTabId;
        this.focusedPaneId = owner.id;
      }
    }
    this.afterGroupChange(); // notify() → scheduleSave()：迁移成功后立即回写 v2
  }

  /** 只显示每个窗格 active 的视图，bounds = 窗格外框去掉顶部那条页签条。
   *  与 snapshot() 共用 syncLayout() 的同一份递归计算结果。 */
  private layout(): void {
    if (this.destroyed || this.dragging || this.options.win.isDestroyed()) return;
    const layout = this.syncLayout();
    const [windowWidth] = this.options.win.getContentSize();
    const nextVisible = new Set<string>();
    for (const { id: paneId, rect } of layout.panes) {
      const activeId = findPane(this.root, paneId)?.activeId;
      if (!activeId) continue;
      const tab = this.tabs.find((item) => item.id === activeId);
      if (!tab) continue;
      nextVisible.add(activeId);
      const content = paneContentRect(rect);
      // 面板展开时只收窄贴着右边缘的内容视图，绝不浮在对话上面；
      // split.rects 保持原样，页签条与 WCO 窗口控件不位移。
      const available = Math.max(1, windowWidth - content.x - this.reservedRightWidth);
      tab.view.setBounds({ ...content, width: Math.max(1, Math.min(content.width, available)) });
    }
    // 只切真正变化的可见性：分隔条拖动时 active 集合不变 → 零次 setVisible，页面不闪
    for (const tab of this.tabs) {
      const was = this.shownTabIds.has(tab.id);
      const should = nextVisible.has(tab.id);
      if (was !== should) tab.view.setVisible(should);
    }
    this.shownTabIds = nextVisible;
  }

  private refreshPath(tab: Tab): void {
    const current = tab.view.webContents.getURL();
    if (!current) return;
    tab.path = this.toRelative(current);
  }

  private toInfo(tab: Tab): TabInfo {
    return {
      id: tab.id,
      title: tab.title,
      favicon: tab.favicon,
      pinned: tab.pinned,
      loading: tab.loading,
      status: tab.status,
      crashed: isCrashed(tab.lifecycle),
      crashReason: tab.lifecycle.crashReason,
    };
  }

  /**
   * 用户显式重新加载崩溃页签。
   * 先验证服务端仍在应答（任何 HTTP 状态码都算存活，兼容 Basic Auth），
   * 再用持久化的会话 URL 恢复；不盲目重载所有页面、不停服务、不销毁页签。
   */
  async reloadCrashed(id: string): Promise<boolean> {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const wc = tab.view.webContents;
    // 恢复进行中：忽略重复点击，避免第二次 loadURL
    if (tab.lifecycle.phase === "recovering") return false;
    if (!canRecover(tab.lifecycle)) {
      // 未崩溃的页签走普通 reload（右键菜单的「重新加载」）
      wc.reload();
      return true;
    }
    const healthy = await isServing(this.options.baseUrl, 2_000);
    tab.lifecycle = beginRecovery(tab.lifecycle);
    tab.loading = true;
    this.notify();
    if (!healthy) {
      tab.lifecycle = failRecovery(tab.lifecycle, "服务未就绪");
      tab.loading = false;
      this.notify();
      this.options.onDebug?.("[lifecycle] 服务未应答，暂不重载崩溃页面");
      return false;
    }
    const url = this.toAbsolute(tab.path);
    if (!url) return false;
    this.statuses.noteSourceClosed(tab.id);
    void wc.loadURL(url);
    return true;
  }

  /* ------------------------- 页签状态 ------------------------- */

  /** 定时器入口：共享快照 / 选源 / 每页签计算都交给 TabStatusManager */
  private refreshTabStatuses(): void {
    if (this.destroyed || !this.statusProbeEnabled) return;
    if (this.demoStatus) {
      this.cycleDemoStatus();
      return;
    }
    void this.statuses.refresh();
  }

  /** PI_WEB_DESKTOP_SELFTEST_STATUS=1：每 2.2s 换一种状态，方便不跑对话也能截图验收 */
  private cycleDemoStatus(): void {
    const tab = this.tabs[0];
    if (!tab) return;
    const order: TabStatus[] = ["running", "unread", "awaiting", "idle"];
    const next = order[Math.floor(Date.now() / 2_200) % order.length];
    if (tab.status === next) return;
    tab.status = next;
    this.options.onDebug?.(`[selftest-status] 第一个页签演示状态：${next}`);
    this.notify();
  }

  /** 把探测结果折算成页签栏的四种状态；返回是否有变化 */
  private applyTabStatus(tab: Tab, probe: TabStatusProbe): boolean {
    const previous = tab.status;
    const wasRunning = tab.running;

    if (probe.sessionId && probe.sessionId !== tab.sessionId) {
      // 页签里换了对话：旧对话的未读不该继续挂在这个页签上
      tab.sessionId = probe.sessionId;
      tab.pendingUnreadAt = null;
      tab.seenUnreadAt = null;
    } else if (probe.sessionId) {
      tab.sessionId = probe.sessionId;
    }
    tab.running = probe.running;
    tab.awaiting = probe.awaiting;

    // 「回答完毕」= 这个页签自己的会话从 running 掉下来。
    // 只认「本页签的会话」这一跳变，绝不使用 pi-web 的全局未读标记
    //（那个是会话级、跨页签共享、还会残留历史会话，会让所有页签一起亮）。
    // 分屏里能同时看见多个页签：所有正在显示的都算「正在看」，不该再亮未读点
    const visible = this.groups.some((group) => group.activeId === tab.id);
    if (wasRunning && !probe.running && !visible) {
      tab.pendingUnreadAt = Date.now();
    }
    if (probe.running) tab.pendingUnreadAt = null;
    // 正在看的页签：任何新到达的未读都算「已看过」，免得切走后又冒出旧提示
    if (visible) tab.seenUnreadAt = tab.pendingUnreadAt;

    const unread =
      tab.pendingUnreadAt !== null &&
      tab.pendingUnreadAt !== tab.seenUnreadAt &&
      !visible;
    tab.status = probe.running
      ? "running"
      : probe.awaiting
        ? "awaiting"
        : unread
          ? "unread"
          : "idle";

    if (this.debugStatus && tab.status !== previous) {
      this.options.onDebug?.(
        `[status] ${tab.title}: ${previous} → ${tab.status}（session=${probe.sessionId ?? "—"}/${probe.sessionSource ?? "—"}, ready=${probe.ready}）`,
      );
    }
    return tab.status !== previous;
  }

  private notify(): void {
    if (this.destroyed) return;
    // 页签切换 / 会话切换 / 分屏焦点变化都会走到这里；工作区自己按签名去重。
    // 分隔条拖动只改尺寸，不该让草稿面板 / 输入状态跟着刷新。
    if (!this.sashDragging) this.options.onTabContextChanged?.();
    const snapshot = this.snapshot();
    const win = this.options.win;
    if (!win.isDestroyed()) win.webContents.send(TAB_IPC.changedEvent, snapshot);
    this.options.onTabsChanged?.(snapshot);
    if (win.isDestroyed()) return;
    const active = this.activeTab();
    win.setTitle(active?.title ? `${active.title}` : "Pi Web Desktop");
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.sashDragging) return; // 拖动期间绝不写盘
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立即写一次 tabs.json（分隔条拖动结束时用，避免 debounce 期间退出丢比例） */
  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    saveTabs(
      this.options.dataDir,
      toPersistedTabs({
        tabs: this.tabs,
        activeId: this.activeId,
        groups: this.groups,
        focused: this.focusedGroup,
        layout: this.effectiveLayout(),
        tree: this.root,
        focusedPaneId: this.focusedPaneId,
      }),
    );
  }

  /** 同源 → 绝对 URL；站外 → null（调用方交给系统浏览器） */
  private toAbsolute(input?: string): string | null {
    const base = this.options.baseUrl;
    if (!input || input === "about:blank") return `${base}/`;
    try {
      const url = new URL(input, `${base}/`);
      if (url.origin !== new URL(base).origin) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  private toRelative(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== new URL(this.options.baseUrl).origin) return "/";
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "/";
    }
  }

  private absoluteLink(path: string): string {
    try {
      return new URL(path, `${this.options.baseUrl}/`).toString();
    } catch {
      return this.options.baseUrl;
    }
  }

  /**
   * 快捷键分两层，互不打架：
   *   Ctrl+数字      = 切页签（浏览器习惯，保持不动）
   *   Ctrl+Alt+数字  = 分几栏 / 什么布局
   *   Ctrl+\        = 向右拆分（VSCode 的原始快捷键）；+Shift = 关闭当前窗格
   *   Ctrl+Alt+方向 = 在窗格间移动焦点
   * tabId 不为空说明这是某个页签视图：按键落在哪个窗格，就以哪个窗格为「当前窗格」。
   */
  private attachShortcuts(wc: WebContents, tabId?: string): ShortcutHandler {
    const handler: ShortcutHandler = (event, input) => {
      // 分隔条拖动：所有视图（含窗口自身）上的 mouseUp 都能可靠结束拖动
      if (this.sashDragging && input.type === "mouseUp") {
        this.endSashDrag();
        return;
      }
      if (input.type !== "keyDown") return;
      if (tabId) this.noteGroupFocus(tabId);
      const ctrl = input.control || input.meta;
      const key = input.key.toLowerCase();

      if (!ctrl) {
        if (key === "f12") {
          event.preventDefault();
          this.toggleDevTools();
          return;
        }
        if (key === "f11") {
          event.preventDefault();
          const win = this.options.win;
          if (!win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
        }
        return;
      }

      /* ---------------- 分屏层：Ctrl+Alt ---------------- */
      if (input.alt) {
        if (/^[1-4]$/.test(key)) {
          event.preventDefault();
          const presets: SplitPreset[] = ["single", "columns-2", "columns-3", "grid-2x2"];
          this.setSplitPreset(presets[Number(key) - 1]);
          return;
        }
        if (key === "arrowleft" || key === "arrowup") {
          event.preventDefault();
          this.focusGroupBy(-1);
          return;
        }
        if (key === "arrowright" || key === "arrowdown") {
          event.preventDefault();
          this.focusGroupBy(1);
          return;
        }
        // 其它 Ctrl+Alt 组合不拦截，留给页面 / 系统
        return;
      }

      /* ---------------- 分屏层：Ctrl+\ ---------------- */
      const isBackslash = input.code === "Backslash" || key === "\\" || key === "|";
      if (isBackslash) {
        event.preventDefault();
        if (input.shift) this.closeGroup();
        else this.splitRight();
        return;
      }

      if (key === "t") {
        event.preventDefault();
        this.createTab("/");
        return;
      }
      if (key === "w") {
        event.preventDefault();
        const active = this.activeTab();
        if (active) this.closeTab(active.id);
        return;
      }
      if (key === "tab") {
        event.preventDefault();
        this.cycle(input.shift ? -1 : 1);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        event.preventDefault();
        this.activateIndex(Number(key));
        return;
      }
      if (key === "r") {
        event.preventDefault();
        this.reloadActive(input.shift);
        return;
      }
      if (key === "i" && input.shift) {
        event.preventDefault();
        this.toggleDevTools();
        return;
      }
      if (key === "+" || key === "=") {
        event.preventDefault();
        this.zoomBy(0.5);
        return;
      }
      if (key === "-") {
        event.preventDefault();
        this.zoomBy(-0.5);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        this.resetZoom();
      }
    };
    wc.on("before-input-event", handler);
    return handler;
  }
}

/** 页面标题形如 "会话名 - Pi Web"，页签上只留会话名 */
function cleanTitle(title: string): string {
  return title.replace(/\s*[-–—]\s*Pi\s*Web\s*$/i, "").trim();
}
