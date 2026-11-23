/**
 * NotificationBridge（第三 / 四阶段：把通知增强的安装与焦点同步从 TabManager 抽出）。
 *
 * 职责：
 *  - 只在 Windows 启用通知补丁，dom-ready / did-finish-load 都补装（脚本自身幂等）；
 *  - 注入结果回传 compat，上游改通知实现时优先降级，不强行改写；
 *  - 把 BrowserWindow 焦点同步给所有页面 realm 的 __piDesktopWindowFocused；
 *  - detach / dispose 移除监听，避免页签关闭或 TabManager 重建后重复绑定。
 *
 * 不修改 pi-web 文件，不覆盖通知以外的 Web API；注入失败只写诊断。
 * 本模块只用结构接口描述 WebContents，可在 Node 里用 mock 回归。
 */

import {
  NOTIFICATION_COMPAT_SCRIPT,
  WINDOWS_NOTIFICATION_PATCH,
  type NotificationPatchResult,
} from "./notification-patch.ts";
import { evaluateNotificationPatch, type CompatVerdict } from "./compat.ts";

const notificationClickSenders = new WeakSet<object>();

/** 标记由 TabManager 创建、装了通知点击 preload 的 WebContents */
export function markNotificationClickSender(wc: object): void {
  notificationClickSenders.add(wc);
}

/** 通知点击 IPC 只接受这些 WebContents，避免其它渲染层伪装来源 */
export function isNotificationClickSender(wc: object): boolean {
  return notificationClickSenders.has(wc);
}

export interface NotificationTabLookup {
  allDraftContexts(): Array<{ tabId: string }>;
  draftContents(tabId: string): object | null;
}

/** 只按 IPC sender 反查 Tab，不接收 Renderer 传入的任意 Tab ID */
export function findNotificationSenderTabId(
  lookup: NotificationTabLookup,
  sender: object,
): string | null {
  return lookup.allDraftContexts().find((context) => lookup.draftContents(context.tabId) === sender)
    ?.tabId ?? null;
}

/** WebContents 的最小结构面（Electron 的 WebContents 天然满足） */
export interface NotifiableContents {
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface NotificationBridgeOptions {
  /** win32 且未被环境变量关闭 */
  enabled: boolean;
  /** 增强关闭时是否仍做只读契约检测（Windows 上才有意义） */
  checkOnlyWhenDisabled: boolean;
  /** 当前所有页签，用于注入后同步窗口焦点 */
  contents(): NotifiableContents[];
  focusState(): boolean;
  onVerdict(verdict: CompatVerdict): void;
  onDebug?(message: string): void;
}

function parsePatchResult(raw: unknown): NotificationPatchResult | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as NotificationPatchResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export class NotificationBridge {
  private readonly attached = new Map<NotifiableContents, () => void>();
  private readonly options: NotificationBridgeOptions;

  constructor(options: NotificationBridgeOptions) {
    this.options = options;
  }

  /** 给新页签安装增强；重复调用不会重复绑定 */
  attach(wc: NotifiableContents): void {
    if (this.attached.has(wc)) return;
    const enabled = this.options.enabled;
    if (!enabled && !this.options.checkOnlyWhenDisabled) return;

    let debugLogged = false;
    const handler = (): void => {
      if (wc.isDestroyed()) return;
      const script = enabled ? WINDOWS_NOTIFICATION_PATCH : NOTIFICATION_COMPAT_SCRIPT;
      void wc
        .executeJavaScript(script, true)
        .then((raw: unknown) =>
          this.options.onVerdict(
            evaluateNotificationPatch(parsePatchResult(raw), { enabled }),
          ),
        )
        .catch((error: unknown) => {
          this.options.onVerdict({
            level: "disabled",
            reason: `通知补丁注入失败（不影响 pi-web 原生通知）：${String(error)}`,
          });
        });
      if (enabled) {
        this.syncFocus(this.options.contents(), this.options.focusState());
        if (!debugLogged && process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
          debugLogged = true;
          this.options.onDebug?.("[notify] 已注入通知回落 + 窗口焦点同步补丁");
        }
      }
    };

    wc.on("dom-ready", handler);
    if (enabled) wc.on("did-finish-load", handler);
    this.attached.set(wc, handler);
  }

  detach(wc: NotifiableContents): void {
    const handler = this.attached.get(wc);
    if (!handler) return;
    try {
      wc.off("dom-ready", handler);
      wc.off("did-finish-load", handler);
    } catch {
      // WebContents 可能已经销毁
    }
    this.attached.delete(wc);
  }

  /** 把主窗口焦点状态同步给所有页面 realm */
  syncFocus(contents: NotifiableContents[], focused: boolean): void {
    const script = `window.__piDesktopWindowFocused = ${focused ? "true" : "false"};`;
    for (const wc of contents) {
      if (wc.isDestroyed()) continue;
      void wc.executeJavaScript(script, true).catch(() => {});
    }
    if (process.env.PI_WEB_DESKTOP_DEBUG_NOTIFY) {
      this.options.onDebug?.(`[notify] 窗口焦点同步：${focused ? "focused" : "blurred"}`);
    }
  }

  dispose(): void {
    for (const wc of [...this.attached.keys()]) this.detach(wc);
  }
}
