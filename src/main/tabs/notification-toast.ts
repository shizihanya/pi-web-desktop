export interface NotificationToastPayload {
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

const LAUNCH_PREFIX = "piweb-desktop";

export function clampText(value: unknown, maxLength: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Windows tag 只保留安全字符，避免把上游 tag 直接当作 XML / launch 数据使用。 */
export function sanitizeNotificationTag(tag: unknown, fallback: string): string {
  const raw = typeof tag === "string" ? tag : "";
  const safe = raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
  return safe || fallback.replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || "piwebnotification";
}

export function buildNotificationToastXml(
  payload: NotificationToastPayload,
  notificationId: string,
): string {
  const title = clampText(payload.title, 256, "Pi Web Desktop") || "Pi Web Desktop";
  const body = clampText(payload.body, 1024);
  const launch = `${LAUNCH_PREFIX}&nid=${encodeURIComponent(notificationId)}`;
  const audio = payload.silent ? "<audio silent=\"true\"/>" : "";
  const bodyNode = body ? `<text>${escapeXml(body)}</text>` : "";

  return (
    `<toast launch="${escapeXml(launch)}">` +
    "<visual>" +
    "<binding template=\"ToastGeneric\">" +
    `<text>${escapeXml(title)}</text>` +
    bodyNode +
    "</binding>" +
    "</visual>" +
    audio +
    "</toast>"
  );
}

/** 从 Windows 原始 launch 参数中解析桌面通知 ID；任何异常都返回 null。 */
export function parseNotificationLaunchArguments(argumentsText: unknown): string | null {
  if (typeof argumentsText !== "string" || !argumentsText) return null;
  try {
    const params = new URLSearchParams(argumentsText);
    const id = params.get("nid");
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}
