import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { trayIconPath, windowIconPath } from "./assets";
import { IPC } from "../shared/types";
import type { SplitPreset } from "../shared/split";
import { registerIpc, registerTabIpc } from "./ipc";
import { installAppMenu } from "./menu";
import { REMOTE_ACCESS_KEY, readSecret } from "./secret-store";
import { listLanAddresses } from "./server/network";
import { checkPiWebUpdate } from "./server/pi-web-update";
import { ServerManager } from "./server/server-manager";
import { dataDir, loadSettings, logFilePath, type AppSettings } from "./settings";
import { SettingsService } from "./settings-service";
import { openSettingsWindow } from "./settings-window";
import { TabManager } from "./tabs/tab-manager";
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
  });

  // 先让页签视图开始加载 pi-web，再把窗口自身的页面从启动页换成页签栏：
  // 同一个窗口、同一个任务栏图标，只是内容原地切换
  await tabs.init();
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
        "paddingRight: getComputedStyle(document.querySelector('.tabbar')).paddingRight, " +
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
