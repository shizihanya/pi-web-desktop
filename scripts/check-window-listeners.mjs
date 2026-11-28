#!/usr/bin/env node
/**
 * 监听器卫生守护（静态检查）。
 *
 * 背景（两个真实暴露过的问题）：
 *  1. TabManager 构造器在主窗口（BrowserWindow）上注册 resize / maximize / unmaximize
 *     的 relayout 监听器，但 destroy() 没有摘除。主窗口在「服务地址变化 / 重启服务」时
 *     会被复用（ensureMainWindow 返回同一窗口），每次重建 TabManager 就在同一窗口上
 *     叠加 3 个监听器：resize 时 layout()+notify() 被执行 N 倍，IPC 快照与 tabs.json
 *     写盘也成倍放大，随重建次数线性增长。
 *  2. Electron 在 WebContents 上内部维护约 10 个 did-stop-loading 监听器，
 *     壳子每页签再注册 1 个就触发 MaxListenersExceededWarning（运行日志实际出现过
 *     “11 did-stop-loading listeners added to [WebContents]”）。官方做法是对该
 *     emitter 调 setMaxListeners 调高上限。
 *
 * 这里静态守护 tab-manager.ts：
 *  - 构造器里 win.on(...) 注册的每个窗口事件，destroy() 里必须有对应 win.off(...)；
 *  - createTab 必须给 webContents 调 setMaxListeners（覆盖 Electron 内部监听器数量）。
 *
 *   npm run check:listeners
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/main/tabs/tab-manager.ts"), "utf8");

const pass = (msg) => console.log(`\u001b[32m✓\u001b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exitCode = 1;
};

/** 提取 destroy() 方法体 */
function destroyBody() {
  const marker = "destroy(): void {";
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
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

const destroy = destroyBody();
if (!destroy) {
  fail("找不到 TabManager.destroy()（结构变了？）");
} else {
  // 构造器里注册的窗口事件：resize / maximize / unmaximize / focus / blur
  // （focus / blur 用预绑定的 onWindowFocus / onWindowBlur，摘除走具名引用；
  //  resize / maximize / unmaximize 此前是内联箭头函数，destroy 里无法摘除。）
  const windowEvents = ["resize", "maximize", "unmaximize"];
  for (const event of windowEvents) {
    const registered = new RegExp(`win\\.on\\("${event}"`).test(source) ||
      new RegExp(`this\\.options\\.win\\.on\\("${event}"`).test(source);
    if (!registered) {
      pass(`构造器未注册 ${event}（无需摘除）`);
      continue;
    }
    const removed = new RegExp(`win\\.off\\("${event}"`).test(destroy) ||
      new RegExp(`this\\.options\\.win\\.off\\("${event}"`).test(destroy);
    if (removed) {
      pass(`destroy() 摘除了窗口 ${event} 监听器`);
    } else {
      fail(
        `destroy() 没有摘除窗口 ${event} 监听器：主窗口复用时每次重建 TabManager 都会叠加，` +
          "layout()/notify()/IPC/写盘被成倍放大",
      );
    }
  }
}

// MaxListeners 噪音：每个页签的 WebContents 要调高上限
if (/setMaxListeners\(\s*\d+\s*\)/.test(source)) {
  const limit = Number(/setMaxListeners\(\s*(\d+)\s*\)/.exec(source)?.[1] ?? 0);
  if (limit >= 20) {
    pass(`createTab 对 webContents 调用了 setMaxListeners(${limit})，覆盖 Electron 内部监听器数量`);
  } else {
    fail(`setMaxListeners(${limit}) 上限过低：Electron 内部 did-stop-loading 已有约 10 个监听器`);
  }
} else {
  fail(
    "createTab 没有对 webContents 调 setMaxListeners：Electron 内部约 10 个 did-stop-loading " +
      "监听器 + 壳子注册的 1 个会触发 MaxListenersExceededWarning（运行日志已出现）",
  );
}

if (!process.exitCode) console.log("监听器卫生检查通过");
