#!/usr/bin/env node
/**
 * TabStatusManager 的编排回归（第三阶段抽出的模块）。
 * 用 mock WebContents，不启动 Electron，验证：
 *  - 4 个页签一轮只有 1 份全局状态请求、每个页签只读自己的会话；
 *  - 页签状态互不干扰、状态变化才 onChanged；
 *  - 状态源关闭 / 连续失败后自动换源，且同一轮不重试出多份请求；
 *  - 接口失败保留最后有效快照、无依据时 unknown 保留上一轮；
 *  - 服务重启 reset() 后重新初始化。
 *
 *   npm run check:status-manager
 */
import { STATUS_SOURCE_MAX_FAILURES, TabStatusManager } from "../src/main/tabs/tab-status-manager.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const freshSnapshot = (overrides = {}) => ({
  runningSessionIds: ["s1"],
  awaitingInputSessionIds: ["s2"],
  subagentsActiveSessionIds: [],
  at: Date.now(),
  ready: true,
  ok: true,
  ...overrides,
});

function makeSource(key, sessionId, options = {}) {
  return {
    key,
    sessionId,
    running: false,
    awaiting: false,
    destroyed: false,
    globalCalls: 0,
    sessionCalls: 0,
    globalResponse: options.globalResponse ?? (() => JSON.stringify(freshSnapshot())),
    failGlobal: options.failGlobal ?? false,
    sessionResponse: options.sessionResponse ?? null,
    isDestroyed() {
      return this.destroyed;
    },
    async executeJavaScript(code) {
      if (code.includes("__piDesktopGlobalStatus")) {
        this.globalCalls += 1;
        if (this.failGlobal) throw new Error("executeJavaScript failed");
        return this.globalResponse();
      }
      if (code.includes("__piDesktopTabSession")) {
        this.sessionCalls += 1;
        if (this.sessionResponse) return this.sessionResponse();
        return JSON.stringify({
          sessionId: this.sessionId,
          sessionSource: this.sessionId ? "url" : null,
          domRunning: false,
          domAwaiting: false,
          hasSelectedRow: false,
          pageReady: true,
        });
      }
      return "null";
    },
  };
}

function harness(keys, options = {}) {
  const sources = keys.map((key, i) =>
    makeSource(key, options.sessionIds?.[i] ?? `s${i + 1}`, options.sourceOptions?.(key, i) ?? {}),
  );
  const probes = [];
  const verdicts = [];
  let changes = 0;
  const activeKey = { value: keys[0] };
  const last = new Map();
  const manager = new TabStatusManager({
    sources: () => sources,
    activeSourceKey: () => activeKey.value,
    onProbe: (key, probe) => {
      probes.push({ key, probe });
      const previous = last.get(key);
      last.set(key, probe.running);
      return previous !== probe.running;
    },
    onChanged: () => {
      changes += 1;
    },
    onCompatibility: (verdict) => verdicts.push(verdict),
  });
  return { sources, probes, verdicts, manager, activeKey, get changes() { return changes; } };
}

/* ------------------------- 请求共享 / 页签独立 ------------------------- */
{
  const h = harness(["A", "B", "C", "D"], { sessionIds: ["s1", "s2", "s3", "s4"] });
  await h.manager.refresh();
  check(
    "4 个页签一轮：全局请求 1 次、会话读取 4 次",
    h.sources.reduce((n, s) => n + s.globalCalls, 0) === 1 &&
      h.sources.reduce((n, s) => n + s.sessionCalls, 0) === 4,
    `global=${h.sources.map((s) => s.globalCalls).join(",")} session=${h.sources.map((s) => s.sessionCalls).join(",")}`,
  );
  check(
    "同一份全局快照 + 各自 sessionId → 页签状态互不干扰",
    h.probes.map((p) => p.probe.running).join(",") === "true,false,false,false" &&
      h.probes[1].probe.awaiting === true,
    h.probes.map((p) => `${p.key}:${p.probe.running}/${p.probe.awaiting}`).join(" "),
  );
  check("仅状态变化时 onChanged（4 页签首次都变化 → 1 次）", h.changes === 1, String(h.changes));
  const before = h.changes;
  await h.manager.refresh();
  check("状态未变化时不重复 notify", h.changes === before, String(h.changes));
  check(
    "compatible 结论来自实际接口结果",
    h.verdicts.at(-1).level === "compatible",
    JSON.stringify(h.verdicts.at(-1)),
  );
}

