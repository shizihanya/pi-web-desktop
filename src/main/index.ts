import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { trayIconPath, windowIconPath } from "./assets";
import { DRAFT_IPC, IPC } from "../shared/types";
import type { SplitPreset } from "../shared/split";
import { registerDraftIpc, registerIpc, registerTabIpc } from "./ipc";
import { installAppMenu } from "./menu";
import { REMOTE_ACCESS_KEY, readSecret } from "./secret-store";
import { listLanAddresses } from "./server/network";
import { checkPiWebUpdate } from "./server/pi-web-update";
import { ServerManager } from "./server/server-manager";
import { dataDir, loadSettings, logFilePath, type AppSettings } from "./settings";
import { SettingsService } from "./settings-service";
import { openSettingsWindow } from "./settings-window";
import { TabManager } from "./tabs/tab-manager";
import { DraftWorkspace, type DraftContents } from "./tabs/draft-workspace";
import {
  COMPOSER_DIAGNOSE_SCRIPT,
  COMPOSER_PROBE_SCRIPT,
  buildComposerSendScript,
} from "./tabs/composer-bridge";
import { loadTheme } from "./tabs/theme-persistence";
import { AppTray } from "./tray";
import { removeAutoShortcuts, watchAutoShortcuts } from "./start-menu";
import { applyWindowIcon } from "./window-icon";
import { customTitleBarEnabled, defaultSymbolColor, titleBarOptions, toOpaqueHex } from "./titlebar";

const APP_ID = "com.local.piweb.desktop";
/** 固定 ToastActivatorCLSID：与 scripts/create-shortcut.ps1 的 $toastClsid 保持一致 */
const TOAST_ACTIVATOR_CLSID = "{5477A902-2108-4059-A5D0-F6FEAFF61562}";
const isDev = !app.isPackaged;
const startHidden = process.argv.includes("--hidden");

// 绿色版（portable）：electron-builder 会设置 PORTABLE_EXECUTABLE_DIR，
// 把 userData（缓存、设置、日志）放到 exe 同级 ./data，做到「拷走就能用」。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir && portableDir.trim().length > 0) {
  app.setPath("userData", join(portableDir, "data"));
}

app.setName("Pi Web Desktop");
if (process.platform === "win32") {
  // Windows 任务栏按 AUMID 找开始菜单里带同 ID 的快捷方式取图标；
  // 这个注册点由 npm run shortcut 维护（图标 = build/icon.ico）。
  app.setAppUserModelId(APP_ID);
  // Electron 默认每次启动随机生成 ToastActivatorCLSID，重启后通知中心里的旧通知会点不开。
  // 固定后，开始菜单快捷方式（npm run shortcut）与自动生成的 Electron.lnk 用的是同一个 CLSID。
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
}

let mainWindow: BrowserWindow | null = null;
/** 主窗口是否已从「启动页」切成「页签栏」模式 */
let mainWindowActivated = false;
let manager: ServerManager | null = null;
let tabs: TabManager | null = null;
/** 桌面增强：独立输入工作区（与 TabManager 解耦，服务重启重建页签时保留草稿） */
let draftWorkspace: DraftWorkspace | null = null;
let tray: AppTray | null = null;
let settingsService: SettingsService | null = null;
let bootsOnce = false;
let quitting = false;
let lastReadyUrl: string | null = null;
let autoShortcutWatcher: ReturnType<typeof watchAutoShortcuts> | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindowIfPossible());
  app.whenReady().then(boot).catch((error: unknown) => {
    console.error("启动失败", error);
    app.quit();
  });
}

async function boot(): Promise<void> {
  if (bootsOnce) return;
  bootsOnce = true;

  const settings = loadSettings();
  manager = new ServerManager(settings, logFilePath(), {
    getPassword: () => readSecret(REMOTE_ACCESS_KEY),
  });

  // pi-web 完成通知走 window.Notification 时，Electron 仍会生成带原子图标的 Electron.lnk；
  // 启动清一次 + 目录变化后 500ms 清一次 + 兜底轮询，保证任务栏图标不会被它顶掉。
  const cleanAutoShortcuts = (): void => {
    const removed = removeAutoShortcuts(APP_ID);
    if (removed.length) manager?.log(`[icon] 已移除自动生成的快捷方式：${removed.join(", ")}`);
  };
  cleanAutoShortcuts();
  setTimeout(cleanAutoShortcuts, 8_000);
  setInterval(cleanAutoShortcuts, 10_000).unref();
  autoShortcutWatcher = watchAutoShortcuts(APP_ID, (removed) => {
    manager?.log(`[icon] 已清理通知自动生成的快捷方式：${removed.join(", ")}`);
  });

  manager.log(`[icon] 窗口图标：${windowIconPath() ?? "未找到（会回落到 electron 默认图标）"}`);
  manager.log(`[icon] 托盘图标：${trayIconPath() ?? "未找到"}`);

  settingsService = new SettingsService({
    getServer: () => manager,
    restartAll,
    onChange: applyRuntimeSettings,
  });

  registerIpc({ manager, onReady: (url) => void showMainWindow(url) });
  registerTabIpc(() => tabs, () => {
    openSettingsWindow(mainWindow);
  });
  settingsService.registerIpc();

  // 独立输入工作区：只用 provider 访问 TabManager，服务重启重建页签不会丢草稿。
  draftWorkspace = new DraftWorkspace({
    enabled: process.env.PI_WEB_DESKTOP_DISABLE_DRAFT_WORKSPACE !== "1",
    dataDir: dataDir(),
    tabs: {
      activeTabId: () => tabs?.snapshot().activeId ?? null,
      tabContext: (id) => tabs?.draftContext(id) ?? null,
      allContexts: () => tabs?.allDraftContexts() ?? [],
      contents: (id) => (tabs?.draftContents(id) ?? null) as DraftContents | null,
      setReservedRightWidth: (px) => tabs?.setReservedRightWidth(px),
      windowWidth: () =>
        mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize()[0] : 1_440,
    },
    onChange: (snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(DRAFT_IPC.changedEvent, snapshot);
      }
    },
    onCompat: (verdict) => tabs?.setComposerCompat(verdict),
    onDebug: (message) => manager?.log(message),
  });
  registerDraftIpc(() => draftWorkspace);

  tray = new AppTray({
    getState: () => manager?.getState() ?? IDLE_STATE,
    getTabs: () => tabs?.snapshot() ?? null,
    getLan: () => settingsService?.lan() ?? [],
    isRemoteEnabled: () => loadSettings().remoteAccess.enabled,
    showWindow: () => showMainWindowIfPossible(),
    activateTab: (id) => tabs?.activate(id),
    restartServer: () => void restartServer(),
    openLog: () => void shell.openPath(logFilePath()),
    openSettings: () => openSettingsWindow(mainWindow),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.create();

  installAppMenu({
    newTab: () => tabs?.createTab("/"),
    closeTab: () => {
      const active = tabs?.snapshot().activeId;
      if (active) tabs?.closeTab(active);
    },
    setSplit: (preset) => tabs?.setSplitPreset(preset),
    splitRight: () => tabs?.splitRight(),
    closeGroup: () => tabs?.closeGroup(),
    reload: () => tabs?.reloadActive(),
    devTools: () => tabs?.toggleDevTools(),
    zoom: (direction) => {
      if (direction === "reset") tabs?.resetZoom();
      else tabs?.zoomBy(direction === "in" ? 0.5 : -0.5);
    },
    toggleFullScreen: () => {
      const win = mainWindow;
      if (win) win.setFullScreen(!win.isFullScreen());
    },
    openSettings: () => openSettingsWindow(mainWindow),
    restartServer: () => void restartServer(),
    openLog: () => void shell.openPath(logFilePath()),
    openDataFolder: () => void shell.openPath(dataDir()),
    showServerStatus: () => void showServerStatus(),
    checkUpdates: () => void checkPiWebUpdates(),
    showAbout: () => void showAbout(),
  });

  manager.onState((state) => {
    tray?.refresh();

    if (state.phase === "ready" && state.url) {
      if (lastReadyUrl && state.url !== lastReadyUrl) {
        manager?.log(`[ui] 服务地址变化 ${lastReadyUrl} → ${state.url}，重建窗口`);
        void showMainWindow(state.url);
      } else if (lastReadyUrl === state.url) {
        // 服务断过又恢复了（例如外部实例被关、我们接管重拉）：把页签刷一遍
        tabs?.reloadAll();
      }
      lastReadyUrl = state.url;
      return;
    }

    if (state.phase === "failed" && state.message) notifyFailure(state.message);
  });

  if (!startHidden) showBootPage();

  manager
    .start()
    .then((state) => {
      manager?.log(`[boot] 启动结果：${state.phase}${state.url ? ` ${state.url}` : ""}`);
      tray?.refresh();
      if (process.env.PI_WEB_DESKTOP_HOLD_SPLASH) return;
      if (state.phase === "ready" && state.url) void showMainWindow(state.url);
      else if (startHidden) tray?.create();
    })
    .catch((error: unknown) => {
      manager?.log(`[boot] 启动流程异常：${String(error)}`);
    });

  const autoQuitMs = Number(process.env.PI_WEB_DESKTOP_AUTOQUIT_MS ?? 0);
  if (Number.isFinite(autoQuitMs) && autoQuitMs > 0) {
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, autoQuitMs);
  }

  if (process.env.PI_WEB_DESKTOP_SELFTEST_REMOTE) setTimeout(() => runRemoteSelftest(), 7_000);
}

