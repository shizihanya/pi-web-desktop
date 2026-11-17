import { contextBridge, ipcRenderer } from "electron";
import type { ServerState, ShellApi } from "../shared/types";

// 注意：sandbox 模式下的 preload 不能 require 共享 chunk，
// 所以这里内联通道名，必须与 src/shared/types.ts 里的 IPC 保持一致。
const CH = {
  getState: "shell:get-state",
  getLogs: "shell:get-logs",
  retry: "shell:retry",
  openLogFile: "shell:open-log",
  openDataFolder: "shell:open-data-folder",
  quit: "shell:quit",
  stateEvent: "shell:state",
  logEvent: "shell:log",
} as const;

const api: ShellApi = {
  getState: () => ipcRenderer.invoke(CH.getState) as Promise<ServerState>,
  getLogs: () => ipcRenderer.invoke(CH.getLogs) as Promise<string[]>,
  retry: () => ipcRenderer.invoke(CH.retry) as Promise<ServerState>,
  openLogFile: () => ipcRenderer.invoke(CH.openLogFile) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke(CH.openDataFolder) as Promise<void>,
  quit: () => ipcRenderer.invoke(CH.quit) as Promise<void>,
  onState: (cb) => {
    const handler = (_event: unknown, state: ServerState) => cb(state);
    ipcRenderer.on(CH.stateEvent, handler);
    return () => ipcRenderer.off(CH.stateEvent, handler);
  },
  onLog: (cb) => {
    const handler = (_event: unknown, line: string) => cb(line);
    ipcRenderer.on(CH.logEvent, handler);
    return () => ipcRenderer.off(CH.logEvent, handler);
  },
};

contextBridge.exposeInMainWorld("piWebShell", api);
