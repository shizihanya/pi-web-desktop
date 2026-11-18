#!/usr/bin/env node
/**
 * 页签状态注入脚本的回归检查：不启动 Electron，把 String.raw 脚本抽出来在模拟页面里跑。
 *
 * 锁住几条关键契约 / 回归：
 *  1. 每个页面只提供 sessionId / DOM 兜底，**绝不**读 `pi-web:unread-session-ids`
 *     （跨页签共享的全局未读集合，会让所有页签一起亮提示点）。
 *  2. 全局状态脚本装在所有页面上，但**安装时绝不发请求**：
 *     N 个页签只有被主进程选为状态源的那个页面会 fetch /api/agent/running。
 *  3. 缓存新鲜 / 上一次请求未结束时不再启动新请求。
 *  4. 接口失败或返回结构变化时保留最后一次有效状态，不把未知当成 idle。
 *  5. 所有脚本语法正确（历史上 String.raw / 正则转义把脚本写坏过）。
 *
 *   npm run check:status
 */
import fs from "node:fs";

const src = fs.readFileSync("src/main/tabs/tab-status.ts", "utf8");
function extract(name) {
  const match = new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`).exec(src);
  if (!match) throw new Error(`${name} 未找到`);
  return match[1];
}

const scripts = {
  sessionProbe: extract("TAB_SESSION_PROBE_SCRIPT"),
  sessionRead: extract("TAB_SESSION_READ_SCRIPT"),
  globalProbe: extract("GLOBAL_STATUS_PROBE_SCRIPT"),
  globalRead: extract("GLOBAL_STATUS_READ_SCRIPT"),
};
for (const [name, code] of Object.entries(scripts)) {
  try {
    new Function(code);
  } catch (error) {
    console.error(`✗ ${name} 脚本语法错误：${error.message}`);
    process.exit(1);
  }
}
console.log("✓ 4 段注入脚本语法正确");

let failed = 0;
function check(label, fn) {
  try {
    const ok = fn();
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`✗ ${label}：${error.message}`);
    failed += 1;
  }
}
async function checkAsync(label, fn) {
  try {
    const ok = await fn();
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`✗ ${label}：${error.message}`);
    failed += 1;
  }
}

/* ------------------------- 页签会话探测 ------------------------- */

function makeRow({ key = "session:group:dom-id", running = false, awaiting = false } = {}) {
  return {
    getAttribute: (name) => (name === "data-row-key" ? key : null),
    classList: { contains: (cls) => cls === "is-running" && running },
    querySelector: (sel) => (sel === ".session-tree-awaiting" && awaiting ? {} : null),
  };
}

function runSession({ search = "", row = null, readyState = "complete" } = {}) {
  let unreadReads = 0;
  globalThis.window = {
    location: { search },
    localStorage: {
      getItem: () => {
        unreadReads += 1;
        return null;
      },
      setItem: () => {},
    },
  };
  globalThis.document = {
    readyState,
    body: {},
    querySelector: (sel) =>
      sel === ".session-tree-row.session-tree-session.is-selected" ? row : null,
  };
  new Function(scripts.sessionProbe)();
  const raw = new Function(`return ${scripts.sessionRead}`)();
  return { ...JSON.parse(raw), unreadReads };
}

check("URL 会话优先；绝不读全局未读 localStorage", () => {
  const out = runSession({ search: "?session=s1", row: makeRow({ running: true }) });
  return (
    out.sessionId === "s1" &&
    out.sessionSource === "url" &&
    out.domRunning === true &&
    out.hasSelectedRow === true &&
    out.pageReady === true &&
    out.unreadReads === 0
  );
});

check("URL 无 session：侧栏选中行 data-row-key 兜底", () => {
  const out = runSession({ search: "", row: makeRow() });
  return out.sessionId === "dom-id" && out.sessionSource === "dom";
});

check("侧栏逐行状态兜底（awaiting / running）", () => {
  const out = runSession({ search: "?session=s1", row: makeRow({ running: true, awaiting: true }) });
  return out.domRunning === true && out.domAwaiting === true;
});

check("页面未加载完成：pageReady=false，不冒充已初始化", () => {
  const out = runSession({ search: "?session=s1", readyState: "loading" });
  return out.pageReady === false && out.sessionId === "s1";
});

check("上游 DOM 结构变化：没有选中行也没有 URL session → 明确报告无依据", () => {
  const out = runSession({ search: "" });
  return out.sessionId === null && out.hasSelectedRow === false && out.pageReady === true;
});

/* ------------------------- 全局状态请求共享 ------------------------- */

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;
let fetchCalls = 0;
let fetchImpl = async () => ({
  ok: true,
  json: async () => ({
    runningSessionIds: ["s1"],
    awaitingInputSessionIds: [],
    subagentsActiveSessionIds: [],
  }),
});
globalThis.fetch = async () => {
  fetchCalls += 1;
  return fetchImpl();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function installGlobalRealm() {
  globalThis.window = {};
  new Function(scripts.globalProbe)();
  return globalThis.window.__piDesktopGlobalStatus;
}
function readGlobal(probe) {
  globalThis.window = { __piDesktopGlobalStatus: probe };
  return JSON.parse(new Function(`return ${scripts.globalRead}`)());
}

let realms = [];
await checkAsync("4 个页面 realm 安装全局脚本 → 0 次接口请求（关键）", async () => {
  fetchCalls = 0;
  realms = [installGlobalRealm(), installGlobalRealm(), installGlobalRealm(), installGlobalRealm()];
  await settle();
  return realms.every((probe) => probe && typeof probe.read === "function") && fetchCalls === 0;
});

await checkAsync("只有状态源页面发出 1 次请求，其余页面不发", async () => {
  fetchCalls = 0;
  const result = readGlobal(realms[0]);
  await settle();
  const after = readGlobal(realms[0]);
  await settle();
  return (
    result.ready === false &&
    result.runningSessionIds.length === 0 &&
    after.ready === true &&
    after.ok === true &&
    after.runningSessionIds[0] === "s1" &&
    fetchCalls === 1
  );
});

await checkAsync("缓存新鲜时不重复请求；TTL 过后才再请求一次", async () => {
  fetchCalls = 0;
  readGlobal(realms[0]);
  await settle();
  const immediate = fetchCalls;
  clock += 1_000;
  readGlobal(realms[0]);
  await settle();
  return immediate === 0 && fetchCalls === 1;
});

await checkAsync("上一次请求未结束时不启动第二次请求（in-flight 保护）", async () => {
  fetchCalls = 0;
  let release;
  fetchImpl = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          json: async () => ({
            runningSessionIds: ["s2"],
            awaitingInputSessionIds: [],
            subagentsActiveSessionIds: [],
          }),
        });
    });
  clock += 1_000;
  readGlobal(realms[1]);
  clock += 1_000;
  readGlobal(realms[1]);
  await settle();
  const during = fetchCalls;
  release();
  await settle();
  return during === 1 && fetchCalls === 1;
});

await checkAsync("接口失败：ok=false，但最后一次有效数组仍保留，不清成 idle", async () => {
  fetchImpl = async () => {
    throw new Error("network down");
  };
  clock += 1_000;
  readGlobal(realms[0]);
  await settle();
  const out = readGlobal(realms[0]);
  return out.ok === false && out.ready === true && out.runningSessionIds[0] === "s1";
});

await checkAsync("返回结构异常：不覆盖缓存，也不抛错", async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ running: "oops" }) });
  clock += 1_000;
  readGlobal(realms[0]);
  await settle();
  const out = readGlobal(realms[0]);
  return out.ok === false && out.runningSessionIds[0] === "s1";
});

check("READ 脚本在脚本未安装时安全返回 null", () => {
  globalThis.window = {};
  const raw = new Function(`return ${scripts.globalRead}`)();
  return raw === '"null"' || raw === "null" || JSON.parse(raw) === null;
});

Date.now = realNow;
if (failed) process.exit(1);
console.log("页签状态探测脚本检查通过（全局状态请求已共享）");