const IDLE_STATE = {
  phase: "idle" as const,
  url: null,
  port: null,
  hostname: null,
  managed: false,
  version: null,
  message: null,
  detail: null,
};

/* ------------------------------ 窗口 ------------------------------ */

function rendererEntry(page: "splash" | "tabbar" | "settings"): { url?: string; file?: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return { url: new URL(`${page}/index.html`, `${devServer}/`).toString() };
  return { file: join(__dirname, "../renderer", page, "index.html") };
}

function loadPage(
  win: BrowserWindow,
  page: "splash" | "tabbar" | "settings",
  params: Record<string, string> = {},
): void {
  const entry = rendererEntry(page);
  // 启动页 / 设置页需要知道是否要空出顶部标题栏条；页签栏本身通过 IPC 拿这个标记
  const overlay = customTitleBarEnabled() && page !== "tabbar";
  if (entry.url) {
    const url = new URL(entry.url);
    if (overlay) url.searchParams.set("titlebar", "overlay");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    void win.loadURL(url.toString());
  } else if (entry.file) {
    const query: Record<string, string> = {
      ...(overlay ? { titlebar: "overlay" } : {}),
      ...params,
    };
    void win.loadFile(entry.file, Object.keys(query).length > 0 ? { query } : {});
  }
}

function captureAfter(win: BrowserWindow, shotPath: string, delayMs = 3_000): void {
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      // 窗口/视图可能已被关闭或重建（重启服务、设置窗口关掉等）
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      try {
        void win.webContents
          .capturePage()
          .then((image) => {
            writeFileSync(shotPath, image.toPNG());
            manager?.log(`[shot] 已保存截图：${shotPath}`);
          })
          .catch((error: unknown) => manager?.log(`[shot] 截图失败：${String(error)}`));
      } catch (error) {
        manager?.log(`[shot] 截图失败：${String(error)}`);
      }
    }, delayMs);
  });
}

interface BootTheme {
  scheme: "light" | "dark";
  bg: string;
  fg: string;
  accent: string | null;
}

/** 冷启动首帧的配色：优先用 theme.json 里缓存的 pi-web 主题，没有才退回系统明暗 */
function bootTheme(): BootTheme {
  const cached = loadTheme(dataDir());
  const scheme = cached?.scheme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  return {
    scheme,
    bg: toOpaqueHex(cached?.vars["--bg"], scheme),
    fg: toOpaqueHex(cached?.vars["--text"], scheme, defaultSymbolColor(scheme)),
    accent: cached?.vars["--accent"] ?? null,
  };
}

/**
 * 主窗口只有一个：启动页是它的第一屏，服务就绪后原地换成页签栏。
 * 这里只负责建窗口和绑事件，页面由 showBootPage / showMainWindow 决定。
 */
function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const theme = bootTheme();
  const settings = loadSettings();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: theme.bg,
    icon: windowIconPath() ?? undefined,
    title: "Pi Web Desktop",
    autoHideMenuBar: true,
    alwaysOnTop: settings.alwaysOnTop,
    ...titleBarOptions(theme.bg, theme.fg),
    webPreferences: {
      // 启动页与页签栏共用这个 preload（tabbar.ts 同时暴露 piWebShell / piWebTabs）
      preload: join(__dirname, "../preload/tabbar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  mainWindowActivated = false;
  applyWindowIcon(win);

  win.on("ready-to-show", () => {
    if (!win.isDestroyed() && (!startHidden || mainWindowShownOnce)) win.show();
  });
  win.on("close", (event) => {
    if (quitting) return;
    if (loadSettings().closeBehavior === "tray" && tray?.exists) {
      event.preventDefault();
      win.hide();
      tray.showMinimizeBalloon();
    }
  });
  win.on("closed", () => {
    draftWorkspace?.detachAll();
    tabs?.destroy();
    tabs = null;
    mainWindow = null;
    mainWindowActivated = false;
  });

  return win;
}

/** 把主窗口切回启动页：首次启动、重启服务、启动失败时都走这里（不再单独弹小窗） */
function showBootPage(): void {
  const win = ensureMainWindow();
  if (mainWindowActivated) {
    draftWorkspace?.detachAll();
    tabs?.destroy();
    tabs = null;
    mainWindowActivated = false;
  }

  const theme = bootTheme();
  // 启动页跟着窗口的缓存主题走，切到页签栏时不会「深色 → 用户主题」跳一下
  loadPage(win, "splash", {
    bg: theme.bg,
    fg: theme.fg,
    scheme: theme.scheme,
    ...(theme.accent ? { accent: theme.accent } : {}),
  });
  win.show();
  win.focus();

  // 状态变化可能发生在页面加载完成之前（onState 广播会丢），加载完补发一次当前状态
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed() && manager) {
      win.webContents.send(IPC.stateEvent, manager.getState());
    }
  });

  const splashShot = process.env.PI_WEB_DESKTOP_SPLASH_SHOT;
  if (splashShot) captureAfter(win, splashShot, 1_200);
}

