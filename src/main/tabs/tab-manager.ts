import {
  clipboard,
  Menu,
  nativeTheme,
  shell,
  WebContentsView,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import type { TabInfo, TabStatus, TabsSnapshot, ThemeSnapshot } from "../../shared/types";
import { TAB_IPC } from "../../shared/types";
import {
  computePaneRects,
  MAX_PANES,
  paneContentRect,
  presetById,
  presetFor,
  SPLIT_PRESETS,
  type PaneRect,
  type SplitLayout,
  type SplitPreset,
} from "../../shared/split";
import { defaultSymbolColor, setTitleBarColors, TITLEBAR_HEIGHT, toOpaqueHex } from "../titlebar";
import {
  TAB_STATUS_PROBE_SCRIPT,
  TAB_STATUS_READ_SCRIPT,
  type TabStatusProbe,
} from "./tab-status";
import { loadTabs, saveTabs, type PersistedSplit } from "./tab-persistence";
import { saveTheme } from "./theme-persistence";
import { COMPOSER_EXPAND_SCRIPT } from "./composer-expand";

/** 页签栏高度（CSS 里的 --tabbar-height、shared/split.ts 里的 TABBAR_HEIGHT 必须一致） */
export const TABBAR_HEIGHT = TITLEBAR_HEIGHT;

/** 没有缓存（首次启动 / 缓存被删）时，回退到系统明暗 */
function systemFallbackTheme(): ThemeSnapshot {
  const scheme: "light" | "dark" = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return { name: scheme, scheme, vars: {}, fromPage: false };
}

const SAVE_DEBOUNCE_MS = 300;
/** 页签状态轮询间隔（和主题探测一样是主进程主动读，页面里不装常驻定时器）
 *  比 pi-web 自己的 2.5s 轮询快，尽量不漏掉短回答的 running→idle 跳变 */
const STATUS_POLL_MS = 700;
/** 单个页签读取状态的超时：某个页面卡住时不能把其他页签的轮询一起拖死 */
const STATUS_READ_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tab status read timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * pi-web 任务完成通知优先走 ServiceWorkerRegistration.showNotification()。
 * 实测 Electron/Windows 上这条路径会 resolve，但 Windows 通知历史里根本没有 toast；
 * 而 pi-web 的 y1() 一旦成功就直接返回 "service-worker"，不再回落 new Notification()。
 * 另外 WebContentsView 的 document.hasFocus() 在主窗口失焦后仍返回 true（Chrome 会变 false），
 * 会让 pi-web 的 y0() 判定「页面仍在前台」而根本不发通知。
 * 这段补丁做两件事：让 SW showNotification reject 回落到 window.Notification；
 * 把主窗口焦点状态同步成 __piDesktopWindowFocused，并让 document.hasFocus() 跟随它。
 * 同时包装 window.Notification：把当前页签（页面标题，即会话名/项目名）拼进通知标题，
 * 否则多项目同时跑时，通知只有「任务完成」看不出是哪个会话。
 * 不改 pi-web 文件，只在每次页面加载后注入；标记保证幂等。
 */
const WINDOWS_NOTIFICATION_PATCH = String.raw`(() => {
  try {
    if (window.__piDesktopWindowFocused === undefined) {
      window.__piDesktopWindowFocused = true;
    }
    if (!document.__piDesktopHasFocusPatch) {
      const original = document.hasFocus.bind(document);
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        writable: true,
        value: function () {
          return window.__piDesktopWindowFocused === false ? false : original();
        },
      });
      Object.defineProperty(document, "__piDesktopHasFocusPatch", { value: true });
    }
    const proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    if (proto && !proto.__piDesktopNotificationPatch) {
      proto.showNotification = function () {
        return Promise.reject(new Error("pi-web-desktop: force window.Notification fallback"));
      };
      Object.defineProperty(proto, "__piDesktopNotificationPatch", { value: true });
    }
    const OriginalNotification = window.Notification;
    if (OriginalNotification && !window.__piDesktopNotificationWrapped) {
      const tabTitle = function () {
        try {
          return (document.title || "").replace(/\s*[-\u2013\u2014]\s*Pi\s*Web\s*$/i, "").trim();
        } catch (e) { return ""; }
      };
      class PiDesktopNotification extends OriginalNotification {
        constructor(title, options) {
          // 通知比接口先到时，立刻告诉状态探测脚本「这一轮完成了」，页签不用等接口轮询追上
          try {
            const probe = window.__piDesktopTabStatus;
            if (probe && typeof probe.markDone === "function") probe.markDone();
          } catch (e) {}
          let finalTitle = typeof title === "string" ? title : "";
          try {
            const tab = tabTitle();
            if (tab && finalTitle && finalTitle.indexOf(tab) === -1) {
              finalTitle = tab + " — " + finalTitle;
            } else if (tab && !finalTitle) {
              finalTitle = tab;
            }
          } catch (e) {}
          super(finalTitle, options);
        }
      }
      window.Notification = PiDesktopNotification;
      Object.defineProperty(window, "__piDesktopNotificationWrapped", { value: true });
    }
  } catch {}
})()`;

type ShortcutHandler = (event: Electron.Event, input: Electron.Input) => void;

/** 一个窗格 = VSCode 的一个编辑器组：它有哪些页签、当前显示哪个 */
interface PaneGroup {
  tabIds: string[];
  activeId: string | null;
}

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
  /** 已处理的「任务完成通知」次数；接口滞后时靠它兜底亮未读 */
  doneSeq: number;
  /** 「回答完毕未查看」的时间戳：running→idle 且当时不是前台页签 */
  pendingUnreadAt: number | null;
  /** 已经看过的那一轮未读，避免切走又切回时重复提示 */
  seenUnreadAt: number | null;
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
}

