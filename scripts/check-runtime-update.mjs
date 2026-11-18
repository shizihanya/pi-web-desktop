#!/usr/bin/env node
/**
 * Runtime 更新失败恢复的纯决策回归（第七阶段）。
 * 覆盖：registry 不可用 / 多实例占用 / npm 安装失败但版本未变 / 半更新 /
 *       更新成功但启动失败 / 旧版本未知 / 回滚成功 / 回滚失败 / 回滚后校验失败。
 * 不真的执行 npm，只验证「要不要回滚」和「给用户什么结论」。
 *
 *   npm run check:runtime-update
 */
import {
  planRollback,
  rollbackNote,
  withRollbackNote,
} from "../src/main/server/runtime-update.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const attempt = (overrides = {}) => ({
  current: "0.17.0",
  target: "0.18.0",
  installed: "0.17.0",
  installStarted: false,
  stopped: false,
  ...overrides,
});

/* ------------------------- 不需要回滚的场景 ------------------------- */
{
  const plan = planRollback(attempt({ installStarted: false, stopped: false }));
  check("registry 不可用（还没动全局包、服务未停）→ 不回滚、不停服务", plan.needed === false);
  check("该场景不追加回滚说明", rollbackNote(plan, "not-needed") === "");
}
{
  const plan = planRollback(attempt({ installStarted: false, stopped: true }));
  check("发现多个 pi-web 实例占用（服务已停但包没动）→ 不回滚，只需重启服务", plan.needed === false);
}
{
  const plan = planRollback(attempt({ installStarted: true, installed: "0.17.0" }));
  check("npm install 失败但版本仍等于旧版本 → 不回滚", plan.needed === false, JSON.stringify(plan));
}

/* ------------------------- 需要回滚的场景 ------------------------- */
{
  const plan = planRollback(attempt({ installStarted: true, installed: null, stopped: true }));
  check("半更新（解析不到版本）→ 尝试回滚并验证", plan.needed === true && plan.version === "0.17.0");
}
{
  const plan = planRollback(attempt({ installStarted: true, installed: "0.18.0", stopped: true }));
  check("更新成功但服务启动失败 → 尝试回滚旧版本", plan.needed === true && plan.version === "0.17.0");
  const verified = rollbackNote(plan, "verified");
  check("回滚验证通过才说「已恢复并验证」", verified.includes("已把全局包恢复并验证") && verified.includes("0.17.0"), verified);
  const failedInstall = rollbackNote(plan, "install-failed");
  check("npm 回滚失败 → 给可执行的手动命令", failedInstall.includes("npm i -g @agegr/pi-web@0.17.0"), failedInstall);
  const unverified = rollbackNote(plan, "verification-failed");
  check("回滚后版本校验不通过 → 明确不能确认旧版本完整", unverified.includes("不能确认旧版本完整"), unverified);
}
{
  const plan = planRollback(attempt({ current: null, installStarted: true, installed: "0.18.0" }));
  check("更新前版本未知 → 不声称已回滚", plan.needed === false);
  check("文案明确说明无法验证旧版本", rollbackNote(plan, "not-needed").includes("无法验证"), rollbackNote(plan, "not-needed"));
}

/* ------------------------- 文案组装 ------------------------- */
check("空 note 不改变原始失败信息", withRollbackNote("更新失败：xxx", "") === "更新失败：xxx");
check("有 note 时追加到失败信息", withRollbackNote("更新失败：xxx", "；已把全局包恢复并验证到 v0.17.0") === "更新失败：xxx；已把全局包恢复并验证到 v0.17.0");

if (failed) process.exit(1);
console.log("Runtime 更新恢复决策检查通过");