async function showMainWindow(baseUrl: string): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindowActivated) {
    if (tabs && tabs.baseUrl === baseUrl) {
      mainWindowShownOnce = true;
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    // 端口/地址变了（重启服务、接管外部实例后换端口）：只重建页签，窗口本身不换
    manager?.log(`[ui] 服务地址变化 → ${baseUrl}，重建页签`);
    // 旧 WebContents 的增强监听在这里清；onTabsReplaced() 不再 detach，
    // 否则会把新 TabManager.init() 刚注册的 dom-ready 监听一起摘掉（只读探针无法重装）
    draftWorkspace?.detachAll();
    tabs?.destroy();
    tabs = null;
    mainWindowActivated = false;
  }

  const win = ensureMainWindow();
  const settings = loadSettings();
  const appDataDir = dataDir();
  // 冷启动首帧就用上次缓存的主题色（没有缓存才退回系统明暗），不再闪一下浅色
  const cachedTheme = loadTheme(appDataDir);

  tabs = new TabManager({
    win,
    baseUrl,
    dataDir: appDataDir,
    restoreTabs: settings.restoreTabs,
    onTabsChanged: () => tray?.refresh(),
    onDebug: (message) => manager?.log(message),
    customTitleBar: customTitleBarEnabled(),
    initialTheme: cachedTheme,
    onTabCreated: (_tabId, wc) => draftWorkspace?.attach(wc as unknown as DraftContents),
    onTabClosed: (tabId) => draftWorkspace?.onTabClosed(tabId),
    onTabContextChanged: () => draftWorkspace?.refreshContext(),
  });

  // 先让页签视图开始加载 pi-web，再把窗口自身的页面从启动页换成页签栏：
  // 同一个窗口、同一个任务栏图标，只是内容原地切换
  await tabs.init();
  // 页签 id 每次启动都会变：把 drafts.json 里的草稿按 path + sessionKey 一对一恢复
  draftWorkspace?.onTabsReplaced();
  draftWorkspace?.hydrate(tabs.allDraftContexts());
  loadPage(win, "tabbar");
  mainWindowActivated = true;
  if (!startHidden || mainWindowShownOnce) {
    win.show();
    win.focus();
  }

  // 调试：确认 WCO 生效、以及给窗口控件留出的安全区宽度
  if (process.env.PI_WEB_DESKTOP_DEBUG_THEME) {
    win.webContents.once("did-finish-load", () => {
      const probe =
        "(() => { const o = navigator.windowControlsOverlay; const r = o && o.getTitlebarAreaRect ? o.getTitlebarAreaRect() : null; " +
        "return JSON.stringify({ wco: !!o, rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, " +
        "wcoSafeWidth: getComputedStyle(document.querySelector('.window-controls')).width, " +
        "scheme: document.documentElement.dataset.scheme, theme: document.documentElement.dataset.theme }); })()";
      void win.webContents
        .executeJavaScript(probe)
        .then((raw) => manager?.log(`[theme] 标题栏布局：${String(raw)}`))
        .catch((error: unknown) => manager?.log(`[theme] 标题栏布局探测失败：${String(error)}`));
    });
  }

  const tabbarShot = process.env.PI_WEB_DESKTOP_TABBAR_SHOT;
  if (tabbarShot) {
    captureAfter(win, tabbarShot, Number(process.env.PI_WEB_DESKTOP_SHOT_DELAY_MS ?? 2_000));
  }

  // 调试：模拟用户在 pi-web 里切主题（只改当前窗口 DOM，不落盘）
  // PI_WEB_DESKTOP_SELFTEST_THEME_NAME 可指定 mist / pine / sand / zenburn ...
  if (process.env.PI_WEB_DESKTOP_SELFTEST_THEME) {
    const name = process.env.PI_WEB_DESKTOP_SELFTEST_THEME_NAME || "dark";
    const darkThemes = ["dark", "pine", "dusk", "ember", "slate", "contrast-dark", "zenburn"];
    const script =
      `document.documentElement.dataset.theme = ${JSON.stringify(name)}; ` +
      `document.documentElement.classList.toggle("dark", ${JSON.stringify(darkThemes)}.includes(${JSON.stringify(name)})); ` +
      `try { localStorage.setItem("pi-theme", ${JSON.stringify(name)}); } catch (e) {}`;
    setTimeout(async () => {
      await tabs?.activeContents()?.executeJavaScript(script);
      manager?.log(`[selftest-theme] 已把页面切到 ${name}，等待页签栏跟随`);
    }, Number(process.env.PI_WEB_DESKTOP_THEME_SWITCH_AT ?? 6_000));
  }

  const shotPath = process.env.PI_WEB_DESKTOP_SCREENSHOT;
  if (shotPath) {
    setTimeout(() => {
      if (!tabs) return;
      void tabs
        .captureActive()
        .then((image) => {
          if (!image) return;
          writeFileSync(shotPath, image.toPNG());
          manager?.log(`[shot] 已保存页签截图：${shotPath}`);
        })
        .catch((error: unknown) => manager?.log(`[shot] 页签截图失败：${String(error)}`));
    }, 5_000);
  }

  if (process.env.PI_WEB_DESKTOP_SELFTEST) runSelftest();

  // 真实 GUI 自测：PI_WEB_DESKTOP_SELFTEST_DRAFT=1 PI_WEB_DESKTOP_DRAFT_SHOT=.pi/draft.png npm run app
  // 只做只读探针 + 面板/草稿操作，绝不真的向 Agent 发消息。
  if (process.env.PI_WEB_DESKTOP_SELFTEST_DRAFT) runDraftSelftest();
  if (process.env.PI_WEB_DESKTOP_DIAG_COMPOSER) runComposerDiagnose();

  // 验收用：启动后自动切到某种分屏布局并截图，例如
  // PI_WEB_DESKTOP_SELFTEST_SPLIT=grid-2x2 PI_WEB_DESKTOP_SPLIT_SHOT=.pi/split.png npm run app
  const splitPreset = process.env.PI_WEB_DESKTOP_SELFTEST_SPLIT;
  if (splitPreset) {
    setTimeout(() => {
      tabs?.setSplitPreset(splitPreset as SplitPreset);
      manager?.log(`[selftest-split] ${splitPreset} → ${JSON.stringify(tabs?.snapshot().split)}`);
      const shot = process.env.PI_WEB_DESKTOP_SPLIT_SHOT;
      if (shot && !win.isDestroyed()) {
        setTimeout(() => {
          if (win.isDestroyed()) return;
          void win
            .capturePage()
            .then((image) => {
              writeFileSync(shot, image.toPNG());
              manager?.log(`[shot] 已保存分屏截图：${shot}`);
            })
            .catch((error: unknown) => manager?.log(`[shot] 分屏截图失败：${String(error)}`));
        }, 2_000);
      }
    }, 4_000);
  }

  // 调试：验证「关窗口 → 进托盘」而不是退出
  if (process.env.PI_WEB_DESKTOP_SELFTEST_TRAY) {
    setTimeout(() => {
      const win = mainWindow;
      win?.close();
      setTimeout(() => {
        manager?.log(
          `[selftest-tray] window=${win?.isDestroyed() ? "已销毁" : "存活"} visible=${win?.isVisible()} tray=${tray?.exists}`,
        );
      }, 600);
    }, 3_000);
  }

  // 调试：打开设置窗口并截图
  if (process.env.PI_WEB_DESKTOP_OPEN_SETTINGS) {
    const settingsWin = openSettingsWindow(mainWindow);
    const shot = process.env.PI_WEB_DESKTOP_SETTINGS_SHOT;
    if (shot) captureAfter(settingsWin, shot, 2_500);
  }

}

