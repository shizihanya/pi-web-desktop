import { contextBridge, ipcRenderer } from "electron";
import type { NotificationClickApi } from "../shared/types";

// 只给 pi-web 的 WebContentsView 暴露通知能力。
// sandbox 模式下 preload 不能 require 共享 chunk，因此通道名内联，
// 必须与 src/shared/types.ts 的 NOTIFICATION_IPC 保持一致。
const CH = {
  clicked: "notification:clicked",
  create: "notification:create",
  close: "notification:close",
  activatedEvent: "notification:activated",
} as const;

const api: NotificationClickApi = {
  clicked: () => {
    ipcRenderer.send(CH.clicked);
  },
  create: (payload) => {
    const id = ipcRenderer.sendSync(CH.create, payload);
    return typeof id === "string" ? id : null;
  },
  close: (id) => {
    ipcRenderer.send(CH.close, id);
  },
  onActivated: (cb) => {
    const handler = (_event: unknown, payload: { id: string }) => cb(payload);
    ipcRenderer.on(CH.activatedEvent, handler);
    return () => ipcRenderer.off(CH.activatedEvent, handler);
  },
};

contextBridge.exposeInMainWorld("__piDesktopNotificationBridge", api);