/**
 * 一个页签 = 一个 WebContentsView + 一个 URL。
 * 与 pi-web 的全部交互只有两件事：loadURL，以及接管它自己发起的 window.open。
 */
export class TabManager {
  private readonly tabs: Tab[] = [];

  /* ---------------- 分屏状态：页签分组（VSCode 编辑器组） ----------------
   * groups.length = 窗格数，1 = 没分屏。每个组有自己的页签列表和一个正在显示的页签，
   * 所有页签恰好属于一个组；单栏时只有一个组，行为与分屏功能加入前完全一致。
   * activeId 恒等于 groups[focusedGroup].activeId（syncActive 维护），
   * 这样标题、主题探测、托盘勾选等原有逻辑都不用改。
   */
  private groups: PaneGroup[] = [{ tabIds: [], activeId: null }];
  private focusedGroup = 0;
  private splitLayout: SplitLayout = "columns";
  /** 拖动页签期间临时隐藏内容视图，让渲染层的投放层露出来 */
  private dragging = false;
  /** 主窗口 webContents 上的快捷键监听：destroy 时要摘掉，否则服务地址变化重建 TabManager 会重复绑定 */
  private readonly windowShortcutHandler: ShortcutHandler;
  private activeId: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private themeTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private pollingStatus = false;
  private readonly debugStatus = Boolean(process.env.PI_WEB_DESKTOP_DEBUG_STATUS);
  /** 仅自测：不跑真实对话，依次演示四种页签状态，方便截图验收样式 */
  private readonly demoStatus = process.env.PI_WEB_DESKTOP_SELFTEST_STATUS === "1";
  private theme: ThemeSnapshot;
  private lastChromeSignature = "";
  private destroyed = false;
  private readonly onWindowFocus = (): void => this.syncWindowFocus(true);
  private readonly onWindowBlur = (): void => this.syncWindowFocus(false);