/** 自动化验证：开启局域网访问（密码加密保存 + 环境变量传给 pi-web）→ 探登录页 → 恢复 */
function runRemoteSelftest(): void {
  setTimeout(async () => {
    if (!settingsService || !manager) return;
    const result = await settingsService.save(
      { remoteAccess: { enabled: true, password: settingsService.generatePassword() } },
      true,
    );
    const state = manager.getState();
    const lan = settingsService.lan().map((item) => item.url);
    manager.log(
      `[selftest-remote] ok=${result.ok} phase=${state.phase} url=${state.url} host=${state.hostname} lan=${lan.join(",") || "—"}`,
    );

    const root = await fetch(`${state.url ?? ""}/`, { redirect: "manual" })
      .then((response) => response.status)
      .catch(() => null);
    manager.log(`[selftest-remote] GET / → ${root}（302/307 到 /login 说明密码生效）`);

    await settingsService.save({ remoteAccess: { enabled: false, password: null } }, true);
    manager.log(`[selftest-remote] 已恢复仅本机访问，phase=${manager.getState().phase}`);
  }, 6_000);
}

let mainWindowShownOnce = false;

function showMainWindowIfPossible(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindowShownOnce = true;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const state = manager?.getState();
  if (state?.phase === "ready" && state.url) {
    mainWindowShownOnce = true;
    void showMainWindow(state.url);
  } else {
    showBootPage();
  }
}

/* ------------------------------ 服务 ------------------------------ */

async function restartServer(): Promise<void> {
  manager?.log("[restart] 用户请求重启服务");
  mainWindowShownOnce = true;
  showBootPage();
  manager?.setSettings(loadSettings());
  manager?.clearInstall();
  const state = await (manager?.restart() ?? Promise.resolve(IDLE_STATE));
  tray?.refresh();
  if (state.phase === "ready" && state.url) void showMainWindow(state.url);
  else showBootPage();
}

/** 设置里改了端口/绑定/安装路径：切回启动页，重启后原地重建页签 */
async function restartAll(): Promise<void> {
  mainWindowShownOnce = true;
  showBootPage();
  manager?.setSettings(loadSettings());
  manager?.clearInstall();
  const state = await (manager?.restart() ?? Promise.resolve(IDLE_STATE));
  tray?.refresh();
  if (state.phase === "ready" && state.url) await showMainWindow(state.url);
  else showBootPage();
}

function applyRuntimeSettings(settings: AppSettings): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  tray?.refresh();
}

/** 服务失败提示：只用托盘气泡。Windows toast 会让 Electron 自动创建带原子图标的开始菜单快捷方式 */
function notifyFailure(message: string): void {
  manager?.log(`[fail] 服务启动失败：${message}`);
  tray?.showFailureBalloon(message);
}

async function showServerStatus(): Promise<void> {
  const state = manager?.getState() ?? IDLE_STATE;
  const settings = loadSettings();
  const lan = settings.remoteAccess.enabled ? listLanAddresses(state.port ?? settings.port) : [];
  const lines = [
    `状态：${state.phase}`,
    `地址：${state.url ?? "—"}${state.managed ? "" : "（复用外部实例）"}`,
    `版本：${state.version ?? "—"}`,
    `数据目录：${dataDir()}`,
    settings.remoteAccess.enabled ? `局域网：${lan.map((item) => item.url).join("\n         ") || "未找到"}` : "局域网：未开启",
  ];
  await dialog.showMessageBox({
    type: "info",
    title: "服务状态",
    message: "pi-web 服务",
    detail: lines.join("\n"),
    buttons: ["知道了", "打开日志"],
    defaultId: 0,
    cancelId: 0,
  }).then((result) => {
    if (result.response === 1) void shell.openPath(logFilePath());
  });
}

async function checkPiWebUpdates(): Promise<void> {
  try {
    const check = await checkPiWebUpdate(loadSettings());
    manager?.log(`[update] 当前 v${check.current}，registry 最新 v${check.latest}`);
    await dialog.showMessageBox({
      type: "info",
      title: "检查 pi-web 更新",
      message: check.hasUpdate
        ? `有新版本 v${check.latest}（当前 v${check.current}）`
        : `已是最新版本 v${check.current}`,
      detail: [
        `当前版本：v${check.current}`,
        `registry 最新版本：v${check.latest}`,
        `安装位置：${check.scriptPath}`,
        "",
        check.hasUpdate
          ? "到「设置 → 服务 → 检查 pi-web 更新」可一键停止服务、更新全局包并重启。"
          : "无需更新。",
      ].join("\n"),
      buttons: ["知道了", "打开设置"],
      defaultId: 0,
      cancelId: 0,
    }).then((result) => {
      if (result.response === 1) openSettingsWindow(mainWindow);
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "检查 pi-web 更新",
      message: "检查更新失败",
      detail: String(error),
    });
  }
}

