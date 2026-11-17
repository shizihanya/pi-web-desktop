import { BrowserWindow } from "electron";
import { join } from "node:path";
import { windowIconPath } from "./assets";
import { customTitleBarEnabled, titleBarOptions } from "./titlebar";
import { applyWindowIcon } from "./window-icon";

let settingsWindow: BrowserWindow | null = null;

export function openSettingsWindow(parent: BrowserWindow | null): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const devServer = process.env.ELECTRON_RENDERER_URL;

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 820,
    minWidth: 680,
    minHeight: 560,
    show: false,
    parent: parent ?? undefined,
    modal: false,
    backgroundColor: "#0f141c",
    icon: windowIconPath() ?? undefined,
    title: "设置 — Pi Web Desktop",
    autoHideMenuBar: true,
    ...titleBarOptions("#0f141c", "#d7e2f0"),
    webPreferences: {
      preload: join(__dirname, "../preload/settings.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyWindowIcon(settingsWindow);
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
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
