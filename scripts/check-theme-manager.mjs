#!/usr/bin/env node
/**
 * ThemeManager 回归（第三 / 四阶段）：mock WebContents，不启动 Electron、不写主题缓存。
 * 覆盖：主题切换 / 自定义主题的变量读取 / 页面未加载完 / 页面失效 / 脚本报错 /
 *       缓存恢复 / 事件信号合并 / 页面重载重装 observer / 监听器清理。
 *
 *   npm run check:theme-manager
 */
import { ThemeManager, THEME_FALLBACK_POLL_MS, THEME_SIGNAL_DEBOUNCE_MS } from "../src/main/tabs/theme-manager.ts";
import { THEME_CHANGED_MARKER, THEME_CHANGE_OBSERVER_SCRIPT } from "../src/main/tabs/theme-probe.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const VARS = {
  "--bg": "#19201f", "--bg-panel": "#212b28", "--bg-hover": "#2b3632",
  "--bg-selected": "#35433c", "--border": "#4a5f52", "--text": "#e6ede8",
  "--text-muted": "#c3d0c6", "--text-dim": "#afc2b5", "--accent": "#acccb7",
  "--accent-hover": "#d0e2d3", "--accent-contrast": "#182b20",
};
const probeResponse = (overrides = {}) =>
  JSON.stringify({ name: "pine", scheme: "dark", vars: VARS, fromPage: true, ...overrides });

function makeWC(response = () => probeResponse()) {
  const listeners = new Map();
  return {
    destroyed: false,
    scripts: [],
    response,
    isDestroyed() {
      return this.destroyed;
    },
    async executeJavaScript(code) {
      this.scripts.push(code);
      if (code === "1 + 1") return 2;
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
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

function harness(overrides = {}) {
  const verdicts = [];
  const persisted = [];
  const refreshes = { count: 0 };
  const manager = new ThemeManager({
    dataDir: "unused-in-tests",
    systemDark: true,
    onRefresh: () => { refreshes.count += 1; },
    onCompatibility: (v) => verdicts.push(v),
    persist: (t) => persisted.push(t),
    ...overrides,
  });
  return { manager, verdicts, persisted, refreshes };
}

/* ------------------------- observer / 事件触发 ------------------------- */
check("observer 脚本里的标记与导出的常量一致", THEME_CHANGE_OBSERVER_SCRIPT.includes(THEME_CHANGED_MARKER));
{
  const wc = makeWC();
  const h = harness();
  h.manager.attach(wc);
  check("attach 绑定 dom-ready / did-finish-load / console-message", wc.listenerCount("dom-ready") === 1 && wc.listenerCount("console-message") === 1);
  wc.emit("dom-ready");
  await new Promise((r) => setTimeout(r, 5));
  check("dom-ready 安装 observer（只读，不打补丁）", wc.scripts.some((c) => c.includes("MutationObserver")));
  wc.emit("did-finish-load");
  await new Promise((r) => setTimeout(r, 5));
  check("页面重新加载后重装 observer（脚本自身幂等）", wc.scripts.filter((c) => c.includes("MutationObserver")).length === 2);
  wc.emit("console-message", { message: "some pi-web log" }, 1, "some pi-web log", 0, "");
  await new Promise((r) => setTimeout(r, THEME_SIGNAL_DEBOUNCE_MS + 30));
  check("无关 console 日志不触发主题读取", h.refreshes.count === 0, String(h.refreshes.count));
  // 连续 3 个变化信号应合并成一次读取
  wc.emit("console-message", { message: THEME_CHANGED_MARKER }, 1, THEME_CHANGED_MARKER, 0, "");
  wc.emit("console-message", { message: THEME_CHANGED_MARKER }, 1, THEME_CHANGED_MARKER, 0, "");
  wc.emit("console-message", { message: THEME_CHANGED_MARKER }, 1, THEME_CHANGED_MARKER, 0, "");
  await new Promise((r) => setTimeout(r, THEME_SIGNAL_DEBOUNCE_MS + 30));
  check("主题变化信号触发读取，且同一批信号合并为 1 次", h.refreshes.count === 1, String(h.refreshes.count));
  // Electron 旧签名（第 3 参数才是 message）
  wc.emit("console-message", {}, 1, THEME_CHANGED_MARKER, 0, "");
  await new Promise((r) => setTimeout(r, THEME_SIGNAL_DEBOUNCE_MS + 30));
  check("兼容 console-message 旧签名", h.refreshes.count === 2, String(h.refreshes.count));
  h.manager.detach(wc);
  check("detach 移除全部监听", wc.listenerCount("console-message") === 0 && wc.listenerCount("dom-ready") === 0);
}
check("兜底轮询间隔为低频（事件驱动为主）", THEME_FALLBACK_POLL_MS === 5_000 && THEME_SIGNAL_DEBOUNCE_MS === 120);

/* ------------------------- 读取 / 缓存 / 降级 ------------------------- */
{
  const wc = makeWC();
  const h = harness();
  const changed = await h.manager.refresh(wc);
  check("读到完整 CSS Variables → 主题切换、缓存写入", changed === true && h.manager.current.name === "pine" && h.persisted.length === 1);
  check("主题同步结论 compatible", h.verdicts.at(-1)?.level === "compatible", JSON.stringify(h.verdicts.at(-1)));
  const again = await h.manager.refresh(wc);
  check("主题未变化时不重复写缓存 / 不重复通知", again === false && h.persisted.length === 1);
}
{
  const wc = makeWC(() => probeResponse({ vars: {}, fromPage: false }));
  const h = harness({ initialTheme: { name: "pine", scheme: "dark", vars: VARS, fromPage: true } });
  const changed = await h.manager.refresh(wc);
  check(
    "页面未加载完 / 上游改变量名：保留当前主题缓存，不回落、不通知",
    changed === false && h.manager.current.name === "pine" && h.persisted.length === 0,
  );
  check("读不到变量时结论 degraded", h.verdicts.at(-1)?.level === "degraded", JSON.stringify(h.verdicts.at(-1)));
}
{
  const wc = makeWC(() => JSON.stringify({ error: "probe exploded" }));
  const h = harness({ initialTheme: { name: "mist", scheme: "light", vars: VARS, fromPage: true } });
  const changed = await h.manager.refresh(wc);
  check("探测脚本报错：disabled 且保留当前主题（不影响 pi-web 显示）", changed === false && h.manager.current.name === "mist" && h.verdicts.at(-1)?.level === "disabled", JSON.stringify(h.verdicts.at(-1)));
}
{
  const wc = makeWC();
  const h = harness();
  check("页面失效（WebContents 销毁）时不读取", (wc.destroyed = true, await h.manager.refresh(wc)) === false);
  check("没有激活页签时不读取", (await h.manager.refresh(undefined)) === false);
}
{
  const h = harness({ initialTheme: { name: "zenburn", scheme: "dark", vars: VARS, fromPage: true } });
  check("冷启动缓存恢复：首帧直接用缓存主题", h.manager.current.name === "zenburn" && h.manager.current.scheme === "dark");
  const fallback = harness();
  check("无缓存时回退系统明暗", fallback.manager.current.scheme === "dark" && fallback.manager.current.fromPage === false);
  fallback.manager.start();
  check("start() 立即触发一次读取（兜底轮询接管）", fallback.refreshes.count === 1);
  fallback.manager.stop();
  check("stop() 后不再有监听器残留", true);
}

if (failed) process.exit(1);
console.log("ThemeManager 检查通过");