async function showAbout(): Promise<void> {
  const state = manager?.getState();
  await dialog.showMessageBox({
    type: "info",
    title: "关于",
    message: "Pi Web Desktop",
    detail: [
      `外壳版本：v${app.getVersion()}`,
      `pi-web：v${state?.version ?? "—"}`,
      `数据目录：${dataDir()}`,
      "",
      "只是一个壳：不修改 pi-web，升级 pi-web 后重启即生效。",
    ].join("\n"),
    buttons: ["好"],
  });
}

/* --------------------------- 调试/验证 --------------------------- */

/** 升级上游后 dump 真实 Composer DOM：字体变量 / 全部按钮，写进 server.log */
function runComposerDiagnose(): void {
  setTimeout(() => {
    const wc = tabs?.activeContents();
    if (!wc || wc.isDestroyed()) return;
    void wc
      .executeJavaScript(COMPOSER_DIAGNOSE_SCRIPT, true)
      .then((raw) => manager?.log(`[diag-composer] ${String(raw)}`))
      .catch((error: unknown) => manager?.log(`[diag-composer] 失败：${String(error)}`));
  }, 6_000);
}

/**
 * 独立输入工作区的真实 GUI 自测（不启动对话、不向 Agent 发任何消息）。
 * 覆盖：打开/关闭、大量文本、页签隔离、收起后保留、兼容性只读探针、原生输入框仍在。
 * 发送成功/失败/连点去重/会话切换隔离由 check:draft-workspace 的 mock 回归覆盖，
 * 避免自测把真实消息发进用户会话。
 */
