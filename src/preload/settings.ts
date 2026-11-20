import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  LanAddress,
  PiUpdateProgress,
  PiUpdateResult,
  PiWebUpdateProgress,
  PiWebUpdateResult,
  SaveResult,
  SettingsApi,
  SettingsPatch,
  SettingsView,
} from "../shared/types";

// sandbox preload 不能 require 共享 chunk，通道名内联（与 src/shared/types.ts 一致）
const CH = {
  load: "settings:load",
  save: "settings:save",
  saveAndRestart: "settings:save-restart",
  generatePassword: "settings:generate-password",
  refreshLan: "settings:lan",
  copy: "settings:copy",
  close: "settings:close",
  updatePiWeb: "settings:piweb-update",
  piWebUpdateEvent: "settings:piweb-update-event",
  updatePi: "settings:pi-update",
  piUpdateEvent: "settings:pi-update-event",
} as const;

const api: SettingsApi = {
  load: () => ipcRenderer.invoke(CH.load) as Promise<SettingsView>,
  save: (patch: SettingsPatch) => ipcRenderer.invoke(CH.save, patch) as Promise<SaveResult>,
  saveAndRestart: (patch: SettingsPatch) =>
    ipcRenderer.invoke(CH.saveAndRestart, patch) as Promise<SaveResult>,
  generatePassword: () => ipcRenderer.invoke(CH.generatePassword) as Promise<string>,
  refreshLan: () => ipcRenderer.invoke(CH.refreshLan) as Promise<LanAddress[]>,
  copy: (text: string) => ipcRenderer.invoke(CH.copy, text) as Promise<void>,
  close: () => ipcRenderer.invoke(CH.close) as Promise<void>,
  updatePiWeb: () => ipcRenderer.invoke(CH.updatePiWeb) as Promise<PiWebUpdateResult>,
  onPiWebUpdate: (cb: (progress: PiWebUpdateProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: PiWebUpdateProgress): void => cb(progress);
    ipcRenderer.on(CH.piWebUpdateEvent, listener);
    return () => ipcRenderer.removeListener(CH.piWebUpdateEvent, listener);
  },
  updatePi: () => ipcRenderer.invoke(CH.updatePi) as Promise<PiUpdateResult>,
  onPiUpdate: (cb: (progress: PiUpdateProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: PiUpdateProgress): void => cb(progress);
    ipcRenderer.on(CH.piUpdateEvent, listener);
    return () => ipcRenderer.removeListener(CH.piUpdateEvent, listener);
  },
};

contextBridge.exposeInMainWorld("piWebSettings", api);
