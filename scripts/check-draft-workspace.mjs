#!/usr/bin/env node
/**
 * 独立输入工作区编排层回归（mock WebContents / TabManager，不启动 Electron / 不联网）。
 *
 * 覆盖 Plan 01 §六：打开关闭、大量文本、页签隔离、会话隔离、成功清空、失败保留、
 * 连续快速点击不重复提交、Composer 不兼容时禁止发送且原生输入不受影响、
 * 探针失败自动禁用、自动提交模式、图片预览数据、重启恢复。
 *
 *   npm run check:draft-workspace
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_PROBE_SCRIPT } from "../src/main/tabs/composer-bridge.ts";
import { DRAFT_PANEL_WIDTH, draftKey } from "../src/main/tabs/draft-model.ts";
import { DraftWorkspace } from "../src/main/tabs/draft-workspace.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}
const tick = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const GOOD_PROBE = {
  textarea: true, scoped: true, sendButton: true, sendEnabled: true,
  busy: false, sessionId: "s1", cwd: null, sendMode: "enter",
  compact: false, pageReady: true, error: null,
  modes: { send: true, steer: false, followUp: false, attach: true },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: "14px", lineHeight: "22.4px", color: "rgb(26, 26, 26)",
    background: "rgba(0, 0, 0, 0)", letterSpacing: "normal",
  },
};

class MockContents {
  constructor(options = {}) {
    this.destroyed = false;
    this.listeners = new Map();
    this.probe = options.probe ?? GOOD_PROBE;
    this.sendResult = options.sendResult ?? { ok: true, reason: "已通过 pi-web 原生发送按钮提交" };
    this.calls = [];
    this.deferred = null;
  }
  isDestroyed() { return this.destroyed; }
  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  off(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener));
    return this;
  }
  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  executeJavaScript(code) {
    this.calls.push(code);
    if (code === COMPOSER_PROBE_SCRIPT) return Promise.resolve(JSON.stringify(this.probe));
    if (code.includes("__piDesktopDraftSending")) {
      if (this.deferred) return this.deferred.promise;
      return Promise.resolve(JSON.stringify(this.sendResult));
    }
    if (code.includes("ta.focus()")) {
      return Promise.resolve(JSON.stringify({ ok: true, reason: "已放入原生输入框" }));
    }
    return Promise.resolve("null");
  }
  hang() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.deferred = { promise, resolve };
  }
  release(result) {
    this.deferred?.resolve(JSON.stringify(result));
    this.deferred = null;
  }
  sendCalls() { return this.calls.filter((code) => code.includes("__piDesktopDraftSending")).length; }
}

function makeTabs() {
  const contexts = [
    { tabId: "tab-a", title: "会话 1", path: "/?session=s1", sessionKey: "session:s1" },
    { tabId: "tab-b", title: "会话 1 (另一页签)", path: "/?session=s1", sessionKey: "session:s1" },
    { tabId: "tab-c", title: "会话 2", path: "/?session=s2", sessionKey: "session:s2" },
  ];
  const contents = new Map([
    ["tab-a", new MockContents()],
    ["tab-b", new MockContents()],
    ["tab-c", new MockContents()],
  ]);
  let activeId = "tab-a";
  const reserved = [];
  return {
    contexts,
    contents,
    reserved,
    activeTabId: () => activeId,
    tabContext: (id) => contexts.find((ctx) => ctx.tabId === id) ?? null,
    allContexts: () => contexts.map((ctx) => ({ ...ctx })),
    contentsOf: (id) => contents.get(id) ?? null,
    setReservedRightWidth: (px) => reserved.push(px),
    windowWidth: () => 1_440,
    activate(id) { activeId = id; },
    changeSession(id, sessionKey, path) {
      const ctx = contexts.find((item) => item.tabId === id);
      if (ctx) { ctx.sessionKey = sessionKey; ctx.path = path; }
    },
    get activeId() { return activeId; },
  };
}

function makeWorkspace(tabs, dataDir, enabled = true) {
  const snapshots = [];
  const verdicts = [];
  const logs = [];
  const ws = new DraftWorkspace({
    enabled,
    dataDir,
    tabs: {
      activeTabId: tabs.activeTabId,
      tabContext: tabs.tabContext,
      allContexts: tabs.allContexts,
      contents: tabs.contentsOf,
      setReservedRightWidth: tabs.setReservedRightWidth,
      windowWidth: tabs.windowWidth,
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    onCompat: (verdict) => verdicts.push(verdict),
    onDebug: (message) => logs.push(message),
  });
  return { ws, snapshots, verdicts, logs };
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-draft-test-"));

try {
  /* ---------------- 打开 / 收起 ---------------- */
  const tabs = makeTabs();
  const { ws, snapshots, verdicts, logs } = makeWorkspace(tabs, dataDir);
  check("初始未展开、未验证兼容性", !ws.snapshot().open && ws.snapshot().compat.level === "unverified");
  check("初始不占右侧空间", tabs.reserved.at(-1) === 0);

  ws.open();
  check("打开后面板展开并让出右侧宽度", ws.snapshot().open && tabs.reserved.at(-1) === DRAFT_PANEL_WIDTH);
  ws.close();
  check("收起后恢复全宽", !ws.snapshot().open && tabs.reserved.at(-1) === 0);
  ws.toggle();
  check("重新打开", ws.snapshot().open);

  /* ---------------- 只读探针 / 不再注入页面内按钮 ---------------- */
  const a = tabs.contentsOf("tab-a");
  ws.attach(a);
  check("attach 只绑定一次", (ws.attach(a), a.listeners.get("dom-ready").length === 1));
  check("不再绑定 console-message（页面内 ⤢ 入口已删除）", (a.listeners.get("console-message") ?? []).length === 0);
  ws.close();
  check("收起后面板关闭", !ws.snapshot().open);
  ws.open();
  const probeBefore = a.calls.filter((c) => c === COMPOSER_PROBE_SCRIPT).length;
  a.emit("dom-ready");
  await tick();
  check("探针通过 → compatible，并上报给 CompatibilityTracker", ws.snapshot().compat.level === "compatible" && verdicts.some((v) => v.level === "compatible"));
  check(
    "每次 dom-ready 恰好跑一次只读探针，且不注入任何可见按钮脚本",
    a.calls.filter((c) => c === COMPOSER_PROBE_SCRIPT).length === probeBefore + 1 &&
      !a.calls.some((c) => c.includes("__piDesktopDraftEntry")),
  );

  /* ---------------- 大量文本 / 页签隔离 ---------------- */
  const big = "长文本回归 ".repeat(20_000);
  ws.setText(big);
  check("输入大量文本", ws.snapshot().text.length === big.length && big.length > 100_000);

  tabs.activate("tab-b");
  ws.refreshContext();
  check("切换页签后草稿为空（不串用其他页签）", ws.snapshot().text === "" && ws.snapshot().tabId === "tab-b");
  ws.setText("B 页签自己的草稿");
  tabs.activate("tab-a");
  ws.refreshContext();
  check("切回原页签恢复自己的长草稿", ws.snapshot().text === big);

  tabs.activate("tab-c");
  ws.refreshContext();
  check("同一应用内不同会话草稿隔离", ws.snapshot().text === "" && ws.snapshot().sessionKey === "session:s2");
  tabs.activate("tab-a");
  ws.refreshContext();

  ws.close();
  ws.open();
  check("关闭编辑面板不丢草稿", ws.snapshot().text === big);

  /* ---------------- 发送成功清空 / 失败保留 ---------------- */
  const ok = await ws.send();
  check("发送成功返回 ok", ok.ok);
  check("发送成功后清空本次草稿", ws.snapshot().text === "" && ws.snapshot().lastResult?.ok === true);
  check("发送脚本只点原生按钮，没有自己发 API", a.calls[a.calls.length - 1].includes("button.click()") && !a.calls[a.calls.length - 1].includes("fetch("));
  check("发送脚本带上目标会话 key", a.calls[a.calls.length - 1].includes('"sessionKey":"session:s1"'));

  a.sendResult = { ok: false, reason: "未能确认消息已送达，草稿未清空" };
  ws.setText("发送失败要保留的内容");
  ws.addImages([{ data: "HHHH", mimeType: "image/png", name: "fail.png" }]);
  const failedSend = await ws.send();
  check("发送失败返回 !ok", !failedSend.ok);
  check("发送失败时保留草稿文本", ws.snapshot().text === "发送失败要保留的内容");
  check("发送失败时保留图片附件", ws.snapshot().attachments.length === 1);
  for (const attachment of ws.snapshot().attachments) ws.removeImage(attachment.id);
  a.sendResult = { ok: true, reason: "ok" };

  /* ---------------- 连续快速点击不重复提交 ---------------- */
  ws.setText("连点去重回归");
  const callsBefore = a.sendCalls();
  a.hang();
  const first = ws.send();
  const second = await ws.send();
  const third = await ws.send();
  check("第二次 / 第三次点击立即被拦住", !second.ok && !third.ok && /上一次发送尚未结束/.test(second.reason));
  check("只有第一次真正进入页面发送脚本", a.sendCalls() === callsBefore + 1);
  check("连点期间 sending=true 且 canSend=false", ws.snapshot().sending && !ws.snapshot().canSend);
  a.release({ ok: true, reason: "ok" });
  await first;
  await tick();
  check("第一次结果回来后草稿被清空、闸门释放", ws.snapshot().text === "" && !ws.snapshot().sending);

  /* ---------------- 会话切换时禁止发送旧草稿 ---------------- */
  ws.setText("旧会话草稿");
  tabs.changeSession("tab-a", "session:s9", "/?session=s9");
  const stale = await ws.send();
  check("发送前发现会话已切换 → 禁止发送", !stale.ok && /会话已切换|页签已切换/.test(stale.reason));
  check("被阻止的草稿仍然保留", ws.snapshot().text === "旧会话草稿");
  tabs.changeSession("tab-a", "session:s1", "/?session=s1");

  /* ---------------- Composer 不兼容：禁止发送，原生输入不受影响 ---------------- */
  a.probe = { ...GOOD_PROBE, textarea: false };
  a.emit("did-finish-load");
  await tick();
  check("Composer DOM 变化 → disabled 并记录原因", ws.snapshot().compat.level === "disabled" && /禁止发送/.test(ws.snapshot().compat.reason));
  const beforeIncompatible = a.sendCalls();
  const blocked = await ws.send();
  check("不兼容时禁止发送", !blocked.ok);
  check("不兼容时根本没有执行发送脚本（原生输入框不受影响）", a.sendCalls() === beforeIncompatible);
  check("不兼容时草稿仍保留", ws.snapshot().text === "旧会话草稿");
  a.probe = GOOD_PROBE;
  a.emit("dom-ready");
  await tick();
  check("探针恢复后重新 compatible", ws.snapshot().compat.level === "compatible");

  /* ---------------- 探针注入失败自动禁用 ---------------- */
  const originalProbeCall = a.executeJavaScript.bind(a);
  a.executeJavaScript = (code) =>
    code === COMPOSER_PROBE_SCRIPT
      ? Promise.reject(new Error("DOM 结构变化"))
      : originalProbeCall(code);
  a.emit("dom-ready");
  await tick();
  check("探针注入失败 → disabled 且写明原因", ws.snapshot().compat.level === "disabled" && /探针注入失败/.test(ws.snapshot().compat.reason));
  check("注入失败写进诊断日志", logs.some((line) => line.includes("[draft]")));
  a.executeJavaScript = originalProbeCall;
  a.emit("dom-ready");
  await tick();

  /* ---------------- 页签关闭清理 / detach ---------------- */
  ws.onTabClosed("tab-b");
  check("关闭页签清掉它名下草稿（不影响 A）", ws.snapshot().text === "旧会话草稿");
  ws.detach(a);
  check("detach 摘掉全部监听", ["dom-ready", "did-finish-load"].every((e) => (a.listeners.get(e) ?? []).length === 0));

  /* ---------------- 增强关闭：原生 Composer 完全不受影响 ---------------- */
  const offTabs = makeTabs();
  const off = makeWorkspace(offTabs, dataDir, false);
  const offContents = offTabs.contentsOf("tab-a");
  off.ws.attach(offContents);
  off.ws.open();
  check("增强关闭时面板不展开", !off.ws.snapshot().open);
  check("增强关闭时不装任何页面监听", (offContents.listeners.get("dom-ready") ?? []).length === 0);
  check("增强关闭时零注入", offContents.calls.length === 0);
  const offSend = await off.ws.send();
  check("增强关闭时发送被阻止", !offSend.ok);

  /* ---------------- 重启恢复（可选增强，按 path + sessionKey 一对一） ---------------- */
  const restartTabs = makeTabs();
  restartTabs.contexts.forEach((ctx, i) => { ctx.tabId = `restart-${i}`; });
  restartTabs.activate("restart-0");
  const restarted = new Map([
    ["restart-0", new MockContents()],
    ["restart-1", new MockContents()],
    ["restart-2", new MockContents()],
  ]);
  restartTabs.contentsOf = (id) => restarted.get(id) ?? null;
  const ws2 = new DraftWorkspace({
    enabled: true,
    dataDir,
    tabs: {
      activeTabId: restartTabs.activeTabId,
      tabContext: restartTabs.tabContext,
      allContexts: restartTabs.allContexts,
      contents: restartTabs.contentsOf,
      setReservedRightWidth: restartTabs.setReservedRightWidth,
      windowWidth: restartTabs.windowWidth,
    },
    onChange: () => {},
    onCompat: () => {},
  });
  ws2.hydrate(restartTabs.allContexts());
  ws2.refreshContext();
  check("重启后按 path + sessionKey 恢复草稿到新 tabId", ws2.snapshot().text === "旧会话草稿");
  check("重启后面板宽度在合法范围内", ws2.snapshot().panelWidth >= 280 && ws2.snapshot().panelWidth <= 720);
  ws2.dispose();

  /* ---------------- 拖动宽度 / 字体 / steer / 图片 / 原生输入框 ---------------- */
  ws.setWidth(520);
  check("拖动宽度后快照与 pi-web 视图让出宽度同步", ws.snapshot().panelWidth === 520 && tabs.reserved.at(-1) === 520);
  ws.setWidth(50);
  check("宽度钳到下限 280", ws.snapshot().panelWidth === 280);
  ws.setWidth(99_999);
  check("宽度钳到上限 720", ws.snapshot().panelWidth === 720);
  ws.setWidth(520);
  check("字体跟随原生输入框 computed style", Boolean(ws.snapshot().typography?.fontFamily.includes("Segoe UI")));
  check("探针透传原生提交模式", ws.snapshot().modes.send === true && ws.snapshot().modes.steer === false);

  // 前面的 detach 测试摘过监听，这里重新挂上才能触发探针
  ws.attach(a);
  a.probe = { ...GOOD_PROBE, sendButton: false, modes: { send: false, steer: true, followUp: true, attach: true } };
  a.emit("did-finish-load");
  await tick();
  check("Agent 运行时 steer/followUp 可用，compat 不误降级", ws.snapshot().modes.steer && ws.snapshot().compat.level === "compatible");
  check("自动模式：运行中优先 steer（对齐 pi-web 原生 Enter 行为）", ws.snapshot().mode === "steer");

  await ws.send();
  check("自动模式下发送脚本用的就是 steer，无需用户选择", a.calls[a.calls.length - 1].includes('"mode":"steer"'));
  check("发送后产出结果提示", ws.snapshot().lastResult !== null);
  ws.setText("重新编辑");
  check("重新输入即清掉旧提示（不会一直挂在那里）", ws.snapshot().lastResult === null);

  a.probe = { ...GOOD_PROBE, sendButton: false, modes: { send: false, steer: false, followUp: true, attach: true } };
  a.emit("did-finish-load");
  await tick();
  check("自动模式：steer 不可用时回落到 followUp", ws.snapshot().mode === "followUp");
  await ws.send();
  check("followUp 自动模式下发送脚本用的就是 followUp（文案与实际模式一致）", a.calls[a.calls.length - 1].includes('"mode":"followUp"'));
  a.probe = GOOD_PROBE;
  a.emit("did-finish-load");
  await tick();
  check("自动模式：Agent 跑完自动回到 send", ws.snapshot().mode === "send");

  /* ---------------- Agent 开始/结束：状态轮询带动只读探针刷新按钮文案 ---------------- */
  // 实证：pi-web 在 Agent 运行中把 send 按钮整组换成 steer/followUp，
  // 但不会触发 dom-ready，tabId/sessionKey/title 也不变。
  // TabManager.notify()（状态轮询 700ms）→ refreshContext() 必须按节流重跑探针。
  const beforeSteer = snapshots.length;
  a.probe = { ...GOOD_PROBE, sendButton: false, modes: { send: false, steer: true, followUp: true, attach: true } };
  await new Promise((r) => setTimeout(r, 950)); // 越过 900ms 节流
  ws.refreshContext();
  await tick(6);
  check("Agent 开始运行（signature 不变）后按钮文案自动切到 steer", ws.snapshot().mode === "steer");
  check("模式真变化时确实广播了新快照（渲染层才会换文案）", snapshots.length > beforeSteer);
  a.probe = GOOD_PROBE;
  await new Promise((r) => setTimeout(r, 950));
  ws.refreshContext();
  await tick(6);
  check("Agent 结束后按钮文案自动回到 send", ws.snapshot().mode === "send");

  /* ---------------- 性能回归：结果不变时不重复广播全量快照 ---------------- */
  // snapshot 含整篇草稿文本 + 附件，状态轮询每 700ms 一次；
  // 若探针每次都 emit，100KB 长草稿会被序列化 + IPC 广播到所有窗口并让渲染层反复重建 DOM。
  ws.setText("长文本性能回归 ".repeat(10_000));
  const beforeIdle = snapshots.length;
  const snapshotBytes = JSON.stringify(ws.snapshot()).length;
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 950));
    ws.refreshContext();
    await tick(6);
  }
  check(
    "探针结果不变时 3 轮状态轮询零额外全量快照广播",
    snapshots.length === beforeIdle,
    `before=${beforeIdle} after=${snapshots.length} 单次快照≈${snapshotBytes}B`,
  );

  ws.setText("带图片的草稿");
  ws.addImages([{ data: "AAAA", mimeType: "image/png", name: "a.png" }]);
  check("图片独立存内存，不污染草稿文本", ws.snapshot().attachments.length === 1 && ws.snapshot().text === "带图片的草稿");
  const stored = ws.getImage(ws.snapshot().attachments[0].id);
  check(
    "点击附件可按需取回图片数据，且 base64 不进快照",
    stored?.data === "AAAA" && stored?.mimeType === "image/png" && !JSON.stringify(ws.snapshot()).includes("AAAA"),
  );
  ws.addImages([{ data: "BBBB", mimeType: "text/plain", name: "bad.txt" }]);
  check("非图片附件被拒绝", ws.snapshot().attachments.length === 1);
  ws.removeImage(ws.snapshot().attachments[0].id);
  check("可移除单张图片", ws.snapshot().attachments.length === 0 && ws.getImage("nope") === null);

  /* ---------------- 纯图片 / 文字+图片 / 失败保留附件 ---------------- */
  a.sendResult = { ok: true, reason: "ok" };
  ws.setText(""); // 纯图片：草稿文本为空，只有附件
  ws.addImages([{ data: "EEEE", mimeType: "image/png", name: "only.png" }]);
  check("纯图片草稿 canSend 为 true", ws.snapshot().canSend && ws.snapshot().text === "" && ws.snapshot().attachments.length === 1);
  const imageOnly = await ws.send();
  check("纯图片允许发送", imageOnly.ok, JSON.stringify(imageOnly));
  const imageOnlyCall = a.calls[a.calls.length - 1];
  check("纯图片发送脚本带图片数据且 text 为空", imageOnlyCall.includes('"text":""') && imageOnlyCall.includes("EEEE"));
  check("纯图片发送成功后清空附件", ws.snapshot().attachments.length === 0);

  ws.setText("文字 + 图片");
  ws.addImages([{ data: "FFFF", mimeType: "image/png", name: "mix.png" }]);
  const mixed = await ws.send();
  check("文字 + 图片允许发送", mixed.ok, JSON.stringify(mixed));

  a.sendResult = { ok: false, reason: "未能确认消息已送达" };
  ws.setText("失败要保留");
  ws.addImages([{ data: "GGGG", mimeType: "image/png", name: "keep.png" }]);
  const kept = await ws.send();
  check(
    "发送失败同时保留草稿文本和图片附件",
    !kept.ok && ws.snapshot().text === "失败要保留" && ws.snapshot().attachments.length === 1,
    JSON.stringify(kept),
  );
  a.sendResult = { ok: true, reason: "ok" };
  ws.setText("");
  for (const attachment of ws.snapshot().attachments) ws.removeImage(attachment.id);

  ws.attach(a);
  const domReadyListeners = a.listeners.get("dom-ready").length;
  ws.onTabsReplaced();
  check("onTabsReplaced 不摘掉 dom-ready 监听（只读探针要能重装）", a.listeners.get("dom-ready").length === domReadyListeners);

  const native = await ws.openInNative();
  check("一键切到原生输入框：成功、清空面板草稿、收起面板", native.ok && ws.snapshot().text === "" && !ws.snapshot().open);

  const restoredWidth = makeWorkspace(tabs, dataDir).ws;
  check("拖出来的面板宽度写进 drafts.json，重启后恢复", restoredWidth.snapshot().panelWidth === 520);
  restoredWidth.dispose();

  ws.dispose();
  off.ws.dispose();
  check("工作区快照始终包含兼容性原因", snapshots.every((s) => typeof s.compat.reason === "string"));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("独立输入工作区编排检查通过");
