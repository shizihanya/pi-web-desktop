import { app, BrowserWindow, ipcMain, shell } from "electron";
import { IPC, TAB_IPC } from "../shared/types";
import type { SplitPreset } from "../shared/split";
import type { ServerManager } from "./server/server-manager";
import type { TabManager } from "./tabs/tab-manager";
import { dataDir, logFilePath } from "./settings";

export interface IpcContext {
  manager: ServerManager;
  /** 服务就绪后的回调（首次启动 / 手动重试都走这里） */
  onReady: (url: string) => void;
}

export function registerIpc(context: IpcContext): void {
  const { manager, onReady } = context;

  ipcMain.handle(IPC.getState, () => manager.getState());
  ipcMain.handle(IPC.getLogs, () => manager.logs());

  ipcMain.handle(IPC.retry, async () => {
    const state = await manager.restart();
    if (state.phase === "ready" && state.url) onReady(state.url);
    return state;
  });

  ipcMain.handle(IPC.openLogFile, async () => {
    const result = await shell.openPath(logFilePath());
    if (result) manager.log(`[shell] 打开日志失败：${result}`);
  });

  ipcMain.handle(IPC.openDataFolder, async () => {
    await shell.openPath(dataDir());
  });

  ipcMain.handle(IPC.quit, () => {
    app.quit();
  });

  manager.onState((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.stateEvent, state);
    }
  });

  manager.onLog((line) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.logEvent, line);
    }
  });
}

/**
 * 页签相关 IPC：页签栏 UI ↔ TabManager。
 * 用 provider 而不是直接传实例，方便窗口重建 / 多窗口时复用同一组 handler。
 */
export function registerTabIpc(
  provider: () => TabManager | null,
  openSettings: () => void,
): void {
  const withTabs = <T>(fn: (tabs: TabManager) => T): T | null => {
    const tabs = provider();
    return tabs ? fn(tabs) : null;
  };

  ipcMain.handle(TAB_IPC.list, () => withTabs((tabs) => tabs.snapshot()));
  ipcMain.handle(TAB_IPC.open, (_event, path?: string) => withTabs((tabs) => tabs.createTab(path)));
  ipcMain.handle(TAB_IPC.close, (_event, id: string) => withTabs((tabs) => tabs.closeTab(id)));
  ipcMain.handle(TAB_IPC.activate, (_event, id: string) => withTabs((tabs) => tabs.activate(id)));
  ipcMain.handle(TAB_IPC.move, (_event, id: string, index: number) =>
    withTabs((tabs) => tabs.move(id, index)),
  );
  ipcMain.handle(TAB_IPC.setPinned, (_event, id: string, pinned: boolean) =>
    withTabs((tabs) => tabs.setPinned(id, pinned)),
  );
  ipcMain.handle(TAB_IPC.showMenu, (_event, id: string, x: number, y: number) =>
    withTabs((tabs) => tabs.showMenu(id, x, y)),
  );
  ipcMain.handle(TAB_IPC.openSettings, () => {
    openSettings();
  });

  /* ---- 分屏 ---- */
  ipcMain.handle(TAB_IPC.setSplit, (_event, preset: SplitPreset) =>
    withTabs((tabs) => tabs.setSplitPreset(preset)),
  );
  ipcMain.handle(TAB_IPC.splitWith, (_event, id: string, orientation?: "columns" | "rows") =>
    withTabs((tabs) => tabs.splitWithTab(id, orientation)),
  );
  ipcMain.handle(TAB_IPC.focusGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.focusGroup(index)),
  );
  ipcMain.handle(TAB_IPC.closeGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.closeGroup(index)),
  );
  ipcMain.handle(TAB_IPC.newTabInGroup, (_event, index: number) =>
    withTabs((tabs) => tabs.newTabInGroup(index)),
  );
  ipcMain.handle(TAB_IPC.moveTabToGroup, (_event, id: string, groupIndex: number, insertIndex?: number) =>
    withTabs((tabs) => tabs.moveTabToGroup(id, groupIndex, insertIndex)),
  );
  ipcMain.handle(TAB_IPC.splitTabToEdge, (_event, id: string, side: "left" | "right") =>
    withTabs((tabs) => tabs.splitTabToEdge(id, side)),
  );
  ipcMain.handle(TAB_IPC.beginTabDrag, () => withTabs((tabs) => tabs.beginTabDrag()));
  ipcMain.handle(TAB_IPC.endTabDrag, () => withTabs((tabs) => tabs.endTabDrag()));
  ipcMain.handle(TAB_IPC.showSplitMenu, (_event, x: number, y: number) =>
    withTabs((tabs) => tabs.showSplitMenu(x, y)),
  );
  ipcMain.handle(TAB_IPC.showGroupMenu, (_event, index: number, x: number, y: number) =>
    withTabs((tabs) => tabs.showGroupMenu(index, x, y)),
  );
}