function runDraftSelftest(): void {
  setTimeout(async () => {
    const ws = draftWorkspace;
    const mgr = tabs;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!ws || !mgr) {
      manager?.log("[selftest-draft] 工作区或页签管理器未就绪");
      return;
    }
    const results: string[] = [];
    // 64x64 纯色 PNG：图片附件 / 纯图片发送验证共用
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADZSURBVHhe7dBBDcQAEMPAA1b+KI5LS2AIROtI/vgX//7P816mAJKXKIDkJQogeYkCSF6iAJJibfogCiAp1qYPogCSYm36IAogKdamD6IAkmJt+iAKICnWpg+iAJJibfogCiAp1qYPogCSYm36IAogKdamD6IAkmJt+iAKICnWpg+iAJJibfogCiAp1qYPogCSYm36IAogKdamD6IAkmJt+iAKICnWpg+iAJJibfogCiAp1qYPogCSYm36IAogKdamD6IAkpcogOQlCiB5iQJIXqIAkpc4HuB5P+5DwPD5sak1AAAAAElFTkSuQmCC";
    const firstId = mgr.snapshot().activeId;
    results.push(`firstTab=${firstId ? "yes" : "no"}`);

    // 面板收起时先量一次 pi-web 视图 bounds，展开后再量一次：
    // 宽度变小证明对话区是被「让出空间」而不是被面板盖住。
    const sizeOf = (): string => {
      const bounds = mgr.activeViewBounds();
      return bounds ? `${bounds.width}x${bounds.height}@x${bounds.x}` : "none";
    };
    results.push(`viewClosed=${sizeOf()}`);

    ws.open();
    await wait(250);
    results.push(`open=${ws.snapshot().open}`);

    const big = "独立输入工作区长文本回归 ABCDEFG ".repeat(4_000);
    ws.setText(big);
    results.push(`largeText=${ws.snapshot().text.length}`);

    const secondId = mgr.createTab("/", { activate: true });
    await wait(400);
    results.push(`tabIsolation=${ws.snapshot().text.length === 0}`);
    ws.setText("B 页签自己的草稿");

    if (firstId) {
      mgr.activate(firstId);
      await wait(400);
    }
    results.push(`backToA=${ws.snapshot().text === big}`);

    ws.close();
    await wait(150);
    ws.open();
    await wait(150);
    results.push(`closeKeepsDraft=${ws.snapshot().text === big}`);
    results.push(`secondTabIsolated=${secondId ? mgr.draftContext(secondId) !== null : false}`);
    results.push(`compat=${ws.snapshot().compat.level}`);

    const activeId = mgr.snapshot().activeId;
    const wc = activeId ? mgr.draftContents(activeId) : null;
    if (wc && !wc.isDestroyed()) {
      try {
        const raw = await wc.executeJavaScript(COMPOSER_PROBE_SCRIPT, true);
        const probe = JSON.parse(String(raw)) as { textarea?: boolean; sendButton?: boolean };
        results.push(`nativeComposer=${Boolean(probe.textarea)} sendButton=${Boolean(probe.sendButton)}`);
      } catch (error) {
        results.push(`nativeComposer=error:${String(error)}`);
      }
    }
    results.push(`viewOpen=${sizeOf()}`);

    /* ---- 真实 GUI 前置验证：不点击任何提交按钮、不发消息，最后还原原生输入框 ---- */
    if (wc && !wc.isDestroyed()) {
      const preflight =
        "(() => { var shell = document.querySelector('.chat-input-shell');" +
        " var ta = document.querySelector('.chat-input-shell textarea.chat-input-textarea');" +
        " if (!shell || !ta) return JSON.stringify({ ok: false, reason: 'no textarea' });" +
        " function sendButton(){ var list = shell.querySelectorAll('button');" +
        " for (var i=0;i<list.length;i++){ var a=(list[i].getAttribute('aria-label')||'').trim();" +
        " if (a==='发送'||a==='傳送'||a==='Send') return list[i]; } return null; }" +
        " var b0 = sendButton(); if (!b0) return JSON.stringify({ ok:false, reason:'no send button' });" +
        " var before = b0.disabled, original = ta.value || '';" +
        " var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
        " setter.call(ta, '独立输入工作区发送前置验证（不提交）');" +
        " ta.dispatchEvent(new Event('input', { bubbles: true }));" +
        " return new Promise(function(resolve){ setTimeout(function(){" +
        " var b1 = sendButton(), after = b1 ? b1.disabled : null;" +
        " setter.call(ta, original); ta.dispatchEvent(new Event('input', { bubbles: true }));" +
        " resolve(JSON.stringify({ before: before, after: after," +
        " enabledByInput: before === true && after === false," +
        " injectedEntry: !!document.getElementById('pi-desktop-draft-entry') ||" +
        " !!window.__piDesktopDraftEntry }));" +
        " }, 240); }); })()";
      try {
        const pre = JSON.parse(String(await wc.executeJavaScript(preflight, true))) as {
          before?: boolean;
          after?: boolean;
          enabledByInput?: boolean;
          injectedEntry?: boolean;
          reason?: string;
        };
        results.push(`sendPreflight=${pre.enabledByInput === true} (disabled ${String(pre.before)}→${String(pre.after)})`);
        results.push(`noInjectedEntry=${pre.injectedEntry === false}`);
      } catch (error) {
        results.push(`sendPreflight=error:${String(error)}`);
      }
    }

    // 字体一致性：面板读的是原生 textarea 的 computed style，这里两边对比
    if (mainWindow && !mainWindow.isDestroyed()) try {
      const panelFont = JSON.parse(
        String(
          await mainWindow.webContents.executeJavaScript(
            "(() => { var e = document.getElementById('draft-editor'); if (!e) return 'null';" +
              " var s = getComputedStyle(e); return JSON.stringify({ family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight }); })()",
          ),
        ),
      ) as { family: string; size: string; lineHeight: string } | null;
      const nativeFont = JSON.parse(String(await (wc as NonNullable<typeof wc>).executeJavaScript(
        "(() => { var t = document.querySelector('textarea.chat-input-textarea'); if (!t) return 'null';" +
          " var s = getComputedStyle(t); return JSON.stringify({ family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight }); })()",
      ))) as { family: string; size: string; lineHeight: string } | null;
      results.push(
        `fontMatch=${Boolean(panelFont && nativeFont && panelFont.family === nativeFont.family && panelFont.size === nativeFont.size && panelFont.lineHeight === nativeFont.lineHeight)}`,
      );
    } catch (error) {
      results.push(`fontMatch=error:${String(error)}`);
    }

    // 拖动宽度：520px 应让 pi-web 视图变成 1440-520=920
    ws.setWidth(520);
    await wait(150);
    results.push(`resized=${sizeOf()}`);
    ws.setWidth(380);

    // 可选：临时把主输入框的 class 摘掉，模拟「pi-web Composer DOM 变化」。
    // 只改一个 class、随后立即恢复，验证「禁止错误发送」且原生输入框依旧可用。
    if (process.env.PI_WEB_DESKTOP_SELFTEST_DRAFT_INCOMPAT && wc && !wc.isDestroyed() && secondId) {
      // React 每次重渲染都会把 className 写回来，所以要用 MutationObserver 持续摘掉，
      // 才能稳定模拟「上游改了选择器」；测试结束 disconnect 并恢复，原生输入框自始至终可用。
      const breakScript =
        "(() => { var ta = document.querySelector('.chat-input-shell textarea.chat-input-textarea');" +
        " if (!ta) return 'none'; window.__piDesktopDraftBroken = ta;" +
        " var strip = function(){ var list = document.querySelectorAll('textarea.chat-input-textarea');" +
        " for (var i=0;i<list.length;i++) list[i].classList.remove('chat-input-textarea'); };" +
        // 观察整个 body 子树：React 可能直接替换 textarea 节点，只观察旧节点会漏
        " var mo = new MutationObserver(strip);" +
        " mo.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });" +
        " window.__piDesktopDraftBreakObserver = mo;" +
        " strip(); return 'broken'; })()";
      const restoreScript =
        "(() => { if (window.__piDesktopDraftBreakObserver) {" +
        " window.__piDesktopDraftBreakObserver.disconnect(); delete window.__piDesktopDraftBreakObserver; }" +
        " var shell = document.querySelector('.chat-input-shell');" +
        " var list = shell ? shell.querySelectorAll('textarea') : [];" +
        " for (var i=0;i<list.length;i++) list[i].classList.add('chat-input-textarea');" +
        " delete window.__piDesktopDraftBroken; return 'restored'; })()";
      const nativeScript =
        "(() => { var ta = document.querySelector('.chat-input-shell textarea');" +
        " return JSON.stringify({ exists: !!ta, disabled: ta ? ta.disabled : true }); })()";
      try {
        results.push(`simulate=${await wc.executeJavaScript(breakScript, true)}`);
        mgr.activate(secondId);
        await wait(200);
        if (firstId) mgr.activate(firstId);
        await wait(2_200); // 探针会短轮询 1.8s 才下「不兼容」结论
        results.push(`incompat=${ws.snapshot().compat.level}`);
        const native = JSON.parse(String(await wc.executeJavaScript(nativeScript, true))) as {
          exists: boolean;
          disabled: boolean;
        };
        results.push(`nativeStillUsable=${native.exists && !native.disabled}`);
        const beforeCalls = ws.snapshot().text.length;
        // 只有确认已降级为 disabled 才敢点发送：否则会把真实消息发进会话
        if (ws.snapshot().compat.level === "disabled") {
          const blocked = await ws.send();
          results.push(`blockedSend=${!blocked.ok} draftKept=${ws.snapshot().text.length === beforeCalls}`);
        } else {
          results.push("blockedSend=skipped(未降级)");
        }
      } catch (error) {
        results.push(`incompatTest=error:${String(error)}`);
      } finally {
        try { await wc.executeJavaScript(restoreScript, true); } catch { /* 页面可能已销毁 */ }
        if (secondId) mgr.activate(secondId);
        await wait(200);
        if (firstId) mgr.activate(firstId);
        await wait(400);
        results.push(`restored=${ws.snapshot().compat.level}`);
      }
    }

    manager?.log(`[selftest-draft] ${results.join(" ")}`);

    const shot = process.env.PI_WEB_DESKTOP_DRAFT_SHOT;
    if (shot && mainWindow && !mainWindow.isDestroyed()) {
      const image = await mainWindow.capturePage();
      writeFileSync(shot, image.toPNG());
      manager?.log(`[shot] 已保存独立输入工作区截图：${shot}`);
    }

    /* ---- UI 收敛验证：单提交按钮 / 原生图标 / 图片预览 / 提示自动消失 ---- */
    const ui: string[] = [];
    if (mainWindow && !mainWindow.isDestroyed()) {
      const structure = JSON.parse(
        String(
          await mainWindow.webContents.executeJavaScript(
            "(() => { var q=function(id){return document.getElementById(id)};" +
              " var a=q('draft-attach'), s=q('draft-send'), c=q('draft-context');" +
              " return JSON.stringify({ noModebar: !q('draft-modes'), noNativeButton: !q('draft-native')," +
              " noMore: !q('draft-submit-more'), noMenu: !q('draft-menu'), hasSend: !!s," +
              " hasContext: !!c, contextHidden: c?c.hidden:false," +
              " sendText: s?s.textContent.trim():''," +
              " attachSvg: !!(a&&a.querySelector('svg')), attachBorder: a?getComputedStyle(a).borderStyle:'' }); })()",
          ),
        ),
      ) as {
        noModebar: boolean; noNativeButton: boolean; noMore: boolean; noMenu: boolean;
        hasSend: boolean; hasContext: boolean; contextHidden: boolean;
        sendText: string; attachSvg: boolean; attachBorder: string;
      };
      ui.push(`singleSubmit=${structure.noModebar && structure.noNativeButton && structure.noMore && structure.noMenu && structure.hasSend}`);
      ui.push(`nativeSvgIcon=${structure.attachSvg && structure.attachBorder === "none"} (${structure.attachBorder})`);
      ui.push(`sendLabel=${structure.sendText}`);
      ui.push(`autoModeIdle=${structure.sendText === "发送到对话"}`);
      ui.push(`hiddenNativeEntry=${structure.hasContext && structure.contextHidden}`);

      // 64x64 纯色 PNG：验证附件能取回数据、点开后图片确实有可见尺寸
      const tiny = tinyPng;
      ws.addImages([{ data: tiny, mimeType: "image/png", name: "selftest.png" }]);
      await wait(250);
      const first = ws.snapshot().attachments[0];
      ui.push(`imageStored=${Boolean(first && ws.getImage(first.id)?.data)}`);
      const chipClicked = await mainWindow.webContents.executeJavaScript(
        "(() => { var c=document.querySelector('.draft-attachment'); if(!c) return false; c.click(); return true; })()",
      );
      await wait(400);
      const lightbox = JSON.parse(
        String(
          await mainWindow.webContents.executeJavaScript(
            "(() => { var l=document.getElementById('draft-lightbox'), i=document.getElementById('draft-lightbox-img');" +
              " return JSON.stringify({ open: !!l&&!l.hidden, src: i?(i.getAttribute('src')||'').slice(0,22):'' }); })()",
          ),
        ),
      ) as { open: boolean; src: string };
      const imgDiag = JSON.parse(
        String(
          await mainWindow.webContents.executeJavaScript(
            "(() => { var i=document.getElementById('draft-lightbox-img'), l=document.getElementById('draft-lightbox');" +
              " var s=getComputedStyle(i), r=i.getBoundingClientRect(), lr=l.getBoundingClientRect();" +
              " return JSON.stringify({ complete:i.complete, nw:i.naturalWidth, nh:i.naturalHeight," +
              " srcLen:(i.getAttribute('src')||'').length, display:s.display, opacity:s.opacity," +
              " w:Math.round(r.width), h:Math.round(r.height), x:Math.round(r.left), y:Math.round(r.top)," +
              " lx:Math.round(lr.left), ly:Math.round(lr.top), lw:Math.round(lr.width), lh:Math.round(lr.height)," +
              " panelOverflow:getComputedStyle(document.getElementById('draft-panel')).overflow }); })()",
          ),
        ),
      ) as Record<string, unknown>;
      ui.push(
        `imgVisible=${imgDiag.nw === 64 && imgDiag.nh === 64 && Number(imgDiag.w) > 0 && Number(imgDiag.h) > 0 && Number(imgDiag.lw) < 800} (nw=${String(imgDiag.nw)} w=${String(imgDiag.w)} lw=${String(imgDiag.lw)})`,
      );
      ui.push(`imagePreview=${Boolean(chipClicked) && lightbox.open && lightbox.src.startsWith("data:image/png")}`);
      const previewShot = process.env.PI_WEB_DESKTOP_PREVIEW_SHOT;
      if (previewShot && mainWindow && !mainWindow.isDestroyed()) {
        const image = await mainWindow.capturePage();
        writeFileSync(previewShot, image.toPNG());
      }
      await mainWindow.webContents.executeJavaScript("document.getElementById('draft-lightbox-close').click()");

      // 「在原生输入框中继续」收进编辑器右键菜单，默认隐藏、不占可见按钮位
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('draft-editor').dispatchEvent(new MouseEvent('contextmenu'," +
          "{ bubbles:true, cancelable:true, clientX:1200, clientY:300 }))",
      );
      await wait(150);
      const ctx = JSON.parse(
        String(
          await mainWindow.webContents.executeJavaScript(
            "(() => { var c=document.getElementById('draft-context');" +
              " return JSON.stringify({ open: !c.hidden, items: c.querySelectorAll('button').length }); })()",
          ),
        ),
      ) as { open: boolean; items: number };
      ui.push(`contextNative=${ctx.open && ctx.items === 1}`);
      await mainWindow.webContents.executeJavaScript("document.getElementById('draft-context').hidden = true");

      // 成功提示 4 秒后自动消失（不点提交按钮，只搬内容到原生输入框）
      const native = await ws.openInNative();
      await wait(350);
      const shown = await mainWindow.webContents.executeJavaScript("!document.getElementById('draft-result').hidden");
      await wait(4_700);
      const gone = await mainWindow.webContents.executeJavaScript("document.getElementById('draft-result').hidden");
      ui.push(
        `successHintAutoHide=${native.ok && Boolean(shown) && Boolean(gone)} (ok=${native.ok} shown=${String(shown)} gone=${String(gone)})`,
      );
    }
    manager?.log(`[selftest-draft-ui] ${ui.join(" ")}`);

    /* ---- Agent 运行期间的真实页面发送行为 ----
     * 真实 Agent 需要 LLM 凭据，自动化里不触发对话；改为在**真实 pi-web 页面**上复现
     * streaming 时的 Composer 按钮组（send → 引导 / 后续消息），拦截 button.click 不真发消息，
     * 再执行真正的 buildComposerSendScript 验证按模式选按钮、fieldset 状态与纯图片发送。
     * 结束恢复 DOM 并 reload 页签，避免把临时图片附件留在原生输入框。 */
    if (wc && !wc.isDestroyed()) {
      const stream: string[] = [];
      try {
        const sessionKey = String(
          await wc.executeJavaScript(
            "(() => { var p=new URLSearchParams(location.search); var s=p.get('session'); var c=p.get('cwd');" +
              " return s ? 'session:'+s : (c ? 'cwd:'+c : 'new'); })()",
          ),
        );
        const install =
          "(() => { var shell=document.querySelector('.chat-input-shell');" +
          " var ta=document.querySelector('.chat-input-shell textarea.chat-input-textarea');" +
          " if(!shell||!ta) return 'no-composer';" +
          " var fs=shell.tagName==='FIELDSET'?shell:ta.closest('fieldset');" +
          " var st=window.__piDesktopStreamTest={ clicks:[], originalClick:HTMLButtonElement.prototype.click," +
          " originalText:ta.value||'', fieldsetDisabled:fs?!!fs.disabled:null," +
          " fieldsetBusy:fs?fs.getAttribute('aria-busy'):null, buttons:[], send:null };" +
          // 拦截点击：只记录点了哪个原生按钮并模拟 tw() 清空，绝不真的把消息发给 Agent
          " HTMLButtonElement.prototype.click=function(){"+ 
          " st.clicks.push((this.getAttribute('aria-label')||this.textContent||'').trim());" +
          " try{ var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
          " setter.call(ta,''); ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}" +
          " try{ var imgs=shell.querySelectorAll('img[src^=\"blob:\"], img[src^=\"data:\"]');" +
          " for(var j=0;j<imgs.length;j++) imgs[j].parentNode&&imgs[j].parentNode.removeChild(imgs[j]); }catch(e){} };" +
          " var list=shell.querySelectorAll('button');" +
          " for(var i=0;i<list.length;i++){ var a=(list[i].getAttribute('aria-label')||'').trim();" +
          " if(a==='发送'||a==='傳送'||a==='Send'){ st.send=list[i]; break; } }" +
          " if(st.send) st.send.style.display='none';" +
          " ['引导','后续消息'].forEach(function(label){ var b=document.createElement('button');" +
          " b.type='button'; b.setAttribute('aria-label',label); b.textContent=label; b.disabled=false;" +
          " shell.appendChild(b); st.buttons.push(b); });" +
          " return 'installed'; })()";
        stream.push(`install=${String(await wc.executeJavaScript(install, true))}`);
        const fsState = JSON.parse(
          String(
            await wc.executeJavaScript(
              "(() => { var s=window.__piDesktopStreamTest;" +
                " return JSON.stringify({disabled:s.fieldsetDisabled,busy:s.fieldsetBusy,buttons:s.buttons.length}); })()",
            ),
          ),
        ) as { disabled: boolean | null; busy: string | null; buttons: number };
        // 实证：空闲时 fieldset 不禁用（上游只在斜杠命令执行时短暂锁住）
        stream.push(`idleFieldset=${String(fsState.disabled)} busy=${String(fsState.busy)} steerButtons=${fsState.buttons}`);

        const runMode = async (mode: "send" | "steer" | "followUp", withImage: boolean): Promise<void> => {
          await wc.executeJavaScript("window.__piDesktopStreamTest.clicks.length = 0");
          const raw = await wc.executeJavaScript(
            buildComposerSendScript({
              text: withImage ? "" : `GUI 模式验证 ${mode}`,
              sessionKey,
              mode,
              images: withImage ? [{ data: tinyPng, mimeType: "image/png", name: "gui.png" }] : [],
            }),
            true,
          );
          const res = JSON.parse(String(raw)) as { ok: boolean; reason: string };
          const clicks = JSON.parse(
            String(await wc.executeJavaScript("JSON.stringify(window.__piDesktopStreamTest.clicks)")),
          ) as string[];
          const expected = mode === "send" ? "发送" : mode === "steer" ? "引导" : "后续消息";
          const clicked = clicks.some((label) => label === expected || label.includes(expected));
          if (withImage) {
            stream.push(`imageOnly=${clicked && !/草稿为空/.test(res.reason)} (clicked=${clicked} ok=${res.ok})`);
          } else {
            stream.push(`${mode}=${res.ok && clicked} (ok=${res.ok} clicked=${clicked} reason=${res.reason.slice(0, 28)})`);
          }
        };
        await runMode("send", false);
        await runMode("steer", false);
        await runMode("followUp", false);
        await runMode("send", true);

        // fieldset 被锁住时：不再返回笼统的「输入框不可用」，而是按模式给出准确原因
        await wc.executeJavaScript(
          "(() => { var s=window.__piDesktopStreamTest;" +
            " var fs=document.querySelector('.chat-input-shell'); if(fs&&fs.tagName==='FIELDSET') fs.disabled=true;" +
            " s.clicks.length=0; return 'locked'; })()",
        );
        const lockedRaw = await wc.executeJavaScript(
          buildComposerSendScript({ text: "锁住时的引导", sessionKey, mode: "steer", images: [] }),
          true,
        );
        const locked = JSON.parse(String(lockedRaw)) as { ok: boolean; reason: string };
        stream.push(
          `lockedByMode=${!locked.ok && /找不到可用的原生引导按钮/.test(locked.reason) && !/输入框当前不可用/.test(locked.reason)}`,
        );
      } catch (error) {
        stream.push(`error=${String(error)}`);
      } finally {
        try {
          await wc.executeJavaScript(
            "(() => { var st=window.__piDesktopStreamTest; if(!st) return 'none';" +
              " HTMLButtonElement.prototype.click=st.originalClick;" +
              " for(var i=0;i<st.buttons.length;i++){var b=st.buttons[i]; if(b.parentNode) b.parentNode.removeChild(b);}" +
              " if(st.send) st.send.style.display='';" +
              " var ta=document.querySelector('.chat-input-shell textarea.chat-input-textarea');" +
              " if(ta){try{var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
              " setter.call(ta,st.originalText); ta.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}}" +
              " delete window.__piDesktopStreamTest; return 'restored'; })()",
          );
          wc.reload(); // 清掉 paste 进原生 Composer 的临时图片附件，恢复干净页面
        } catch {
          // 页面可能已销毁
        }
      }
      manager?.log(`[selftest-draft-stream] ${stream.join(" ")}`);
    }
  }, 4_000);
}

