import { createHash } from "node:crypto";
import {
  buildNotificationToastXml,
  parseNotificationLaunchArguments,
  type NotificationToastPayload,
} from "./notification-toast.ts";

export interface ToastNotificationLike {
  on(event: "click", listener: () => void): unknown;
  on(event: "close", listener: (details: { reason?: string }) => void): unknown;
  on(event: "failed", listener: (error: unknown) => void): unknown;
  show(): void;
  close(): void;
}

export interface NotificationLifecycleDeps<TNotification extends ToastNotificationLike> {
  createId(): string;
  createNotification(options: { toastXml: string; id: string }): TNotification;
  isSenderValid(sender: object): boolean;
  findTabIdBySender(sender: object): string | null;
  isTabAlive(tabId: string): boolean;
  showWindow(): void;
  activateTab(tabId: string): void;
  sendActivated(sender: object, id: string): void;
  log?(message: string): void;
}

interface NotificationRecord<TNotification extends ToastNotificationLike> {
  id: string;
  /** 原始业务 tag；空字符串表示无 tag */
  tagKey: string;
  sender: object;
  tabId: string | null;
  notification: TNotification;
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

/** 无业务 tag 的通知使用主进程生成的独立 Toast 身份。 */
export function notificationIdentity(notificationId: string): string {
  return notificationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || "piwebnotification";
}

/**
 * 同业务 tag 使用稳定 Toast 身份。
 * 使用原始 tag 的 SHA-256，避免特殊字符、超长 tag 或清洗后碰撞导致不同业务错误合并。
 */
export function stableNotificationIdentity(rawTag: string): string {
  return createHash("sha256").update(rawTag, "utf8").digest("hex");
}

/**
 * 每条通知由自己的 notificationId 管理；同业务 tag 只保留最新记录。
 * tag 使用原始字符串映射，Toast 身份使用稳定哈希，避免清洗碰撞。
 */
export function createNotificationLifecycle<TNotification extends ToastNotificationLike>(
  deps: NotificationLifecycleDeps<TNotification>,
) {
  const records = new Map<string, NotificationRecord<TNotification>>();
  const tagIds = new Map<string, string>();
  const debug = (message: string): void => deps.log?.(`[notify] ${message}`);

  const removeRecord = (id: string, closeToast = false): void => {
    const record = records.get(id);
    if (!record) return;
    records.delete(id);
    if (record.tagKey && tagIds.get(record.tagKey) === id) {
      tagIds.delete(record.tagKey);
    }
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
    deps.sendActivated(record.sender, id);

    removeRecord(id, true);
  };

  const create = (sender: object, rawPayload: unknown): string | null => {
    if (!deps.isSenderValid(sender)) return null;
    const payload = readPayload(rawPayload);
    if (!payload) return null;

    const id = deps.createId();
    const tabId = deps.findTabIdBySender(sender);
    const tagKey = payload.tag;
    const previousId = tagKey ? tagIds.get(tagKey) ?? null : null;
    // 同 tag 替换旧记录，但不主动 close 旧 Notification 对象：
    // 新旧对象共享稳定 Toast 身份，close 旧对象可能误关闭新 Toast。
    if (previousId) removeRecord(previousId, false);

    const toastXml = buildNotificationToastXml(payload, id);
    const notification = deps.createNotification({
      toastXml,
      id: tagKey ? stableNotificationIdentity(tagKey) : notificationIdentity(id),
    });

    const record: NotificationRecord<TNotification> = {
      id,
      tagKey,
      sender,
      tabId,
      notification,
      activated: false,
      closed: false,
    };
    records.set(id, record);
    if (tagKey) tagIds.set(tagKey, id);

    notification.on("click", () => activateRecord(id));
    notification.on("close", (details) => {
      // Windows 通知超时进入 Action Center 时也会发 close；此时必须保留登记。
      if (details?.reason === "timedOut") return;
      removeRecord(id);
    });
    notification.on("failed", (error) => {
      debug(`toast 失败 ${id}: ${String(error)}`);
      removeRecord(id);
    });
    notification.show();

    if (process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
      debug(`toast 创建 ${id} tab=${tabId ?? "none"}`);
    }
    return id;
  };

  const close = (sender: object, id: unknown): void => {
    if (typeof id !== "string") return;
    const record = records.get(id);
    if (!record || record.sender !== sender) return;
    removeRecord(id, true);
  };

  const handleActivation = (argumentsText: unknown): void => {
    const id = parseNotificationLaunchArguments(argumentsText);
    if (id) activateRecord(id);
  };

  return {
    create,
    close,
    activate: activateRecord,
    handleActivation,
    has(id: string): boolean {
      return records.has(id);
    },
    get size(): number {
      return records.size;
    },
  };
}
