#!/usr/bin/env node
/**
 * Windows 通知补丁的回归检查：不启动 Electron，把注入脚本抽出来在模拟 realm 里跑。
 *
 * 覆盖：窗口聚焦/失焦通知、多页签通知标题、重复注入幂等、页面重新加载后重装、
 *       增强关闭时只做只读检测、上游通知实现变化时不强行改写。
 *
 *   npm run check:notification
 */
import fs from "node:fs";

const src = fs.readFileSync("src/main/tabs/notification-patch.ts", "utf8");
function extract(name) {
  const match = new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`).exec(src);
  if (!match) throw new Error(`${name} 未找到`);
  return match[1];
}
const PATCH = extract("WINDOWS_NOTIFICATION_PATCH");
const COMPAT = extract("NOTIFICATION_COMPAT_SCRIPT");
for (const [name, code] of [
  ["WINDOWS_NOTIFICATION_PATCH", PATCH],
  ["NOTIFICATION_COMPAT_SCRIPT", COMPAT],
]) {
  try {
    new Function(code);
  } catch (error) {
    console.error(`✗ ${name} 脚本语法错误：${error.message}`);
    process.exit(1);
  }
}
console.log("✓ 2 段通知脚本语法正确");

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

/** 一个全新的页面 realm（页面 reload 后就是这么干净） */
function makeRealm({ title = "会话A - Pi Web", withSw = true, withNotification = true } = {}) {
  const created = [];
  class FakeNotification {
    constructor(titleText, options) {
      this.title = titleText;
      this.options = options;
      created.push(this);
    }
  }
  const win = {};
  if (withNotification) win.Notification = FakeNotification;
  if (withSw) {
    win.ServiceWorkerRegistration = {
      prototype: { showNotification: () => Promise.resolve("service-worker") },
    };
  }
  const doc = {
    title,
    hasFocus: () => true,
  };
  globalThis.window = win;
  globalThis.document = doc;
  return { win, doc, created, originalNotification: win.Notification };
}
function apply(code) {
  const raw = new Function(`return ${code}`)();
  return JSON.parse(raw);
}

/* ------------------------- 安装 / 回落 / 焦点 ------------------------- */
const realm = makeRealm();
const result = apply(PATCH);
check(
  "补丁完整安装：hasFocus / SW 回落 / Notification 包装",
  result.focusPatchInstalled === true &&
    result.swPatchInstalled === true &&
    result.notificationWrapped === true &&
    result.error === null,
  JSON.stringify(result),
);
const swRejected = await realm.win.ServiceWorkerRegistration.prototype
  .showNotification("x")
  .then(() => false, () => true);
check("SW showNotification reject → pi-web 回落 window.Notification", swRejected === true);

const n1 = new realm.win.Notification("任务完成");
check(
  "通知标题拼进页签名（去掉 ' - Pi Web' 后缀）",
  n1.title === "会话A — 任务完成",
  n1.title,
);
realm.win.__piDesktopWindowFocused = true;
check("窗口聚焦：document.hasFocus() 为 true", realm.doc.hasFocus() === true);
realm.win.__piDesktopWindowFocused = false;
check("窗口失焦：document.hasFocus() 跟随为 false", realm.doc.hasFocus() === false);
realm.win.__piDesktopWindowFocused = true;

/* ------------------------- 幂等 / 重载 ------------------------- */
const Wrapped = realm.win.Notification;
const again = apply(PATCH);
const n2 = new realm.win.Notification("任务完成");
check(
  "重复注入幂等：不重复包装、标题不重复拼前缀",
  realm.win.Notification === Wrapped &&
    n2.title === "会话A — 任务完成" &&
    again.focusPatchInstalled === true &&
    again.notificationWrapped === true,
  `${n2.title} / ${realm.win.Notification === Wrapped}`,
);
const reloaded = makeRealm({ title: "会话B - Pi Web" });
const afterReload = apply(PATCH);
check(
  "页面重新加载（全新 realm）后重新安装补丁",
  afterReload.focusPatchInstalled === true &&
    afterReload.swPatchInstalled === true &&
    afterReload.notificationWrapped === true,
);
check(
  "多页签通知标题互不串扰",
  new reloaded.win.Notification("任务完成").title === "会话B — 任务完成",
);

/* ------------------------- 关闭 / 上游变化 ------------------------- */
const disabled = makeRealm();
const compatOnly = apply(COMPAT);
check(
  "通知增强关闭：只读检测不打补丁（不改任何 Web API）",
  compatOnly.error === null &&
    compatOnly.swPatchInstalled === false &&
    disabled.win.Notification === disabled.originalNotification &&
    typeof disabled.win.ServiceWorkerRegistration.prototype.showNotification === "function" &&
    disabled.win.ServiceWorkerRegistration.prototype.showNotification().then !== undefined,
  JSON.stringify(compatOnly),
);

const upstreamChanged = makeRealm({ withSw: false });
const changedResult = apply(PATCH);
check(
  "上游不再用 ServiceWorker 通知：不强行改写新实现，仍能包装原生 Notification",
  changedResult.hasServiceWorkerRegistration === false &&
    changedResult.swPatchInstalled === false &&
    changedResult.notificationWrapped === true &&
    changedResult.error === null &&
    new upstreamChanged.win.Notification("任务完成").title === "会话A — 任务完成",
  JSON.stringify(changedResult),
);

const noNotification = makeRealm({ withNotification: false });
const missingResult = apply(PATCH);
check(
  "上游移除 window.Notification：注入不抛错、保留 pi-web 原生行为",
  missingResult.hasNotification === false &&
    missingResult.notificationWrapped === false &&
    missingResult.error === null,
  JSON.stringify(missingResult),
);

if (failed) process.exit(1);
console.log("通知补丁检查通过");
