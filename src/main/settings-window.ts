import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { windowIconPath } from "./assets";
import { dataDir } from "./settings";
import { loadTheme } from "./tabs/theme-persistence";
import { customTitleBarEnabled, defaultSymbolColor, titleBarOptions, toOpaqueHex } from "./titlebar";
import { applyWindowIcon } from "./window-icon";

let settingsWindow: BrowserWindow | null = null;

interface SettingsTheme {
  scheme: "light" | "dark";
  name: string;
  vars: Record<string, string>;
  bg: string;
  fg: string;
}

/** 与页签栏一样读缓存的 pi-web 主题；设置窗口只是外壳页面，不碰任何配置读写。 */
function readTheme(): SettingsTheme {
  const cached = loadTheme(dataDir());
  const scheme = cached?.scheme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  return {
    scheme,
    name: cached?.name ?? scheme,
    vars: cached?.vars ?? {},
    bg: toOpaqueHex(cached?.vars["--bg"], scheme, scheme === "dark" ? "#1a1a1a" : "#ffffff"),
    fg: toOpaqueHex(cached?.vars["--text"], scheme, defaultSymbolColor(scheme)),
  };
}

/** 不新增 IPC / preload API：沿用主进程注入脚本的方式把主题变量写进设置页。 */
function injectTheme(win: BrowserWindow, theme: SettingsTheme): void {
  if (win.isDestroyed()) return;
  const script = `(() => {
    const root = document.documentElement;
    const vars = ${JSON.stringify(theme.vars)};
    let previous = [];
    try { previous = JSON.parse(root.dataset.piWebThemeVars || "[]"); } catch { previous = []; }
    for (const key of previous) if (!(key in vars)) root.style.removeProperty(key);
    root.dataset.piWebThemeVars = JSON.stringify(Object.keys(vars));
    root.dataset.scheme = ${JSON.stringify(theme.scheme)};
    root.dataset.theme = ${JSON.stringify(theme.name)};
    root.style.colorScheme = ${JSON.stringify(theme.scheme)};
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  })()`;
  void win.webContents.executeJavaScript(script).catch(() => {});
}

export function openSettingsWindow(parent: BrowserWindow | null): BrowserWindow {
  const theme = readTheme();

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    injectTheme(settingsWindow, theme);
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const devServer = process.env.ELECTRON_RENDERER_URL;

  settingsWindow = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    parent: parent ?? undefined,
    modal: false,
    backgroundColor: theme.bg,
    icon: windowIconPath() ?? undefined,
    title: "设置 — Pi Web Desktop",
    autoHideMenuBar: true,
    ...titleBarOptions(theme.bg, theme.fg),
    webPreferences: {
      preload: join(__dirname, "../preload/settings.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyWindowIcon(settingsWindow);
  const win = settingsWindow;
  win.webContents.once("dom-ready", () => injectTheme(win, theme));
  win.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  const page = devServer
    ? new URL("settings/index.html", `${devServer}/`).toString()
    : join(__dirname, "../renderer/settings/index.html");
  if (page.startsWith("http")) {
    const url = new URL(page);
    if (customTitleBarEnabled()) url.searchParams.set("titlebar", "overlay");
    void settingsWindow.loadURL(url.toString());
  } else {
    void settingsWindow.loadFile(
      page,
      customTitleBarEnabled() ? { query: { titlebar: "overlay" } } : {},
    );
  }

  return settingsWindow;
}

export function closeSettingsWindow(): void {
  settingsWindow?.close();
}
