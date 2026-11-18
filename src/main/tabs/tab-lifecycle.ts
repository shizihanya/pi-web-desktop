/**
 * 页面生命周期状态机（第六阶段，纯逻辑）。
 *
 * 明确区分 Loading / Ready / Crashed / Recovering / Destroyed，避免把「渲染进程崩溃」
 * 当成普通 reload 或直接销毁页签。状态转换全是纯函数，可在 Node 里回归
 * （scripts/check-tab-lifecycle.mjs），主进程只负责把结果落到页签栏与 WebContentsView。
 *
 * 规则：
 *  - 崩溃保留页签、保留会话 URL、停掉状态探测，不自动重载、不销毁、不停服务；
 *  - 只有用户显式触发恢复才进入 Recovering；
 *  - 重载完成（did-finish-load）后回到 Ready 并重新安装桌面增强；
 *  - 恢复前先验证服务端仍在运行，失败则回到 Crashed 并给出原因。
 */

export type TabPhase = "loading" | "ready" | "crashed" | "recovering" | "destroyed";

export interface TabLifecycleState {
  phase: TabPhase;
  /** render-process-gone 的 reason，或恢复失败的原因 */
  crashReason: string | null;
}

export const INITIAL_TAB_LIFECYCLE: TabLifecycleState = {
  phase: "loading",
  crashReason: null,
};

export function isCrashed(state: TabLifecycleState): boolean {
  return state.phase === "crashed" || state.phase === "recovering";
}

/** 是否允许（用户显式）触发恢复；Recovering 期间重复点击不该重复 loadURL */
export function canRecover(state: TabLifecycleState): boolean {
  return state.phase === "crashed";
}

export function onDidStartLoading(state: TabLifecycleState): TabLifecycleState {
  // 崩溃 / 恢复中的页签不该被普通加载事件悄悄改回 loading
  if (state.phase === "crashed" || state.phase === "recovering" || state.phase === "destroyed") {
    return state;
  }
  return { phase: "loading", crashReason: null };
}

export function onDidFinishLoad(state: TabLifecycleState): TabLifecycleState {
  if (state.phase === "destroyed") return state;
  // 恢复完成；或页面自己重新加载成功（崩溃后渲染进程自愈）都算 Ready
  return { phase: "ready", crashReason: null };
}

export function onRenderProcessGone(
  state: TabLifecycleState,
  reason: string,
): TabLifecycleState {
  if (state.phase === "destroyed") return state;
  return { phase: "crashed", crashReason: reason || "unknown" };
}

export function beginRecovery(state: TabLifecycleState): TabLifecycleState {
  if (!canRecover(state)) return state;
  return { phase: "recovering", crashReason: state.crashReason };
}

export function finishRecovery(state: TabLifecycleState): TabLifecycleState {
  if (state.phase !== "recovering") return state;
  return { phase: "ready", crashReason: null };
}

export function failRecovery(state: TabLifecycleState, reason: string): TabLifecycleState {
  if (state.phase !== "recovering") return state;
  return { phase: "crashed", crashReason: reason || "unknown" };
}

export function markDestroyed(state: TabLifecycleState): TabLifecycleState {
  return { phase: "destroyed", crashReason: state.crashReason };
}

/** 崩溃时页签栏显示的标题（保留会话 URL，不覆盖 path） */
export function crashTitle(reason: string | null): string {
  return `页面崩溃（${reason ?? "unknown"}）`;
}
