import { randomUUID } from "node:crypto";
import { ipcMain, Notification, type WebContents } from "electron";
import { NOTIFICATION_IPC } from "../../shared/types";
import { createNotificationLifecycle } from "./notification-lifecycle";

export interface NotificationHostDeps {
  isNotificationSender(wc: object): boolean;
  findTabIdBySender(sender: WebContents): string | null;
  isTabAlive(tabId: string): boolean;
  showWindow(): void;
  activateTab(tabId: string): void;
  log?(message: string): void;
}

/** Windows 下由主进程创建唯一 Toast，并通过 launch 参数接收历史通知激活。 */
export function installNotificationHost(deps: NotificationHostDeps): void {
  if (process.platform !== "win32") return;

  const lifecycle = createNotificationLifecycle<Notification>({
    createId: () => randomUUID(),
    createNotification: (options) => new Notification(options),
    isSenderValid: (sender) => deps.isNotificationSender(sender),
    findTabIdBySender: (sender) => deps.findTabIdBySender(sender as WebContents),
    isTabAlive: (tabId) => deps.isTabAlive(tabId),
    showWindow: () => deps.showWindow(),
    activateTab: (tabId) => deps.activateTab(tabId),
    sendActivated: (sender, id) => {
      const webContents = sender as WebContents;
      if (!webContents.isDestroyed()) {
        webContents.send(NOTIFICATION_IPC.activatedEvent, { id });
      }
    },
    log: deps.log,
  });

  // sendSync 的回复值只能赋值一次：Electron 在 event.returnValue 首次赋值时就发出同步回复，
  // 先置 null 再覆写会让渲染层拿到 null，误判桥失败而回落 Chromium 通知（每次完成弹两条 toast）。
  ipcMain.on(NOTIFICATION_IPC.create, (event, rawPayload: unknown) => {
    const reply =
      event.sender.isDestroyed() ? null : lifecycle.create(event.sender, rawPayload);
    event.returnValue = reply;
  });

  ipcMain.on(NOTIFICATION_IPC.close, (event, id: unknown) => {
    if (event.sender.isDestroyed()) return;
    lifecycle.close(event.sender, id);
  });

  try {
    Notification.handleActivation((details) => lifecycle.handleActivation(details.arguments));
    deps.log?.("[notify] handleActivation 已注册");
  } catch (error) {
    deps.log?.(`[notify] handleActivation 注册失败: ${String(error)}`);
  }
}
