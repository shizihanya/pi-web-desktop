import { contextBridge, ipcRenderer } from "electron";
import type { ServerState, ShellApi, TabbarApi, TabsSnapshot } from "../shared/types";

// 注意：sandbox 模式下的 preload 不能 require 共享 chunk，
// 所以这里内联通道名，必须与 src/shared/types.ts 里的 IPC / TAB_IPC 保持一致。
const CH = {
  list: "tabs:list",
  open: "tabs:open",
  close: "tabs:close",
  activate: "tabs:activate",
  move: "tabs:move",
  setPinned: "tabs:set-pinned",
  showMenu: "tabs:menu",
  reloadCrashed: "tabs:reload-crashed",
  openSettings: "tabs:open-settings",
  changedEvent: "tabs:changed",
  setSplit: "tabs:set-split",
  splitWith: "tabs:split-with",
  focusGroup: "tabs:focus-group",
  closeGroup: "tabs:close-group",
  newTabInGroup: "tabs:new-tab-in-group",
  moveTabToGroup: "tabs:move-tab-to-group",
  splitTabToEdge: "tabs:split-tab-to-edge",
  beginTabDrag: "tabs:begin-tab-drag",
  endTabDrag: "tabs:end-tab-drag",
  showSplitMenu: "tabs:split-menu",
  showGroupMenu: "tabs:group-menu",
  serverState: "shell:get-state",
  stateEvent: "shell:state",
} as const;

// 启动页现在是主窗口的第一屏，与页签栏共用这个 preload。
// 同样内联通道名（sandbox 模式不能 require 共享 chunk）。
const SHELL_CH = {
  getState: "shell:get-state",
  getLogs: "shell:get-logs",
  retry: "shell:retry",
  openLogFile: "shell:open-log",
  openDataFolder: "shell:open-data-folder",
  quit: "shell:quit",
  stateEvent: "shell:state",
  logEvent: "shell:log",
} as const;

const shellApi: ShellApi = {
  getState: () => ipcRenderer.invoke(SHELL_CH.getState) as Promise<ServerState>,
  getLogs: () => ipcRenderer.invoke(SHELL_CH.getLogs) as Promise<string[]>,
  retry: () => ipcRenderer.invoke(SHELL_CH.retry) as Promise<ServerState>,
  openLogFile: () => ipcRenderer.invoke(SHELL_CH.openLogFile) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke(SHELL_CH.openDataFolder) as Promise<void>,
  quit: () => ipcRenderer.invoke(SHELL_CH.quit) as Promise<void>,
  onState: (cb) => {
    const handler = (_event: unknown, state: ServerState) => cb(state);
    ipcRenderer.on(SHELL_CH.stateEvent, handler);
    return () => ipcRenderer.off(SHELL_CH.stateEvent, handler);
  },
  onLog: (cb) => {
    const handler = (_event: unknown, line: string) => cb(line);
    ipcRenderer.on(SHELL_CH.logEvent, handler);
    return () => ipcRenderer.off(SHELL_CH.logEvent, handler);
  },
};

const api: TabbarApi = {
  list: () => ipcRenderer.invoke(CH.list) as Promise<TabsSnapshot>,
  open: (path?: string) => ipcRenderer.invoke(CH.open, path) as Promise<void>,
  close: (id: string) => ipcRenderer.invoke(CH.close, id) as Promise<void>,
  activate: (id: string) => ipcRenderer.invoke(CH.activate, id) as Promise<void>,
  move: (id: string, index: number) => ipcRenderer.invoke(CH.move, id, index) as Promise<void>,
  setPinned: (id: string, pinned: boolean) =>
    ipcRenderer.invoke(CH.setPinned, id, pinned) as Promise<void>,
  showMenu: (id: string, x: number, y: number) =>
    ipcRenderer.invoke(CH.showMenu, id, x, y) as Promise<void>,
  reloadCrashed: (id: string) => ipcRenderer.invoke(CH.reloadCrashed, id) as Promise<boolean>,
  openSettings: () => ipcRenderer.invoke(CH.openSettings) as Promise<void>,
  setSplit: (preset) => ipcRenderer.invoke(CH.setSplit, preset) as Promise<void>,
  splitWith: (id, orientation) =>
    ipcRenderer.invoke(CH.splitWith, id, orientation) as Promise<void>,
  focusGroup: (index) => ipcRenderer.invoke(CH.focusGroup, index) as Promise<void>,
  closeGroup: (index) => ipcRenderer.invoke(CH.closeGroup, index) as Promise<void>,
  newTabInGroup: (index) => ipcRenderer.invoke(CH.newTabInGroup, index) as Promise<void>,
  moveTabToGroup: (id, groupIndex, insertIndex) =>
    ipcRenderer.invoke(CH.moveTabToGroup, id, groupIndex, insertIndex) as Promise<void>,
  splitTabToEdge: (id, side) =>
    ipcRenderer.invoke(CH.splitTabToEdge, id, side) as Promise<void>,
  beginTabDrag: () => ipcRenderer.invoke(CH.beginTabDrag) as Promise<void>,
  endTabDrag: () => ipcRenderer.invoke(CH.endTabDrag) as Promise<void>,
  showSplitMenu: (x, y) => ipcRenderer.invoke(CH.showSplitMenu, x, y) as Promise<void>,
  showGroupMenu: (index, x, y) =>
    ipcRenderer.invoke(CH.showGroupMenu, index, x, y) as Promise<void>,
  onTabs: (cb) => {
    const handler = (_event: unknown, snapshot: TabsSnapshot) => cb(snapshot);
    ipcRenderer.on(CH.changedEvent, handler);
    return () => ipcRenderer.off(CH.changedEvent, handler);
  },
  getServerState: () => ipcRenderer.invoke(CH.serverState) as Promise<ServerState>,
  onServerState: (cb) => {
    const handler = (_event: unknown, state: ServerState) => cb(state);
    ipcRenderer.on(CH.stateEvent, handler);
    return () => ipcRenderer.off(CH.stateEvent, handler);
  },
};

contextBridge.exposeInMainWorld("piWebTabs", api);
contextBridge.exposeInMainWorld("piWebShell", shellApi);
