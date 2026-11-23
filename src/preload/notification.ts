import { contextBridge, ipcRenderer } from "electron";
import type { NotificationClickApi } from "../shared/types";

// 只给 pi-web 的 WebContentsView 暴露通知点击能力。
// sandbox 模式下 preload 不能 require 共享 chunk，因此通道名内联，
// 必须与 src/shared/types.ts 的 NOTIFICATION_IPC 保持一致。
const CH = {
  clicked: "notification:clicked",
} as const;

const api: NotificationClickApi = {
  clicked: () => {
    ipcRenderer.send(CH.clicked);
  },
};

contextBridge.exposeInMainWorld("__piDesktopNotificationBridge", api);
