/**
 * Windows 通知兼容补丁（只在 Windows 启用，可独立关闭）。
 *
 * pi-web 的任务完成通知优先走 ServiceWorkerRegistration.showNotification()，
 * 实测 Electron/Windows 上这条路径会 resolve 但根本没有 toast；而 pi-web 一旦成功就直接
 * 返回 "service-worker"，不再回落 new Notification()。另外 WebContentsView 在主窗口失焦后
 * 仍报告 document.hasFocus() === true，会让 pi-web 判定「页面仍在前台」而不发通知。
 *
 * 补丁只做三件事，不碰其它 Web API、不改 pi-web 文件：
 *  1. 让 SW showNotification reject，回落到 window.Notification；
 *  2. 用 __piDesktopWindowFocused 把 BrowserWindow 焦点同步给 document.hasFocus()；
 *  3. 包装 Notification 构造器，把页签名（会话/项目名）拼进通知标题。
 *
 * 幂等：dom-ready / did-finish-load 各执行一次；页面 realm 重建后自动重新安装。
 * 注入脚本返回 JSON 诊断，交给 compat.ts 做 notificationCompatible 判定；
 * 上游改了通知实现时优先降级（保留原生），而不是强行改写新的实现。
 */

export interface NotificationPatchResult {
  hasNotification: boolean;
  hasDocumentHasFocus: boolean;
  hasServiceWorkerRegistration: boolean;
  focusPatchInstalled: boolean;
  swPatchInstalled: boolean;
  notificationWrapped: boolean;
  error: string | null;
}

export const WINDOWS_NOTIFICATION_PATCH = String.raw`(() => {
  var result = {
    hasNotification: false,
    hasDocumentHasFocus: false,
    hasServiceWorkerRegistration: false,
    focusPatchInstalled: false,
    swPatchInstalled: false,
    notificationWrapped: false,
    error: null
  };
  try {
    result.hasNotification = typeof window.Notification === "function";
    result.hasDocumentHasFocus = typeof document.hasFocus === "function";
    var proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    result.hasServiceWorkerRegistration = !!proto;

    if (window.__piDesktopWindowFocused === undefined) {
      window.__piDesktopWindowFocused = true;
    }
    if (!document.__piDesktopHasFocusPatch && result.hasDocumentHasFocus) {
      var original = document.hasFocus.bind(document);
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        writable: true,
        value: function () {
          return window.__piDesktopWindowFocused === false ? false : original();
        }
      });
      Object.defineProperty(document, "__piDesktopHasFocusPatch", { value: true });
    }
    result.focusPatchInstalled = !!document.__piDesktopHasFocusPatch;

    if (proto && !proto.__piDesktopNotificationPatch) {
      proto.showNotification = function () {
        return Promise.reject(new Error("pi-web-desktop: force window.Notification fallback"));
      };
      Object.defineProperty(proto, "__piDesktopNotificationPatch", { value: true });
    }
    result.swPatchInstalled = !!(proto && proto.__piDesktopNotificationPatch);

    var OriginalNotification = window.Notification;
    if (OriginalNotification && !window.__piDesktopNotificationWrapped) {
      var tabTitle = function () {
        try {
          return (document.title || "").replace(/\s*[-\u2013\u2014]\s*Pi\s*Web\s*$/i, "").trim();
        } catch (e) { return ""; }
      };
      class PiDesktopNotification extends OriginalNotification {
        constructor(title, options) {
          var finalTitle = typeof title === "string" ? title : "";
          try {
            var tab = tabTitle();
            if (tab && finalTitle && finalTitle.indexOf(tab) === -1) {
              finalTitle = tab + " — " + finalTitle;
            } else if (tab && !finalTitle) {
              finalTitle = tab;
            }
          } catch (e) {}
          super(finalTitle, options);
        }
      }
      window.Notification = PiDesktopNotification;
      Object.defineProperty(window, "__piDesktopNotificationWrapped", { value: true });
    }
    result.notificationWrapped = !!window.__piDesktopNotificationWrapped;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }
  return JSON.stringify(result);
})()`;

/** 只检测 Web API 形状，不打补丁（用于「通知增强关闭」时也能给出兼容性结论） */
export const NOTIFICATION_COMPAT_SCRIPT = String.raw`(() => {
  try {
    var proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    return JSON.stringify({
      hasNotification: typeof window.Notification === "function",
      hasDocumentHasFocus: typeof document.hasFocus === "function",
      hasServiceWorkerRegistration: !!proto,
      focusPatchInstalled: !!document.__piDesktopHasFocusPatch,
      swPatchInstalled: !!(proto && proto.__piDesktopNotificationPatch),
      notificationWrapped: !!window.__piDesktopNotificationWrapped,
      error: null
    });
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
})()`;
