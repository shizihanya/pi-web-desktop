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

  ipcMain.on(NOTIFICATION_IPC.create, (event, rawPayload: unknown) => {
    event.returnValue = null;
    if (event.sender.isDestroyed()) return;
    event.returnValue = lifecycle.create(event.sender, rawPayload);
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
