#!/usr/bin/env node
/**
 * 页面生命周期状态机回归（第六阶段）。纯逻辑，不启动 Electron。
 * 覆盖：Loading/Ready/Crashed/Recovering/Destroyed 转换、崩溃保留 URL 的语义、
 *       恢复期间不重复重载、恢复失败回到 Crashed、销毁后不再被加载事件改写。
 *
 *   npm run check:lifecycle
 */
import {
  INITIAL_TAB_LIFECYCLE,
  beginRecovery,
  canRecover,
  crashTitle,
  failRecovery,
  finishRecovery,
  isCrashed,
  markDestroyed,
  onDidFinishLoad,
  onDidStartLoading,
  onRenderProcessGone,
} from "../src/main/tabs/tab-lifecycle.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const initial = () => ({ ...INITIAL_TAB_LIFECYCLE });

/* ------------------------- 正常加载 ------------------------- */
{
  const s = onDidFinishLoad(onDidStartLoading(initial()));
  check("Loading → Ready", s.phase === "ready" && s.crashReason === null);
  check("Ready 页签不显示崩溃标记", isCrashed(s) === false && canRecover(s) === false);
}
{
  const s = onDidStartLoading(initial());
  check("重复 did-start-loading 保持 Loading", s.phase === "loading");
}

/* ------------------------- 崩溃 ------------------------- */
{
  const crashed = onRenderProcessGone(initial(), "crashed");
  check("渲染进程崩溃 → Crashed，记录原因", crashed.phase === "crashed" && crashed.crashReason === "crashed");
  check("崩溃后允许显式恢复", canRecover(crashed) === true);
  check("崩溃标记（含 Recovering）用于页签栏提示", isCrashed(crashed) === true);
  check("崩溃标题保留原因", crashTitle(crashed.crashReason) === "页面崩溃（crashed）");
  check(
    "崩溃后普通加载事件不会悄悄改回 Loading（不盲目自动重载）",
    onDidStartLoading(crashed).phase === "crashed",
  );
  const noReload = beginRecovery(beginRecovery(crashed));
  check("恢复期间重复触发不会二次 loadURL", noReload.phase === "recovering" && canRecover(noReload) === false);
}

/* ------------------------- 恢复 ------------------------- */
{
  const crashed = onRenderProcessGone(initial(), "oom");
  const recovering = beginRecovery(crashed);
  check("Crashed → Recovering，保留崩溃原因供诊断", recovering.phase === "recovering" && recovering.crashReason === "oom");
  check("Recovering 也算 crashed（页签栏仍提示）", isCrashed(recovering) === true);
  const done = onDidFinishLoad(recovering);
  check("恢复完成 → Ready，清除崩溃原因", done.phase === "ready" && done.crashReason === null && isCrashed(done) === false);
  const failedRecovery = failRecovery(beginRecovery(crashed), "服务未就绪");
  check(
    "服务未应答：回到 Crashed 并记录原因，可再次尝试",
    failedRecovery.phase === "crashed" &&
      failedRecovery.crashReason === "服务未就绪" &&
      canRecover(failedRecovery) === true,
  );
  check("finishRecovery 对非 Recovering 状态是 no-op", finishRecovery(crashed).phase === "crashed");
}

/* ------------------------- 自愈 / 销毁 ------------------------- */
{
  const crashed = onRenderProcessGone(initial(), "killed");
  const selfHealed = onDidFinishLoad(crashed);
  check("渲染进程自愈并加载完成 → Ready", selfHealed.phase === "ready" && selfHealed.crashReason === null);
}
{
  const destroyed = markDestroyed(onRenderProcessGone(initial(), "crashed"));
  check("Destroyed 是终态", destroyed.phase === "destroyed");
  check("Destroyed 后加载 / 完成事件不再改写状态", onDidStartLoading(destroyed).phase === "destroyed" && onDidFinishLoad(destroyed).phase === "destroyed");
  check("Destroyed 后崩溃事件也不再改写", onRenderProcessGone(destroyed, "again").phase === "destroyed");
  check("Destroyed 不可恢复", canRecover(destroyed) === false);
}
check("未知原因也有可读标题", crashTitle(null) === "页面崩溃（unknown）");

if (failed) process.exit(1);
console.log("页面生命周期状态机检查通过");
