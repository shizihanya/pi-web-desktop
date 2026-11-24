#!/usr/bin/env node
/**
 * 通知 IPC 宿主回归检查（Windows 通知双弹修复）。
 *
 * 背景：sendSync 的回复值 `event.returnValue` 在 Electron 里首次赋值时就发出同步回复，
 * 之后再次赋值不会送达渲染层。曾经的写法是先 `event.returnValue = null` 兜底、
 * 末尾再覆写真实结果——渲染层拿到的永远是 null，页面补丁误判桥失败，
 * 回落 Chromium `new Notification()`，导致每次任务完成弹两条 Windows toast。
 *
 * 这里静态守护同步 IPC 处理器：`notification:create` 的 handler 必须只在末尾赋值一次
 * `event.returnValue`，且不出现「先置 null 再覆写」的模式。
 *
 *   npm run check:notification-host
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/main/tabs/notification-host.ts"), "utf8");

const pass = (msg) => console.log(`\u001b[32m✓\u001b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exitCode = 1;
};

/** 取出 ipcMain.on(CHANNEL, (event, ...) => { ... }) 的 handler 源码 */
function handlerBody(channel) {
  const marker = `ipcMain.on(${channel}`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const brace = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  return null;
}

const createBody = handlerBody('NOTIFICATION_IPC.create');
if (!createBody) {
  fail("找不到 notification:create 处理器（installNotificationHost 结构变了？）");
} else {
  const assignments = createBody.match(/event\.returnValue\s*=/g) ?? [];
  if (assignments.length !== 1) {
    fail(
      `notification:create 应只在末尾赋值一次 event.returnValue（当前 ${assignments.length} 次）；` +
        "Electron 在首次赋值时即发出 sendSync 回复，多次赋值会让渲染层拿到旧值",
    );
  } else {
    pass("notification:create 只赋值一次 event.returnValue");
    if (/event\.returnValue\s*=\s*null/.test(createBody)) {
      fail("notification:create 仍把 returnValue 直接置为 null（先置 null 再覆写的旧 bug 模式）");
    } else {
      pass("notification:create 不再预先置 null");
    }
    if (/return\s*;/.test(createBody)) {
      fail("notification:create 含提前 return：会在赋值前退出，sendSync 拿到 undefined");
    } else {
      pass("notification:create 无提前 return，任何路径都会回复");
    }
  }
}

const closeBody = handlerBody('NOTIFICATION_IPC.close');
if (!closeBody) {
  fail("找不到 notification:close 处理器");
} else if (/event\.returnValue/.test(closeBody)) {
  // close 走 ipcRenderer.send（异步），不需要同步回复
  fail("notification:close 是异步 send，不应设置 event.returnValue");
} else {
  pass("notification:close 走异步 send，不设同步回复");
}

if (!process.exitCode) console.log("通知宿主检查通过");
