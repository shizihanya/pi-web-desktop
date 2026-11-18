/**
 * Runtime 更新失败恢复的纯决策（第七阶段：只审查 + 加固，不引入多版本 Runtime）。
 *
 * pi-web 走全局 npm 安装，桌面端更新也会更新全局包，因此会影响终端里使用的 pi-web。
 * 本模块只回答两个问题（不执行 npm、不碰服务，方便在 Node 里回归）：
 *  1. 这次失败要不要尝试恢复更新前的版本？
 *  2. 恢复之后该给用户什么结论（必须验证旧版本确实完整保留，不能含糊说「已回滚」）？
 */

export interface UpdateAttempt {
  /** 更新前解析到的版本；null = 没能确定旧版本 */
  current: string | null;
  /** 目标版本 */
  target: string | null;
  /** 安装后实际解析到的版本；null = 没解析成功 */
  installed: string | null;
  /** 是否真的执行过 npm install -g（全局包可能已被改动） */
  installStarted: boolean;
  /** 服务是否已被停止 */
  stopped: boolean;
}

export interface RollbackPlan {
  needed: boolean;
  version: string | null;
  reason: string;
}

export type RollbackOutcome = "not-needed" | "verified" | "install-failed" | "verification-failed";

export function planRollback(attempt: UpdateAttempt): RollbackPlan {
  if (!attempt.installStarted) {
    return { needed: false, version: null, reason: "全局包未被改动，无需回滚" };
  }
  if (!attempt.current) {
    return {
      needed: false,
      version: null,
      reason: "更新前版本未知，无法验证旧版本是否完整保留，不声称已回滚",
    };
  }
  if (attempt.installed === attempt.current) {
    return {
      needed: false,
      version: null,
      reason: `全局包仍是 v${attempt.current}，版本未变`,
    };
  }
  return {
    needed: true,
    version: attempt.current,
    reason: "全局包已被改动，尝试恢复更新前版本并验证",
  };
}

/** 回滚结论必须明确区分「验证通过」和「未验证」，绝不把失败写成成功 */
export function rollbackNote(plan: RollbackPlan, outcome: RollbackOutcome): string {
  if (!plan.needed) {
    return plan.reason.includes("无法验证")
      ? `；${plan.reason}`
      : "";
  }
  const version = plan.version ?? "旧版本";
  if (outcome === "not-needed") {
    return `；未执行回滚（${plan.reason}）`;
  }
  if (outcome === "verified") {
    return `；已把全局包恢复并验证到 v${version}`;
  }
  if (outcome === "install-failed") {
    return `；尝试恢复 v${version} 的 npm 安装失败，请手动执行 npm i -g @agegr/pi-web@${version}`;
  }
  return `；恢复 v${version} 后版本校验未通过，不能确认旧版本完整，请手动检查 npm root -g 与已安装版本`;
}

export function withRollbackNote(base: string, note: string): string {
  return note ? `${base}${note}` : base;
}
