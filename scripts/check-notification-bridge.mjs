#!/usr/bin/env node
/**
 * NotificationBridge 的编排回归：mock WebContents，不启动 Electron。
 * 覆盖：幂等安装、重载后重装、窗口聚焦/失焦同步、增强关闭、非 Windows、
 *       detach/dispose 清理、注入失败降级。
 *
 *   npm run check:notification-bridge
 */
import { NotificationBridge } from "../src/main/tabs/notification-bridge.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const okResult = {
  hasNotification: true,
  hasDocumentHasFocus: true,
  hasServiceWorkerRegistration: true,
  focusPatchInstalled: true,
  swPatchInstalled: true,
  notificationWrapped: true,
  error: null,
};

function makeWC(options = {}) {
  const listeners = new Map();
  return {
    destroyed: false,
    fail: options.fail ?? false,
    scripts: [],
    response: options.response ?? (() => JSON.stringify(okResult)),
    isDestroyed() {
      return this.destroyed;
    },
    async executeJavaScript(code) {
      this.scripts.push(code);
      if (this.fail) throw new Error("injection failed");
      return this.response(code);
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    off(event, listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== listener));
      return this;
    },
    emit(event) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn();
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

function makeBridge(wcs, overrides = {}) {
  const verdicts = [];
  const debug = [];
  const bridge = new NotificationBridge({
    enabled: true,
    checkOnlyWhenDisabled: true,
    contents: () => wcs,
    focusState: () => true,
    onVerdict: (v) => verdicts.push(v),
    onDebug: (m) => debug.push(m),
    ...overrides,
  });
  return { bridge, verdicts, debug };
}

// 两个脚本都会提到 __piDesktopNotificationWrapped，用 class 定义区分补丁与只读检测
const isPatch = (code) => code.includes("class PiDesktopNotification");
const isCompatOnly = (code) => code.includes("hasServiceWorkerRegistration") && !isPatch(code);
const isFocusScript = (code) => code.includes("__piDesktopWindowFocused =");

/* ------------------------- 安装 / 幂等 / 重载 ------------------------- */
{
  const wcs = [makeWC(), makeWC(), makeWC()];
  const { bridge, verdicts } = makeBridge(wcs);
  bridge.attach(wcs[0]);
  bridge.attach(wcs[0]);
  check("重复 attach 不重复绑定 dom-ready", wcs[0].listenerCount("dom-ready") === 1, String(wcs[0].listenerCount("dom-ready")));
  wcs[0].emit("dom-ready");
  await new Promise((r) => setTimeout(r, 5));
  check("dom-ready 注入通知补丁", wcs[0].scripts.filter(isPatch).length === 1);
  check("注入结果回传 compatible", verdicts.at(-1)?.level === "compatible", JSON.stringify(verdicts.at(-1)));
  check(
    "dom-ready 后同步窗口焦点到所有页签 realm",
    wcs.every((wc) => wc.scripts.some(isFocusScript)),
    wcs.map((wc) => wc.scripts.filter(isFocusScript).length).join(","),
  );
  // 页面 realm 重建：did-finish-load 再装一次（脚本自身幂等，已在 check:notification 验证）
  wcs[0].emit("did-finish-load");
  await new Promise((r) => setTimeout(r, 5));
  check("页面重新加载后重新安装（did-finish-load 也绑定）", wcs[0].scripts.filter(isPatch).length === 2);
}
{
  const wcs = [makeWC(), makeWC()];
  const { bridge } = makeBridge(wcs, { focusState: () => false });
  bridge.attach(wcs[0]);
  bridge.syncFocus(wcs, false);
  check(
    "窗口失焦同步为 false",
    wcs.every((wc) => wc.scripts.some((c) => c.includes("__piDesktopWindowFocused = false"))),
  );
  bridge.syncFocus(wcs, true);
  check(
    "窗口聚焦同步为 true",
    wcs.every((wc) => wc.scripts.some((c) => c.includes("__piDesktopWindowFocused = true"))),
  );
}

/* ------------------------- 关闭 / 非 Windows / 清理 ------------------------- */
{
  const wc = makeWC();
  const { bridge, verdicts } = makeBridge([wc], { enabled: false, checkOnlyWhenDisabled: true });
  bridge.attach(wc);
  wc.emit("dom-ready");
  await new Promise((r) => setTimeout(r, 5));
  check(
    "增强关闭：只做只读契约检测，不打补丁",
    wc.scripts.some(isCompatOnly) && !wc.scripts.some(isPatch),
  );
  check("增强关闭：结论 disabled", verdicts.at(-1)?.level === "disabled", JSON.stringify(verdicts.at(-1)));
  check("增强关闭：不绑定 did-finish-load", wc.listenerCount("did-finish-load") === 0);
}
{
  const wc = makeWC();
  const { bridge } = makeBridge([wc], { enabled: false, checkOnlyWhenDisabled: false });
  bridge.attach(wc);
  check("非 Windows：不绑定任何监听、不注入", wc.listenerCount("dom-ready") === 0 && wc.scripts.length === 0);
}
{
  const wcs = [makeWC(), makeWC()];
  const { bridge } = makeBridge(wcs);
  for (const wc of wcs) bridge.attach(wc);
  bridge.detach(wcs[0]);
  check("detach 移除该页签的监听", wcs[0].listenerCount("dom-ready") === 0);
  wcs[0].emit("dom-ready");
  await new Promise((r) => setTimeout(r, 5));
  check("detach 后不再注入", wcs[0].scripts.length === 0);
  bridge.dispose();
  check("dispose 清理全部监听", wcs.every((wc) => wc.listenerCount("dom-ready") === 0));
}
{
  const wc = makeWC({ fail: true });
  const { bridge, verdicts } = makeBridge([wc]);
  bridge.attach(wc);
  wc.emit("dom-ready");
  await new Promise((r) => setTimeout(r, 5));
  check(
    "注入失败：记录 disabled 诊断，不抛出、不影响 pi-web 原生通知",
    verdicts.at(-1)?.level === "disabled" && verdicts.at(-1).reason.includes("注入失败"),
    JSON.stringify(verdicts.at(-1)),
  );
}

if (failed) process.exit(1);
console.log("NotificationBridge 检查通过");