/* ------------------------- 状态源关闭 / 连续失败 ------------------------- */
{
  const h = harness(["A", "B", "C"]);
  await h.manager.refresh();
  const first = h.manager.currentSourceKey;
  h.sources[0].destroyed = true;
  h.manager.noteSourceClosed("A");
  await h.manager.refresh();
  check(
    "状态源被关闭后自动换到别的有效页面",
    h.manager.currentSourceKey !== first && h.manager.currentSourceKey !== null,
    `${first} → ${h.manager.currentSourceKey}`,
  );
  check(
    "换源后仍是每轮 1 份全局请求（没有补发重试）",
    h.sources.reduce((n, s) => n + s.globalCalls, 0) === 2,
    h.sources.map((s) => s.globalCalls).join(","),
  );
}
{
  const failingKey = "A";
  const h = harness(["A", "B", "C"], {
    sourceOptions: (key) => (key === failingKey ? { failGlobal: true } : {}),
  });
  // 第 1~3 轮累计 3 次失败，第 4 轮 pickSource 才会换源（换源发生在下一轮）
  for (let i = 0; i <= STATUS_SOURCE_MAX_FAILURES; i += 1) await h.manager.refresh();
  check(
    `连续失败 ${STATUS_SOURCE_MAX_FAILURES} 次后的下一轮换源`,
    h.manager.currentSourceKey !== "A",
    String(h.manager.currentSourceKey),
  );
  check(
    "失败期间只报 degraded、不静默当 compatible",
    h.verdicts.some((v) => v.level === "degraded"),
    JSON.stringify(h.verdicts.at(-1)),
  );
}
{
  const h = harness(["A", "B"]);
  const first = h.manager.refresh();
  const second = h.manager.refresh();
  await Promise.all([first, second]);
  check(
    "上一轮未结束时不重复启动（in-flight 保护）",
    h.sources.reduce((n, s) => n + s.globalCalls, 0) === 1,
    h.sources.map((s) => s.globalCalls).join(","),
  );
}

/* ------------------------- 失败保留 / unknown / reset ------------------------- */
{
  const stale = freshSnapshot({ ok: false });
  const h = harness(["A"], {
    sessionIds: ["s1"],
    sourceOptions: () => ({ globalResponse: () => JSON.stringify(stale) }),
  });
  await h.manager.refresh();
  check(
    "接口失败仍沿用最后一次有效数组，不把 running 清成 idle",
    h.probes[0]?.probe.running === true,
    JSON.stringify(h.probes[0]?.probe),
  );
  check(
    "接口失败如实报 degraded",
    h.verdicts.at(-1).level === "degraded",
    JSON.stringify(h.verdicts.at(-1)),
  );
}
{
  const never = freshSnapshot({ ready: false, ok: false, runningSessionIds: [], awaitingInputSessionIds: [] });
  const noEvidence = () =>
    JSON.stringify({
      sessionId: null,
      sessionSource: null,
      domRunning: false,
      domAwaiting: false,
      hasSelectedRow: false,
      pageReady: true,
    });
  const h = harness(["A"], {
    sourceOptions: () => ({ globalResponse: () => JSON.stringify(never), sessionResponse: noEvidence }),
  });
  await h.manager.refresh();
  check("无依据时 unknown：不调用 onProbe，保留上一轮而不是误报 idle", h.probes.length === 0, JSON.stringify(h.probes));
  check("无依据时兼容结论为 unverified / degraded", h.verdicts.at(-1).level !== "compatible", JSON.stringify(h.verdicts.at(-1)));
}
{
  const h = harness(["A", "B"]);
  await h.manager.refresh();
  h.manager.reset();
  check(
    "服务重启 reset()：快照与请求源都重新初始化",
    h.manager.currentSnapshot === null && h.manager.currentSourceKey === null,
  );
  check("reset() 把兼容结论标为 unverified", h.verdicts.at(-1).level === "unverified");
  await h.manager.refresh();
  check("reset() 后下一轮能正常工作", h.probes.length > 0);
}

if (failed) process.exit(1);
console.log("TabStatusManager 编排检查通过");
