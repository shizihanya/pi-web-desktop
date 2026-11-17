/**
 * 页签状态探测脚本的回归检查：不启动 Electron，直接把注入脚本抽出来在模拟页面里跑。
 * 目的和 check-theme-probe.mjs 一样——防止 String.raw / 转义把脚本写坏，并锁住
 * 「URL → 会话 id」「接口 → running/awaiting」「DOM 兜底」这几条路径。
 *
 * 特别要锁住一条回归：探测脚本**绝不能**读 `pi-web:unread-session-ids`。
 * 那个 key 是跨页签共享的全局未读集合，会让所有页签同时亮提示点。
 *
 *   node scripts/check-tab-status-probe.mjs
 */
import fs from "node:fs";

const src = fs.readFileSync("src/main/tabs/tab-status.ts", "utf8");
const probeMatch = /export const TAB_STATUS_PROBE_SCRIPT = String\.raw`([\s\S]*?)`;/.exec(src);
const readMatch = /export const TAB_STATUS_READ_SCRIPT = String\.raw`([\s\S]*?)`;/.exec(src);
if (!probeMatch || !readMatch) {
  throw new Error("TAB_STATUS_PROBE_SCRIPT / TAB_STATUS_READ_SCRIPT 未找到");
}

for (const [name, code] of [
  ["PROBE", probeMatch[1]],
  ["READ", readMatch[1]],
]) {
  try {
    new Function(code);
  } catch (error) {
    console.error(`${name} 探测脚本语法错误：`, error.message);
    process.exit(1);
  }
}

function makeRow({ key = "session:group:dom-id", running = false, unread = false, awaiting = false } = {}) {
  return {
    getAttribute: (name) => (name === "data-row-key" ? key : null),
    classList: { contains: (cls) => cls === "is-running" && running },
    querySelector: (sel) =>
      (sel === ".session-tree-unread" && unread) || (sel === ".session-tree-awaiting" && awaiting)
        ? {}
        : null,
  };
}

async function run({ search, marks = {}, api, row = null, notifyDone = false, sseEvents = [] }) {
  const store = new Map();
  // 未读标记 pi-web 是把 {sessionId: 时间戳} 整串 JSON 存进一个 key
  if (Object.keys(marks).length) {
    store.set("pi-web:unread-session-ids", JSON.stringify(marks));
  }
  const reads = { unreadKey: 0 };
  const sseListeners = [];
  globalThis.window = {
    location: { search },
    localStorage: {
      getItem: (key) => {
        if (key === "pi-web:unread-session-ids") reads.unreadKey += 1;
        return store.get(key) ?? null;
      },
      setItem: (key, value) => store.set(key, value),
    },
    EventSource: class {
      addEventListener(name, listener) {
        if (name === "message") sseListeners.push(listener);
      }
    },
  };
  globalThis.document = {
    querySelector: (sel) => (sel === ".session-tree-row.session-tree-session.is-selected" ? row : null),
  };
  globalThis.fetch = async () => {
    if (!api) throw new Error("接口不可用");
    return { ok: true, json: async () => api };
  };

  new Function(probeMatch[1])();
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (notifyDone) window.__piDesktopTabStatus.markDone();
  if (sseEvents.length) new window.EventSource('/api/agent/s1/events');
  for (const event of sseEvents) {
    for (const listener of sseListeners) listener({ data: JSON.stringify({ type: event }) });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = JSON.parse(new Function(`return ${readMatch[1]}`)());
  return { ...(result ?? { error: "probe 未安装" }), reads };
}

const cases = [
  {
    label: "等待回答：URL 会话 id + running 接口",
    input: { search: "?session=s1", api: { runningSessionIds: ["s1"], awaitingInputSessionIds: [] } },
    check: (out) =>
      out.sessionId === "s1" &&
      out.sessionSource === "url" &&
      out.running === true &&
      out.awaiting === false &&
      out.ready === true &&
      !("unread" in out),
  },
  {
    label: "历史未读标记不串扰：接口空闲 + 残留 mark 也不报未读",
    input: {
      search: "?session=s1",
      marks: { "other-session": Date.now() },
      api: { runningSessionIds: [], awaitingInputSessionIds: [] },
      row: makeRow({ unread: true }),
    },
    check: (out) =>
      out.running === false &&
      !("unread" in out) &&
      !("unreadAt" in out) &&
      out.doneSeq === 0,
  },
  {
    label: "等待用户确认：awaitingInputSessionIds",
    input: { search: "?session=s1", api: { runningSessionIds: [], awaitingInputSessionIds: ["s1"] } },
    check: (out) => out.awaiting === true && out.running === false,
  },
  {
    label: "URL 没有 session：用侧栏选中行取会话 id",
    input: { search: "", api: { runningSessionIds: ["dom-id"] }, row: makeRow() },
    check: (out) => out.sessionId === "dom-id" && out.sessionSource === "dom" && out.running === true,
  },
  {
    label: "接口挂了：用侧栏逐行状态兜底 running",
    input: { search: "?session=s1", api: null, row: makeRow({ running: true }) },
    check: (out) => out.running === true && out.ready === false && !("unread" in out),
  },
  {
    label: "通知先行：接口/侧栏还说 running 也按完成处理",
    input: {
      search: "?session=s1",
      api: { runningSessionIds: ["s1"], awaitingInputSessionIds: [] },
      row: makeRow({ running: true }),
      notifyDone: true,
    },
    check: (out) => out.running === false && out.awaiting === false && out.doneSeq === 1,
  },
  {
    label: "本会话未读时间戳：接口还报 running 也按完成处理",
    input: {
      search: "?session=s1",
      api: { runningSessionIds: ["s1"], awaitingInputSessionIds: [] },
      marks: { s1: Date.now() + 5_000 },
    },
    check: (out) => out.running === false && out.doneSeq === 1,
  },
  {
    label: "SSE agent_end：接口没清也按完成处理",
    input: {
      search: "?session=s1",
      api: { runningSessionIds: ["s1"], awaitingInputSessionIds: [] },
      row: makeRow({ running: true }),
      sseEvents: ["agent_end"],
    },
    check: (out) => out.running === false && out.doneSeq === 1,
  },
  {
    label: "SSE agent_start：新一轮开始后恢复 running",
    input: {
      search: "?session=s1",
      api: { runningSessionIds: ["s1"], awaitingInputSessionIds: [] },
      row: makeRow({ running: true }),
      sseEvents: ["agent_end", "agent_start"],
    },
    check: (out) => out.running === true && out.doneSeq === 1,
  },
];

let failed = 0;
for (const item of cases) {
  const out = await run(item.input);
  const ok = item.check(out);
  console.log(`${ok ? "✓" : "✗"} ${item.label}: ${JSON.stringify(out)}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log("页签状态探测脚本检查通过");
