#!/usr/bin/env node
/**
 * 主进程通知生命周期回归：不启动 Electron，用 mock Notification 验证
 * 连续通知的身份独立、记录独立与激活/关闭互不干扰。
 *
 *   npm run check:notification-lifecycle
 */
import { createNotificationLifecycle, notificationIdentity } from "../src/main/tabs/notification-lifecycle.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

class FakeNotification {
  constructor(options) {
    this.options = options;
    this.events = new Map();
    this.showCount = 0;
    this.closeCount = 0;
  }
  on(event, listener) {
    const list = this.events.get(event) ?? [];
    list.push(listener);
    this.events.set(event, list);
    return this;
  }
  emit(event, payload) {
    for (const listener of [...(this.events.get(event) ?? [])]) listener(payload);
  }
  show() {
    this.showCount += 1;
  }
  close() {
    this.closeCount += 1;
  }
}

function makeLifecycle({ ids } = {}) {
  const notifications = [];
  const sent = [];
  const tabs = [];
  let showCalls = 0;
  let seq = 0;
  const fixedIds = ids ?? [];

  const lifecycle = createNotificationLifecycle({
    createId: () => fixedIds[seq++] ?? `id-${String(seq).padStart(8, "0")}`,
    createNotification: (options) => {
      const n = new FakeNotification(options);
      notifications.push(n);
      return n;
    },
    isSenderValid: () => true,
    findTabIdBySender: (sender) => sender.tabId,
    isTabAlive: () => true,
    showWindow: () => { showCalls += 1; },
    activateTab: (tabId) => tabs.push(tabId),
    sendActivated: (_sender, id) => sent.push(id),
  });

  return { lifecycle, notifications, sent, tabs, get showCalls() { return showCalls; } };
}

function payload(tag, title) {
  return { title, body: "body", tag, silent: false };
}
function launchArgs(id) {
  return `piweb-desktop&nid=${id}`;
}

/* ------------------------- 相同 tag 连续两条 ------------------------- */
{
  const h = makeLifecycle();
  const senderA = { tabId: "tab-a" };
  const senderB = { tabId: "tab-b" };
  const id1 = h.lifecycle.create(senderA, payload("same-tag", "A"));
  const id2 = h.lifecycle.create(senderB, payload("same-tag", "B"));

  check("相同 tag 连续创建得到不同 notificationId", Boolean(id1 && id2 && id1 !== id2), `${id1} / ${id2}`);
  check("两条通知生成不同 Electron Notification.id", h.notifications[0].options.id !== h.notifications[1].options.id);
  check(
    "两条 Toast XML launch 分别携带各自 notificationId",
    h.notifications[0].options.toastXml.includes(`nid=${id1}`) &&
      h.notifications[1].options.toastXml.includes(`nid=${id2}`),
  );
  check("两条通知都有独立记录", h.lifecycle.size === 2, String(h.lifecycle.size));

  h.lifecycle.handleActivation(launchArgs(id1));
  check("激活第一条：窗口恢复 / Tab 激活 / Renderer 回传各自正确", h.showCalls === 1 && h.tabs.join() === "tab-a" && h.sent.join() === id1);
  check("激活第一条后第二条记录仍存在", h.lifecycle.has(id2), `size=${h.lifecycle.size}`);

  h.lifecycle.handleActivation(launchArgs(id1));
  check("连续激活同一条通知不重复执行", h.showCalls === 1 && h.sent.length === 1, `show=${h.showCalls} sent=${h.sent.length}`);

  h.lifecycle.handleActivation(launchArgs(id2));
  check("第二条通知可以独立激活", h.showCalls === 2 && h.tabs.join() === "tab-a,tab-b" && h.sent.join() === `${id1},${id2}`);
  check("两条通知都显示过且各自只 close 一次", h.notifications.every((n) => n.showCount === 1 && n.closeCount === 1));
}

/* ------------------------- 关闭第一条不影响第二条 ------------------------- */
{
  const h = makeLifecycle();
  const senderA = { tabId: "tab-a" };
  const senderB = { tabId: "tab-b" };
  const id1 = h.lifecycle.create(senderA, payload("same-tag", "A"));
  const id2 = h.lifecycle.create(senderB, payload("same-tag", "B"));

  h.lifecycle.close(senderA, id1);
  check("关闭第一条后第二条记录仍存在", h.lifecycle.has(id2) && h.lifecycle.size === 1);
  h.lifecycle.handleActivation(launchArgs(id2));
  check("关闭第一条后第二条仍可激活", h.sent.join() === id2 && h.tabs.join() === "tab-b");
}

/* ------------------------- failed / timedOut / 不同 tag ------------------------- */
{
  const h = makeLifecycle();
  const id1 = h.lifecycle.create({ tabId: "tab-a" }, payload("tag-a", "A"));
  const id2 = h.lifecycle.create({ tabId: "tab-b" }, payload("tag-b", "B"));

  h.notifications[0].emit("failed", "boom");
  check("第一条 failed 不影响第二条", h.lifecycle.has(id2) && h.lifecycle.size === 1);
  h.lifecycle.handleActivation(launchArgs(id2));
  check("不同 tag 通知互不影响", h.sent.join() === id2 && h.tabs.join() === "tab-b");
}
{
  const h = makeLifecycle();
  const id = h.lifecycle.create({ tabId: "tab-a" }, payload("timeout-tag", "A"));

  h.notifications[0].emit("close", { reason: "timedOut" });
  check("timedOut 保留历史通知记录", h.lifecycle.has(id));
  h.notifications[0].emit("close", { reason: "userCanceled" });
  check("用户取消只清理当前通知", !h.lifecycle.has(id) && h.lifecycle.size === 0);
}

check("Notification identity 只保留安全字符", notificationIdentity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === "aaaaaaaabbbbccccddddeeeeeeeeeeee");

if (failed) process.exit(1);
console.log("通知生命周期检查通过");
