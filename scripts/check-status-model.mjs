#!/usr/bin/env node
/**
 * 页签状态计算的纯逻辑回归（status-model.ts）。
 * 不发请求、不起 Electron，验证「一份全局快照 + 每页签 sessionId」的正确性：
 *  - running / awaiting / subagents / idle
 *  - 多页签状态互不干扰
 *  - 接口失败保留最后一次有效状态，不把未知当成 idle
 *  - 结构不符的返回值不会被当成有效数据
 *
 *   npm run check:status-model
 */
import {
  GLOBAL_STATUS_STALE_MS,
  computeTabActivity,
  parseGlobalStatus,
  parseTabSession,
} from "../src/main/tabs/status-model.ts";

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(actual)}`}`);
  if (!ok) failed += 1;
}

const snapshot = (overrides = {}) => ({
  runningSessionIds: ["s1"],
  awaitingInputSessionIds: ["s2"],
  subagentsActiveSessionIds: ["s3"],
  at: 1_000,
  ready: true,
  ok: true,
  ...overrides,
});
const session = (id, overrides = {}) => ({
  sessionId: id,
  sessionSource: id ? "url" : null,
  domRunning: false,
  domAwaiting: false,
  hasSelectedRow: false,
  pageReady: true,
  ...overrides,
});
const activity = (out) => ({
  running: out.running,
  awaiting: out.awaiting,
  unknown: out.unknown,
  source: out.source,
  stale: out.stale,
});

/* ------------------------- 输入校验 ------------------------- */
check("parseGlobalStatus 接受合法快照", parseGlobalStatus(snapshot()) !== null, true);
check("parseGlobalStatus 拒绝缺少数组的返回", parseGlobalStatus({ ready: true, ok: true }) === null, true);
check("parseGlobalStatus 拒绝带 error 的返回", parseGlobalStatus({ error: "x" }) === null, true);
check("parseTabSession 接受合法会话", parseTabSession(session("s1")) !== null, true);
check("parseTabSession 拒绝类型不符", parseTabSession({ sessionId: 42, domRunning: false }) === null, true);

/* ------------------------- 状态折算 ------------------------- */
const snap = snapshot();
check(
  "running：runningSessionIds 命中",
  activity(computeTabActivity(snap, session("s1"), { running: false, awaiting: false }, 1_100)),
  { running: true, awaiting: false, unknown: false, source: "api", stale: false },
);
check(
  "awaiting：awaitingInputSessionIds 命中",
  activity(computeTabActivity(snap, session("s2"), { running: false, awaiting: false }, 1_100)),
  { running: false, awaiting: true, unknown: false, source: "api", stale: false },
);
check(
  "subagentsActiveSessionIds 也算 running",
  activity(computeTabActivity(snap, session("s3"), { running: false, awaiting: false }, 1_100)),
  { running: true, awaiting: false, unknown: false, source: "api", stale: false },
);
check(
  "idle：会话不在任何列表里",
  activity(computeTabActivity(snap, session("s4"), { running: true, awaiting: false }, 1_100)),
  { running: false, awaiting: false, unknown: false, source: "api", stale: false },
);
check(
  "4 个页签共用同一份快照、状态互不干扰",
  ["s1", "s2", "s3", "s4"].map(
    (id) => computeTabActivity(snap, session(id), { running: false, awaiting: false }, 1_100).running,
  ),
  [true, false, true, false],
);
check(
  "空会话 id 不误命中任何列表",
  activity(computeTabActivity(snap, session(null), { running: true, awaiting: false }, 1_100)),
  { running: false, awaiting: false, unknown: false, source: "api", stale: false },
);
check(
  "DOM 逐行兜底与全局快照取并集",
  activity(
    computeTabActivity(
      snap,
      session("s4", { domAwaiting: true }),
      { running: false, awaiting: false },
      1_100,
    ),
  ),
  { running: false, awaiting: true, unknown: false, source: "api", stale: false },
);

/* ------------------------- 失败 / 未知 / 降级 ------------------------- */
check(
  "最近一次请求失败：沿用最后一次有效快照（不清成 idle）",
  activity(
    computeTabActivity(
      snapshot({ ok: false }),
      session("s1"),
      { running: true, awaiting: false },
      1_100,
    ),
  ),
  { running: true, awaiting: false, unknown: false, source: "api", stale: true },
);
check(
  "接口从未成功：用侧栏逐行状态兜底",
  activity(
    computeTabActivity(
      null,
      session("s1", { hasSelectedRow: true, domRunning: true }),
      { running: false, awaiting: false },
      1_100,
    ),
  ),
  { running: true, awaiting: false, unknown: false, source: "dom", stale: true },
);
check(
  "没有任何依据：unknown=true 且保留上一轮 running，绝不误报 idle",
  activity(
    computeTabActivity(null, session("s1"), { running: true, awaiting: true }, 1_100),
  ),
  { running: true, awaiting: true, unknown: true, source: "retained", stale: true },
);
check(
  "快照 long-stale：转为未知并保留上一轮，而不是拿过期数组当真",
  activity(
    computeTabActivity(
      snapshot({ ok: false }),
      session("s1"),
      { running: true, awaiting: false },
      1_000 + GLOBAL_STATUS_STALE_MS + 1,
    ),
  ),
  { running: true, awaiting: false, unknown: true, source: "retained", stale: true },
);
check(
  "页面已初始化但没有选中行/接口：判定为未知",
  activity(
    computeTabActivity(
      null,
      session("s1", { pageReady: true }),
      { running: false, awaiting: false },
      1_100,
    ),
  ),
  { running: false, awaiting: false, unknown: true, source: "retained", stale: true },
);

if (failed) process.exit(1);
console.log("页签状态计算逻辑检查通过");
