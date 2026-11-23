#!/usr/bin/env node
/**
 * 主进程通知生命周期回归：不启动 Electron，用 mock Notification 验证
 * tag 替换、独立通知、身份稳定与激活/关闭互不干扰。
 *
 *   npm run check:notification-lifecycle
 */
import {
  createNotificationLifecycle,
  notificationIdentity,
  stableNotificationIdentity,
} from "../src/main/tabs/notification-lifecycle.ts";

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

/* ------------------------- 相同 tag 替换 ------------------------- */
{
  const h = makeLifecycle({ ids: ["aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"] });
  const senderA = { tabId: "tab-a" };
  const senderB = { tabId: "tab-b" };
  const oldId = h.lifecycle.create(senderA, payload("pi-session-complete:s1", "A"));
  const newId = h.lifecycle.create(senderB, payload("pi-session-complete:s1", "B"));

  check("同 Tag 连续创建得到不同 notificationId", oldId !== newId, `${oldId} / ${newId}`);
  check("同 Tag 连续创建只保留一条有效记录", h.lifecycle.size === 1 && !h.lifecycle.has(oldId) && h.lifecycle.has(newId), `size=${h.lifecycle.size}`);
  check(
    "同 Tag 使用相同 Electron Notification.id",
    h.notifications[0].options.id === h.notifications[1].options.id,
    `${h.notifications[0].options.id} / ${h.notifications[1].options.id}`,
  );
  check(
    "两次 Toast XML launch 分别携带不同 notificationId",
    h.notifications[0].options.toastXml.includes(`nid=${oldId}`) &&
      h.notifications[1].options.toastXml.includes(`nid=${newId}`),
  );

  h.lifecycle.handleActivation(launchArgs(oldId));
  check("旧 notificationId 激活无效", h.showCalls === 0 && h.sent.length === 0);

  h.notifications[0].emit("close", { reason: "userCanceled" });
  h.notifications[0].emit("failed", "old failed");
  check("旧通知对象 close / failed 不影响新记录", h.lifecycle.has(newId) && h.lifecycle.size === 1);

  h.lifecycle.handleActivation(launchArgs(newId));
  check("新 notificationId 激活成功", h.showCalls === 1 && h.tabs.join() === "tab-b" && h.sent.join() === newId);

  h.lifecycle.handleActivation(launchArgs(newId));
  check("连续激活同一条通知不重复执行", h.showCalls === 1 && h.sent.length === 1, `show=${h.showCalls} sent=${h.sent.length}`);
}

/* ------------------------- 不同 tag 独立 ------------------------- */
{
  const h = makeLifecycle();
  const id1 = h.lifecycle.create({ tabId: "tab-a" }, payload("tag-a", "A"));
  const id2 = h.lifecycle.create({ tabId: "tab-b" }, payload("tag-b", "B"));

  check("不同 Tag 创建两条独立记录", h.lifecycle.size === 2 && h.lifecycle.has(id1) && h.lifecycle.has(id2));
  check("不同 Tag 使用不同 Electron Notification.id", h.notifications[0].options.id !== h.notifications[1].options.id);

  h.lifecycle.handleActivation(launchArgs(id1));
  check("激活第一条后第二条记录仍存在", h.lifecycle.has(id2) && h.lifecycle.size === 1);
  h.lifecycle.handleActivation(launchArgs(id2));
  check("不同 Tag 两条通知都能独立激活", h.showCalls === 2 && h.tabs.join() === "tab-a,tab-b" && h.sent.join() === `${id1},${id2}`);
}

/* ------------------------- 空 tag 独立 ------------------------- */
{
  const h = makeLifecycle();
  const id1 = h.lifecycle.create({ tabId: "tab-a" }, payload("", "A"));
  const id2 = h.lifecycle.create({ tabId: "tab-b" }, payload("", "B"));

  check("空 Tag 通知仍然独立", h.lifecycle.size === 2 && id1 !== id2);
  check("空 Tag 使用不同 Toast 身份", h.notifications[0].options.id !== h.notifications[1].options.id);
  h.lifecycle.handleActivation(launchArgs(id2));
  check("空 Tag 通知可独立激活", h.sent.join() === id2 && h.tabs.join() === "tab-b");
}

/* ------------------------- 特殊字符 / 超长 / 清洗碰撞 ------------------------- */
{
  const h = makeLifecycle();
  const id1 = h.lifecycle.create({ tabId: "tab-a" }, payload("a-b", "A"));
  const id2 = h.lifecycle.create({ tabId: "tab-b" }, payload("ab", "B"));
  const longTag = `x-${"y".repeat(200)}!`;
  const id3 = h.lifecycle.create({ tabId: "tab-c" }, payload(longTag, "C"));

  check("清洗后会碰撞的不同原始 Tag 不合并", h.lifecycle.size === 3 && h.lifecycle.has(id1) && h.lifecycle.has(id2) && h.lifecycle.has(id3));
  check("不同原始 Tag 使用不同稳定身份", new Set(h.notifications.map((n) => n.options.id)).size === 3);
  check("超长 Tag 身份限制在 64 位十六进制内", /^[a-f0-9]{64}$/.test(h.notifications[2].options.id), h.notifications[2].options.id);
}

/* ------------------------- timedOut / 用户取消 ------------------------- */
{
  const h = makeLifecycle();
  const id = h.lifecycle.create({ tabId: "tab-a" }, payload("timeout-tag", "A"));

  h.notifications[0].emit("close", { reason: "timedOut" });
  check("timedOut 保留历史通知记录", h.lifecycle.has(id));
  h.notifications[0].emit("close", { reason: "userCanceled" });
  check("用户取消只清理当前通知", !h.lifecycle.has(id) && h.lifecycle.size === 0);
}

check("无 Tag identity 只保留安全字符", notificationIdentity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === "aaaaaaaabbbbccccddddeeeeeeeeeeee");
check("稳定 identity 对相同原始 tag 一致", stableNotificationIdentity("pi-session-complete:s1") === stableNotificationIdentity("pi-session-complete:s1"));
check("稳定 identity 对不同原始 tag 不同", stableNotificationIdentity("a-b") !== stableNotificationIdentity("ab"));

if (failed) process.exit(1);
console.log("通知生命周期检查通过");