  constructor(private readonly options: TabManagerOptions) {
    this.theme = options.initialTheme ?? systemFallbackTheme();
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

  async init(): Promise<void> {
    const persisted = this.options.restoreTabs ? loadTabs(this.options.dataDir) : null;
    if (persisted && persisted.tabs.length > 0) {
      for (const tab of persisted.tabs) {
        this.createTab(tab.path, { activate: false, pinned: tab.pinned, title: tab.title });
      }
      const index = Math.min(Math.max(persisted.activeIndex, 0), this.tabs.length - 1);
      this.activate(this.tabs[index].id);
      this.restoreSplit(persisted.split, index);
    } else {
      this.createTab("/");
    }
    // pi-web 切主题时不会发事件给我们，只能自己定期读一下（只读，不改页面）
    this.themeTimer = setInterval(() => void this.refreshTheme(), 1_000);
    this.themeTimer.unref?.();
    void this.refreshTheme();

    // 页签状态（等待回答 / 回答完毕未查看）：主进程统一轮询所有页签的探测脚本
    this.statusTimer = setInterval(() => void this.refreshTabStatuses(), STATUS_POLL_MS);
    this.statusTimer.unref?.();
    void this.refreshTabStatuses();
  }

  /**
   * 读取 pi-web 当前主题的真实 CSS 变量。
   * 不写死配色表：pi-web 新增/自定义主题时，页签栏与窗口控件会自动跟随。
   */
  async refreshTheme(): Promise<void> {
    if (this.destroyed) return;
    const wc = this.activeContents();
    if (!wc || wc.isDestroyed()) return;
    const debug = Boolean(process.env.PI_WEB_DESKTOP_DEBUG_THEME);
    try {
      const value = (await wc.executeJavaScript(THEME_PROBE_SCRIPT, true)) as string;
      const payload = JSON.parse(value) as ThemeProbeResult;
      if (payload.error) throw new Error(payload.error);
      const scheme: "light" | "dark" = payload.scheme === "dark" ? "dark" : "light";
      const vars: Record<string, string> = {};
      for (const [key, raw] of Object.entries(payload.vars ?? {})) {
        if (key.startsWith("--") && typeof raw === "string" && raw.trim()) {
          vars[key] = raw.trim();
        }
      }
      const next: ThemeSnapshot = {
        name: typeof payload.name === "string" && payload.name ? payload.name : scheme,
        scheme,
        vars,
        fromPage: payload.fromPage === true && Object.keys(vars).length >= 3,
      };
      // 读不到页面变量（页面还在加载 / 不是 pi-web 页面 / 上游换了变量名）：
      // 一律保留当前主题，不回落、不通知渲染层，避免冷启动闪一下浅色
      if (!next.fromPage) {
        this.applyChromeTheme();
        return;
      }

      const changed = JSON.stringify(next) !== JSON.stringify(this.theme);
      if (changed) {
        this.theme = next;
        // 窗格边框也跟着主题换色
        this.layout();
        saveTheme(this.options.dataDir, next);
        if (debug) {
          this.options.onDebug?.(
            `[theme] 切换为 ${next.name}（${next.scheme}，来自页面 ${Object.keys(vars).length} 个变量，已缓存）`,
          );
        }
        this.notify();
      }
      this.applyChromeTheme();
    } catch (error) {
      if (debug) {
        const simple = await wc
          .executeJavaScript("1 + 1", true)
          .then((v) => `executeJavaScript 可用（1+1=${v}）`)
          .catch((e: unknown) => `连 1+1 都失败：${String(e)}`);
        this.options.onDebug?.(`[theme] 读取失败：${String(error)}；${simple}`);
      }
    }
  }

  /** 把主题色同步到自绘标题栏的窗口控件和窗口底色 */
  private applyChromeTheme(): void {
    if (!this.options.customTitleBar || this.options.win.isDestroyed()) return;
    const bg = toOpaqueHex(this.theme.vars["--bg"], this.theme.scheme);
    const fg = toOpaqueHex(
      this.theme.vars["--text"],
      this.theme.scheme,
      defaultSymbolColor(this.theme.scheme),
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
    const script = `window.__piDesktopWindowFocused = ${focused ? "true" : "false"};`;
    for (const tab of this.tabs) {
      const contents = tab.view.webContents;
      if (contents.isDestroyed()) continue;
      void contents.executeJavaScript(script, true).catch(() => {});
    }
    if (process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
      this.options.onDebug?.(`[notify] 窗口焦点同步：${focused ? "focused" : "blurred"}`);
    }
  }

  /** 服务恢复后把所有页签重新加载一遍 */
  reloadAll(): void {
    for (const tab of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
  }

  snapshot(): TabsSnapshot {
    return {
      tabs: this.tabs.map((tab) => this.toInfo(tab)),
      activeId: this.activeId,
      baseUrl: this.options.baseUrl,
      theme: this.theme,
      customTitleBar: this.options.customTitleBar === true,
      split: {
        groups: this.groups.map((group) => ({
          tabIds: [...group.tabIds],
          activeId: group.activeId,
        })),
        focused: this.focusedGroup,
        layout: this.effectiveLayout(),
        preset: presetFor(this.groups.length, this.effectiveLayout()),
        rects: this.paneRects(),
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
      doneSeq: 0,
      pendingUnreadAt: null,
      seenUnreadAt: null,
    };

    const wc = view.webContents;
    this.attachShortcuts(wc, tab.id);
    // 点进哪个窗格，哪个窗格就是「当前窗格」：Ctrl+W / Ctrl+R / 缩放等都作用于它
    wc.on("focus", () => this.noteGroupFocus(tab.id));

    // 页签状态探测：只读页面自己的接口 / URL / 侧栏选中行（刻意不读全局 localStorage）。
    // 页面 reload / 切会话后 realm 会重建，所以 dom-ready 与 did-finish-load 各补一次（脚本自身幂等）。
    const installStatusProbe = (): void => {
      if (wc.isDestroyed()) return;
      void wc.executeJavaScript(TAB_STATUS_PROBE_SCRIPT, true).catch(() => {});
    };
    wc.on("dom-ready", installStatusProbe);
    wc.on("did-finish-load", installStatusProbe);

    // 大输入框（便签）：给 pi-web 的输入框加一个展开按钮，右侧停靠大文本框。
    // 所有节点挂在 body 上、位置按原输入框实时计算，React 重渲染不会冲掉。
    const installComposerExpand = (): void => {
      if (wc.isDestroyed() || process.env.PI_WEB_DESKTOP_NO_COMPOSER_EXPAND === "1") return;
      void wc.executeJavaScript(COMPOSER_EXPAND_SCRIPT, true).catch(() => {});
    };
    wc.on("dom-ready", installComposerExpand);
    wc.on("did-finish-load", installComposerExpand);

    // Windows 下 pi-web 的 SW 通知不会出 toast，强制回落到 window.Notification。
    // 页面 reload / 切会话后 realm 会重建，所以 dom-ready 与 did-finish-load 各补一次。
    if (process.platform === "win32") {
      let debugLogged = false;
      const installFallback = (): void => {
        if (wc.isDestroyed()) return;
        void wc.executeJavaScript(WINDOWS_NOTIFICATION_PATCH, true).catch(() => {});
        this.syncWindowFocus();
        if (!debugLogged && process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
          debugLogged = true;
          this.options.onDebug?.("[notify] 已注入通知回落 + 窗口焦点同步补丁");
        }
      };
      wc.on("dom-ready", installFallback);
      wc.on("did-finish-load", installFallback);
    }

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
      tab.loading = true;
      this.notify();
    });

    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.refreshPath(tab);
      this.notify();
      void this.refreshTheme();
    });

    wc.on("did-finish-load", () => void this.refreshTheme());

    wc.on("did-navigate", () => this.refreshPath(tab));
    wc.on("did-navigate-in-page", () => this.refreshPath(tab));

    wc.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      tab.title = `页面崩溃（${details.reason}）`;
      this.notify();
    });

    this.options.win.contentView.addChildView(view);
    view.setVisible(false);

    const insertAt = this.resolveInsertIndex(options.index, tab.pinned);
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
    if (this.tabs[index].pinned && !force) return;
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

  /** 布局预设：单栏 / 左右双栏 / 上下双栏 / 三栏 / 四宫格 */
  setSplitPreset(id: SplitPreset): void {
    if (this.destroyed) return;
    const preset = presetById(id);
    this.ensureTabCount(preset.count);
    this.reflowGroups(preset.count);
    this.splitLayout = preset.layout;
    this.focusedGroup = Math.min(this.focusedGroup, this.groups.length - 1);
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
    const src = this.groupIndexOf(target);
    // 已经在某个窗格里显示着：不重复开窗格，只聚焦过去
    if (this.groups[src].activeId === target && this.groups.length >= 2) {
      this.focusGroup(src);
      return;
    }
    if (this.groups.length >= MAX_PANES) {
      this.moveTabToGroup(target, (src + 1) % this.groups.length);
      return;
    }
    // 源窗格只剩这一个页签时补一个新的，避免出现空窗格
    if (this.groups[src].tabIds.length === 1) {
      this.createTab("/", { activate: false, group: src });
    }
    const fresh: PaneGroup = { tabIds: [], activeId: null };
    this.groups.splice(Math.min(this.focusedGroup + 1, this.groups.length), 0, fresh);
    if (this.groups.length === 2) this.splitLayout = orientation;
    else if (orientation === "rows" && this.groups.length <= 3) this.splitLayout = "rows";
    else if (this.groups.length === MAX_PANES) this.splitLayout = "grid";
    this.moveTabIntoGroup(target, fresh);
    this.focusedGroup = this.groups.indexOf(fresh);
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

  /** 关掉一个窗格；页签本身不关闭，合并到相邻窗格 */
  closeGroup(index = this.focusedGroup): void {
    if (this.destroyed || this.groups.length <= 1) return;
    const at = Math.min(Math.max(index, 0), this.groups.length - 1);
    const [closed] = this.groups.splice(at, 1);
    const dest = this.groups[Math.min(at, this.groups.length - 1)];
    for (const tabId of closed.tabIds) {
      if (!dest.tabIds.includes(tabId)) dest.tabIds.push(tabId);
    }
    if (!dest.activeId || !dest.tabIds.includes(dest.activeId)) {
      dest.activeId = dest.tabIds[0] ?? null;
    }
    this.focusedGroup = Math.min(at, this.groups.length - 1);
    if (this.groups.length === 1) this.splitLayout = "columns";
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
    const target = this.groups[Math.min(Math.max(groupIndex, 0), this.groups.length - 1)];
    if (!target) return;
    const src = this.groups.find((group) => group.tabIds.includes(id));
    // 源窗格只剩这一个页签时，先把它和目标窗格当前显示的页签互换：
    // 否则空窗格会被 VSCode 规则关掉，「分两个展示区域」一下就没了。
    if (src && src !== target && src.tabIds.length === 1 && this.groups.length > 1) {
      const borrow = target.activeId ?? target.tabIds[0] ?? null;
      if (borrow && borrow !== id) {
        target.tabIds = target.tabIds.filter((tabId) => tabId !== borrow);
        src.tabIds.push(borrow);
        src.activeId = borrow;
        if (target.activeId === borrow) target.activeId = target.tabIds[0] ?? null;
      }
    }
    this.moveTabIntoGroup(id, target, insertIndex);
    this.focusedGroup = this.groups.indexOf(target);
    this.afterGroupChange();
  }

  /** 拖到窗口最左 / 最右：新建一个窗格并放入该页签 */
  splitTabToEdge(id: string, side: "left" | "right"): void {
    if (this.destroyed) return;
    this.dragging = false;
    if (this.groups.length >= MAX_PANES) {
      this.moveTabToGroup(id, side === "left" ? 0 : this.groups.length - 1);
      return;
    }
    const src = this.groups.find((group) => group.tabIds.includes(id));
    if (src && src.tabIds.length === 1 && this.groups.length === 1) {
      this.createTab("/", { activate: false, group: this.groups.indexOf(src) });
    }
    const fresh: PaneGroup = { tabIds: [], activeId: null };
    this.groups.splice(side === "left" ? 0 : this.groups.length, 0, fresh);
    if (this.groups.length === 2) this.splitLayout = "columns";
    else if (this.groups.length === MAX_PANES) this.splitLayout = "grid";
    this.moveTabIntoGroup(id, fresh);
    this.focusedGroup = this.groups.indexOf(fresh);
    this.afterGroupChange();
  }

  newTabInGroup(index: number): void {
    if (this.destroyed) return;
    const at = Math.min(Math.max(index, 0), this.groups.length - 1);
    const id = this.createTab("/", { activate: false, group: at });
    if (!id) return;
    this.groups[at].activeId = id;
    this.focusedGroup = at;
    this.afterGroupChange();
  }

  /** 拖动期间隐藏所有内容视图，让页签栏渲染层的「投放区」露出来 */
  beginTabDrag(): void {
    if (this.destroyed) return;
    this.dragging = true;
    for (const tab of this.tabs) tab.view.setVisible(false);
  }

  endTabDrag(): void {
    if (this.destroyed) return;
    this.dragging = false;
    this.layout();
    this.focusActive();
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
    const pinnedCount = this.tabs.filter((item) => item.pinned).length;
    const min = tab.pinned ? 0 : pinnedCount;
    const max = tab.pinned ? Math.max(pinnedCount - 1, 0) : this.tabs.length - 1;
    const to = Math.min(Math.max(targetIndex, min), max);
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
    const pinnedCount = this.tabs.filter((item) => item.pinned).length;
    this.tabs.splice(pinnedCount, 0, tab);
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
    if (this.themeTimer) clearInterval(this.themeTimer);
    this.themeTimer = null;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
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
      { label: "重新加载", click: () => tab.view.webContents.reload() },
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
    this.tabs.splice(index, 1);
    try {
      this.options.win.contentView.removeChildView(tab.view);
    } catch {
      // 窗口可能已经销毁
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    // 从它所属的窗格里摘掉；窗格空了就关掉窗格（页签合并由 pruneGroups 处理）
    for (const group of this.groups) {
      group.tabIds = group.tabIds.filter((tabId) => tabId !== tab.id);
      if (group.activeId === tab.id) group.activeId = null;
    }

    if (this.tabs.length === 0) {
      this.groups = [{ tabIds: [], activeId: null }];
      this.focusedGroup = 0;
      this.splitLayout = "columns";
      this.syncActive();
      if (options.keepWindow || this.destroyed) {
        this.notify();
        return;
      }
      // 不留空窗口：最后一个页签关掉就开一个新的
      this.createTab("/");
      return;
    }

    this.pruneGroups();
    this.focusedGroup = Math.min(this.focusedGroup, this.groups.length - 1);
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

  private effectiveLayout(): SplitLayout {
    return this.groups.length > 1 ? this.splitLayout : "columns";
  }

  private syncActive(): void {
    this.activeId = this.groups[this.focusedGroup]?.activeId ?? null;
  }

  /** 分组/焦点变化后统一收尾（重排、聚焦、通知、刷新主题） */
  private afterGroupChange(): void {
    this.dragging = false;
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

  /** 切成 N 个窗格：前 N 个页签各占一格，其余全部留在第一格 */
  private reflowGroups(count: number): void {
    const ordered = this.orderedTabIds();
    if (count <= 1) {
      const keep = this.activeId && ordered.includes(this.activeId) ? this.activeId : ordered[0];
      this.groups = [{ tabIds: ordered, activeId: keep ?? null }];
      this.focusedGroup = 0;
      this.splitLayout = "columns";
      return;
    }
    // 只换方向（columns-2 → rows-2）时保留用户已经拖好的分组
    if (count === this.groups.length) return;
    const heads = ordered.slice(0, count);
    this.groups = Array.from({ length: count }, (_, i) => ({
      tabIds: [heads[i]],
      activeId: heads[i],
    }));
    for (const id of ordered.slice(count)) this.groups[0].tabIds.push(id);
  }

  /** 把页签移进指定组（用对象引用，避免源组被删后下标漂移） */
  private moveTabIntoGroup(id: string, target: PaneGroup, insertIndex?: number): void {
    if (!this.tabs.some((tab) => tab.id === id)) return;
    const src = this.groups.find((group) => group.tabIds.includes(id));
    if (!src) return;
    src.tabIds = src.tabIds.filter((tabId) => tabId !== id);
    if (src.activeId === id) src.activeId = src.tabIds[0] ?? null;
    const at = Math.min(Math.max(insertIndex ?? target.tabIds.length, 0), target.tabIds.length);
    target.tabIds.splice(at, 0, id);
    target.activeId = id;
    if (src !== target && src.tabIds.length === 0 && this.groups.length > 1) {
      this.groups.splice(this.groups.indexOf(src), 1);
    }
  }

  /** 关页签后：空组删掉、活动页签失效的补一个；至少保留一个组 */
  private pruneGroups(): void {
    for (let i = this.groups.length - 1; i >= 0; i -= 1) {
      const group = this.groups[i];
      if (group.tabIds.length === 0 && this.groups.length > 1) {
        this.groups.splice(i, 1);
        continue;
      }
      if (!group.activeId || !group.tabIds.includes(group.activeId)) {
        group.activeId = group.tabIds[0] ?? null;
      }
    }
    if (this.groups.length === 0) {
      this.groups = [{ tabIds: this.tabs.map((tab) => tab.id), activeId: this.tabs[0]?.id ?? null }];
    }
    if (this.groups.length === 1) this.splitLayout = "columns";
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

  /** 重启后按 tabs.json 里存的下标恢复分组（页签 id 每次启动都会变） */
  private restoreSplit(split: PersistedSplit | null | undefined, activeIndex: number): void {
    if (!split || !Array.isArray(split.groups) || split.groups.length < 2) return;
    const seen = new Set<string>();
    const groups: PaneGroup[] = split.groups.slice(0, MAX_PANES).map((indices, i) => {
      const ids: string[] = [];
      for (const index of indices) {
        const id = this.tabs[index]?.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      const activeIndexInTabs = split.active?.[i];
      const activeId =
        typeof activeIndexInTabs === "number" ? this.tabs[activeIndexInTabs]?.id : undefined;
      return {
        tabIds: ids,
        activeId: activeId && ids.includes(activeId) ? activeId : (ids[0] ?? null),
      };
    });
    for (const tab of this.tabs) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id);
        groups[0].tabIds.push(tab.id);
      }
    }
    const valid = groups.filter((group) => group.tabIds.length > 0);
    if (valid.length < 2) return;
    this.groups = valid;
    this.splitLayout =
      split.layout === "rows" || split.layout === "grid" ? split.layout : "columns";
    const activeTabId = this.tabs[activeIndex]?.id;
    const focused = activeTabId
      ? this.groups.findIndex((group) => group.activeId === activeTabId)
      : -1;
    this.focusedGroup =
      focused >= 0 ? focused : Math.min(Math.max(split.focused, 0), this.groups.length - 1);
    this.afterGroupChange();
  }

  /** 当前所有窗格的外框；同时给渲染层定位它自己的页签条 */
  private paneRects(): PaneRect[] {
    if (this.options.win.isDestroyed()) {
      return computePaneRects(this.groups.length, this.effectiveLayout(), 1, 1);
    }
    const [width, height] = this.options.win.getContentSize();
    return computePaneRects(this.groups.length, this.effectiveLayout(), width, height);
  }

  /** 只显示每个窗格 active 的视图，bounds = 窗格外框去掉顶部那条页签条 */
  private layout(): void {
    if (this.destroyed || this.dragging || this.options.win.isDestroyed()) return;
    const rects = this.paneRects();
    for (const tab of this.tabs) tab.view.setVisible(false);
    for (let i = 0; i < this.groups.length; i += 1) {
      const id = this.groups[i].activeId;
      if (!id) continue;
      const tab = this.tabs.find((item) => item.id === id);
      if (!tab) continue;
      tab.view.setBounds(paneContentRect(rects[i]));
      tab.view.setVisible(true);
    }
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
    };
  }

  /* ------------------------- 页签状态 ------------------------- */

  /**
   * 每秒读一次每个页签里注入的探测脚本。只在「状态真的变了」时 notify()，
   * 避免把页签栏每秒重绘一遍、也不会反复写 tabs.json。
   */
  private async refreshTabStatuses(): Promise<void> {
    if (this.destroyed || this.pollingStatus) return;
    if (this.demoStatus) {
      this.cycleDemoStatus();
      return;
    }
    this.pollingStatus = true;
    let changed = false;
    try {
      const tabs = [...this.tabs];
      // 并行读所有页签，且单个页面卡住最多等 1.5s；否则一个后台页签会把整轮轮询拖住
      const probes = await Promise.all(
        tabs.map(async (tab): Promise<TabStatusProbe | null> => {
          const wc = tab.view.webContents;
          if (wc.isDestroyed()) return null;
          try {
            const raw = await withTimeout(
              wc.executeJavaScript(TAB_STATUS_READ_SCRIPT, true) as Promise<unknown>,
              STATUS_READ_TIMEOUT_MS,
            );
            if (typeof raw !== "string" || raw === "null") return null;
            const parsed = JSON.parse(raw) as TabStatusProbe & { error?: string };
            if (parsed.error || typeof parsed.running !== "boolean") return null;
            return parsed;
          } catch {
            // 页面还在加载 / 正在导航 / 卡住：保留上一轮状态，不让指示器闪一下
            return null;
          }
        }),
      );
      tabs.forEach((tab, index) => {
        const probe = probes[index];
        if (probe) changed = this.applyTabStatus(tab, probe) || changed;
      });
    } finally {
      this.pollingStatus = false;
    }
    if (changed) this.notify();
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
    const doneSeq = probe.doneSeq ?? 0;
    const doneSignal = doneSeq > tab.doneSeq;
    if (doneSignal) tab.doneSeq = doneSeq;

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
    if ((wasRunning && !probe.running && !visible) || (doneSignal && !visible)) {
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveTabs(this.options.dataDir, {
        version: 1,
        activeIndex: Math.max(this.tabs.findIndex((tab) => tab.id === this.activeId), 0),
        tabs: this.tabs.map((tab) => ({ path: tab.path, title: tab.title, pinned: tab.pinned })),
        split: {
          groups: this.groups.map((group) =>
            group.tabIds
              .map((id) => this.tabs.findIndex((tab) => tab.id === id))
              .filter((index) => index >= 0),
          ),
          active: this.groups.map((group) => {
            if (!group.activeId) return null;
            const index = this.tabs.findIndex((tab) => tab.id === group.activeId);
            return index >= 0 ? index : null;
          }),
          focused: this.focusedGroup,
          layout: this.effectiveLayout(),
        },
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private resolveInsertIndex(index: number | undefined, pinned: boolean): number {
    const pinnedCount = this.tabs.filter((tab) => tab.pinned).length;
    if (index !== undefined && Number.isInteger(index)) {
      const min = pinned ? 0 : pinnedCount;
      return Math.min(Math.max(index, min), this.tabs.length);
    }
    // 新页签插在固定区之后（固定区保持最左）
    return pinnedCount;
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

interface ThemeProbeResult {
  name?: string;
  scheme?: string;
  vars?: Record<string, string>;
  fromPage?: boolean;
  error?: string;
}

/**
 * 读取 pi-web 当前主题的「真实生效值」：dataset.theme 名称、color-scheme 明暗、
 * 以及 :root 上定义的 CSS 变量。全程只读 + try/catch，返回 JSON 字符串方便排查。
 * 用 String.raw 避免模板字符串把正则里的反斜杠吃掉。
 */
const THEME_PROBE_SCRIPT = String.raw`(() => {
  try {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const names = [
      "--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--border",
      "--text", "--text-muted", "--text-dim", "--accent",
      "--accent-hover", "--accent-contrast"
    ];
    const vars = {};
    for (const key of names) {
      const value = cs.getPropertyValue(key).trim();
      if (value) vars[key] = value;
    }

    let name = (root && root.dataset ? root.dataset.theme : "") || "";
    if (!name) {
      try { name = (window.localStorage && localStorage.getItem("pi-theme")) || ""; } catch (e) {}
      if (!name || name === "auto") {
        name = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    }

    function toRgb(text) {
      const s = String(text || "").trim();
      let m = /^#([0-9a-f]{3,8})$/i.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
        if (h.length === 6 || h.length === 8) {
          return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
      }
      m = /^rgba?\(([^)]+)\)$/i.exec(s);
      if (m) {
        const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        // 全透明背景（例如 about:blank）不算有效颜色，交给 color-scheme / 系统判断
        if (parts.length >= 4 && parts[3] === 0) return null;
        if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
      }
      return null;
    }

    // 明暗以「实际背景色」为准：color-scheme 只作兜底，避免主题类名残留时判断错
    let scheme = "";
    const bgRgb = toRgb(vars["--bg"] || getComputedStyle(document.body).backgroundColor);
    if (bgRgb) {
      const luma = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
      scheme = luma < 128 ? "dark" : "light";
    }
    if (!scheme) {
      const cssScheme = cs.colorScheme || "";
      if (cssScheme.indexOf("dark") === 0) scheme = "dark";
      else if (cssScheme.indexOf("light") === 0) scheme = "light";
    }
    if (!scheme) {
      scheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    return JSON.stringify({
      name: name,
      scheme: scheme,
      vars: vars,
      fromPage: Object.keys(vars).length >= 3
    });
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
})()`;

/** 页面标题形如 "会话名 - Pi Web"，页签上只留会话名 */
function cleanTitle(title: string): string {
  return title.replace(/\s*[-–—]\s*Pi\s*Web\s*$/i, "").trim();
}
