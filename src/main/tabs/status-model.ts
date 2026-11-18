/**
 * 页签状态计算的纯逻辑：把「一份全局运行状态快照」+「每个页签自己的会话」
 * 折算成该页签的 running / awaiting。
 *
 * 这里不 import electron / Node API，也不发请求，方便 scripts/check-status-model.mjs
 * 在 Node 里直接跑回归。主进程 TabManager 负责取快照、算会话、再落到页签栏状态。
 *
 * 关键约束：
 *  - 全局快照在接口失败时保留「最后一次有效状态」，不能把一次失败当成 idle。
 *  - 快照可用时完全以 API 的会话列表为准；DOM 状态只在 API 不可用时兜底，
 *    避免后台页签 DOM 滞后（对话已完成但 DOM 仍转圈）把页签钉死在 running。
 *  - 完全没有依据（接口从未成功、DOM 兜底也不可用）时返回 unknown，
 *    由主进程保留上一轮状态，绝不把未知当成 idle。
 *  - 每个页签只用自己的 sessionId 去查全局数组，页签之间互不干扰。
 */

import type { GlobalStatusSnapshot, TabSessionProbe } from "./tab-status";

/** 超过这个时长仍连续失败：不再假装全局快照可信，转为 unknown（保留上一轮） */
export const GLOBAL_STATUS_STALE_MS = 15_000;

export interface TabActivity {
  running: boolean;
  awaiting: boolean;
  /** true = 没有可信依据；调用方应保留上一轮状态而不是据此设为 idle */
  unknown: boolean;
  /** 本次判定的依据，供日志与兼容性检测使用 */
  source: "api" | "dom" | "retained";
  /** 用的是最后一次有效快照（最近一次请求失败或已过期） */
  stale: boolean;
}

export interface PreviousActivity {
  running: boolean;
  awaiting: boolean;
}

const EMPTY_PREVIOUS: PreviousActivity = { running: false, awaiting: false };

/** 校验页面 realm 传回来的全局快照；结构不对时返回 null（契约破坏，不做猜测） */
export function parseGlobalStatus(raw: unknown): GlobalStatusSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.error === "string") return null;
  if (
    !Array.isArray(data.runningSessionIds) ||
    !Array.isArray(data.awaitingInputSessionIds) ||
    !Array.isArray(data.subagentsActiveSessionIds) ||
    typeof data.ready !== "boolean" ||
    typeof data.ok !== "boolean"
  ) {
    return null;
  }
  const strings = (list: unknown[]): string[] =>
    list.filter((value): value is string => typeof value === "string");
  return {
    runningSessionIds: strings(data.runningSessionIds),
    awaitingInputSessionIds: strings(data.awaitingInputSessionIds),
    subagentsActiveSessionIds: strings(data.subagentsActiveSessionIds),
    at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0,
    ready: data.ready,
    ok: data.ok,
  };
}

/** 校验页面 realm 传回来的会话探测结果 */
export function parseTabSession(raw: unknown): TabSessionProbe | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.error === "string") return null;
  if (
    (data.sessionId !== null && typeof data.sessionId !== "string") ||
    typeof data.domRunning !== "boolean" ||
    typeof data.domAwaiting !== "boolean"
  ) {
    return null;
  }
  return {
    sessionId: data.sessionId as string | null,
    sessionSource:
      data.sessionSource === "url" || data.sessionSource === "dom" ? data.sessionSource : null,
    domRunning: data.domRunning,
    domAwaiting: data.domAwaiting,
    hasSelectedRow: data.hasSelectedRow === true,
    pageReady: data.pageReady === true,
  };
}

export function computeTabActivity(
  snapshot: GlobalStatusSnapshot | null,
  session: TabSessionProbe,
  previous: PreviousActivity = EMPTY_PREVIOUS,
  now = Date.now(),
): TabActivity {
  const stale =
    snapshot !== null && (snapshot.ok === false || now - snapshot.at > GLOBAL_STATUS_STALE_MS);
  // 快照可用 = 至少成功过一次，且失败时间没有长到足以认为它已经失真
  const usable =
    snapshot !== null && snapshot.ready && !(snapshot.ok === false && now - snapshot.at > GLOBAL_STATUS_STALE_MS);

  if (usable) {
    // 全局快照可用时完全以 API 状态为准：后台页签的 DOM 可能滞后
    //（对话已结束但 DOM 仍显示转圈），与 API 做 OR 合并会让页签永远 running。
    // domRunning / domAwaiting 只在 API 不可用时作为兜底（见下方 dom 分支）。
    const id = session.sessionId;
    const has = (list: string[]): boolean => !!id && list.indexOf(id) !== -1;
    return {
      running:
        has(snapshot.runningSessionIds) || has(snapshot.subagentsActiveSessionIds),
      awaiting: has(snapshot.awaitingInputSessionIds),
      unknown: false,
      source: "api",
      stale,
    };
  }

  // 接口从未成功：只用页签自己的侧栏逐行状态兜底（旧行为）
  if (session.hasSelectedRow || session.domRunning || session.domAwaiting) {
    return {
      running: session.domRunning,
      awaiting: session.domAwaiting,
      unknown: false,
      source: "dom",
      stale: true,
    };
  }

  // 登录页 / 页面还没初始化 / 上游 DOM 结构已变：没有依据，保留上一轮
  return {
    running: previous.running,
    awaiting: previous.awaiting,
    unknown: true,
    source: "retained",
    stale: true,
  };
}