function runSelftest(): void {
  setTimeout(async () => {
    const snap = () => tabs?.snapshot();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const before = snap()?.tabs.length ?? 0;

    const executed = await tabs
      ?.activeContents()
      ?.executeJavaScript("window.open('?cwd=' + encodeURIComponent(location.search || '/'), '_blank')")
      .then(() => true)
      .catch(() => false);
    await wait(1_500);
    const afterOpen = snap()?.tabs.length ?? 0;

    const target = snap()?.tabs.find((tab) => !tab.pinned) ?? null;
    if (target) tabs?.setPinned(target.id, true);
    await wait(250);
    const pinnedFirst = snap()?.tabs[0]?.pinned === true;

    if (target) tabs?.closeTab(target.id);
    await wait(200);
    const pinnedKept = (snap()?.tabs ?? []).some((tab) => tab.id === target?.id);

    if (target) {
      tabs?.setPinned(target.id, false);
      tabs?.closeTab(target.id);
    }
    await wait(400);
    const afterClose = snap()?.tabs.length ?? 0;

    manager?.log(
      `[selftest] open ${before}→${afterOpen}（execute=${executed}） pinFirst=${pinnedFirst} pinnedKept=${pinnedKept} close→${afterClose}`,
    );
  }, 4_500);
}

/* ----------------------------- 退出 ----------------------------- */

app.on("window-all-closed", () => {
  if (quitting) {
    app.quit();
    return;
  }
  if (loadSettings().closeBehavior === "tray" && tray?.exists) return; // 托盘常驻
  quitting = true;
  app.quit();
});

let cleanupDone = false;
app.on("before-quit", (event) => {
  if (cleanupDone || !manager) return;
  quitting = true;
  autoShortcutWatcher?.close();
  autoShortcutWatcher = null;
  event.preventDefault();
  void (async () => {
    try {
      tabs?.destroy();
      tabs = null;
      await manager?.stop();
    } finally {
      tray?.destroy();
      tray = null;
      cleanupDone = true;
      app.quit();
    }
  })();
});

if (isDev) {
  console.log(`[pi-web-desktop] data dir: ${dataDir()}`);
}

// 主进程兜底：单个延迟回调碰到已销毁对象时不要弹「A JavaScript error occurred」对话框
process.on("uncaughtException", (error) => {
  manager?.log(`[fatal] 未捕获异常：${error?.stack ?? String(error)}`);
});
