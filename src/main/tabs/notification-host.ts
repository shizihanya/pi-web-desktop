import { randomUUID } from "node:crypto";
import { ipcMain, Notification, type WebContents } from "electron";
import { NOTIFICATION_IPC } from "../../shared/types";
import {
  buildNotificationToastXml,
  parseNotificationLaunchArguments,
  sanitizeNotificationTag,
  type NotificationToastPayload,
} from "./notification-toast";

export interface NotificationHostDeps {
  isNotificationSender(wc: object): boolean;
  findTabIdBySender(sender: WebContents): string | null;
  isTabAlive(tabId: string): boolean;
  showWindow(): void;
  activateTab(tabId: string): void;
  log?(message: string): void;
}

interface NotificationRecord {
  id: string;
  tag: string;
  sender: WebContents;
  tabId: string | null;
  notification: Notification;
  activated: boolean;
  closed: boolean;
}

function readPayload(raw: unknown): NotificationToastPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string" || !value.title.trim()) return null;
  return {
    title: value.title,
    body: typeof value.body === "string" ? value.body : "",
    tag: typeof value.tag === "string" ? value.tag : "",
    silent: value.silent === true,
  };
}

/**
 * Windows 下由主进程创建唯一一条 Toast，并通过 launch 参数接收历史通知激活。
 * 登记数据全部来自主进程校验过的 IPC sender，不使用 Renderer 提交的 Tab ID。
 */
export function installNotificationHost(deps: NotificationHostDeps): void {
  if (process.platform !== "win32") return;
  const records = new Map<string, NotificationRecord>();
  const tagIds = new Map<string, string>();
  const debug = (message: string): void => deps.log?.(`[notify] ${message}`);

  const removeRecord = (id: string, closeToast = false): void => {
    const record = records.get(id);
    if (!record) return;
    records.delete(id);
    if (tagIds.get(record.tag) === id) tagIds.delete(record.tag);
    if (!closeToast || record.closed) return;
    record.closed = true;
    try {
      record.notification.close();
    } catch (error) {
      debug(`关闭 toast 失败 ${id}: ${String(error)}`);
    }
  };

  const activateRecord = (id: string): void => {
    const record = records.get(id);
    if (!record || record.activated) return;
    record.activated = true;

    if (process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
      debug(`toast 激活 ${id} tab=${record.tabId ?? "none"}`);
    }

    deps.showWindow();

    if (record.tabId && deps.isTabAlive(record.tabId)) {
      deps.activateTab(record.tabId);
    }

    if (!record.sender.isDestroyed()) {
      record.sender.send(NOTIFICATION_IPC.activatedEvent, { id });
    }

    removeRecord(id, true);
  };

  ipcMain.on(NOTIFICATION_IPC.create, (event, rawPayload: unknown) => {
    event.returnValue = null;
    if (event.sender.isDestroyed() || !deps.isNotificationSender(event.sender)) return;

    const payload = readPayload(rawPayload);
    if (!payload) return;

    const id = randomUUID();
    const sender = event.sender;
    const tabId = deps.findTabIdBySender(sender);
    const tag = sanitizeNotificationTag(payload.tag, id);
    const previousId = tagIds.get(tag);
    if (previousId) removeRecord(previousId, true);
    const notification = new Notification({
      toastXml: buildNotificationToastXml(payload, id),
      id: tag,
    });

    const record: NotificationRecord = {
      id,
      tag,
      sender,
      tabId,
      notification,
      activated: false,
      closed: false,
    };
    records.set(id, record);
    tagIds.set(tag, id);

    notification.on("click", () => activateRecord(id));
    notification.on("close", (details: { reason?: string }) => {
      // Windows 通知超时进入 Action Center 时也会发 close；此时必须保留登记，
      // 否则历史通知点击无法按 launch 中的 nid 找到来源 Tab。
      if (details?.reason === "timedOut") return;
      removeRecord(id);
    });
    notification.on("failed", (error: unknown) => {
      debug(`toast 失败 ${id}: ${String(error)}`);
      removeRecord(id);
    });
    notification.show();

    if (process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
      debug(`toast 创建 ${id} tab=${tabId ?? "none"}`);
    }
    event.returnValue = id;
  });

  ipcMain.on(NOTIFICATION_IPC.close, (event, id: unknown) => {
    if (typeof id !== "string") return;
    const record = records.get(id);
    if (!record || record.sender !== event.sender) return;
    removeRecord(id, true);
  });

  try {
    Notification.handleActivation((details) => {
      const id = parseNotificationLaunchArguments(details.arguments);
      if (id) activateRecord(id);
    });
    debug("handleActivation 已注册");
  } catch (error) {
    debug(`handleActivation 注册失败: ${String(error)}`);
  }
}
