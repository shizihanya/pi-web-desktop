/**
 * 功能级兼容性检测（不做版本号适配，不建 Adapter 框架）。
 *
 * 目标：pi-web 更新后，某个桌面增强不兼容时能**单独**被发现、单独降级，
 * 而不是静默失效或拖垮 pi-web 原生功能。
 *
 * 四个功能各有独立结论：
 *  - statusProbeCompatible：/api/agent/running 返回结构 + 会话定位契约
 *  - themeProbeCompatible ：CSS Variables / dataset.theme 契约
 *  - notificationCompatible：Notification / ServiceWorker / hasFocus Web API
 *  - composerCompatible   ：扩展输入框增强（当前版本已移除，见下）
 *
 * 判定只依据「实际探测结果」，不依据 pi-web 版本号；
 * 只看到选择器存在也不代表功能完全可用，结论只能是「契约未见破坏」，
 * 完整兼容性仍需跑 docs/development/pi-web-compatibility.md 的回归清单。
 *
 * 本文件是纯逻辑，不 import electron，可被 scripts/check-compat.mjs 直接测试。
 */

import type { GlobalStatusSnapshot, TabSessionProbe } from "./tab-status";

export type FeatureId = "statusProbe" | "themeProbe" | "notification" | "composer";

/** compatible=契约校验通过；degraded=降级到兜底；unverified=还没有依据；disabled=该增强关闭 */
export type CompatLevel = "compatible" | "degraded" | "unverified" | "disabled";

export interface CompatVerdict {
  level: CompatLevel;
  reason: string;
}

export interface FeatureCompatibility extends CompatVerdict {
  feature: FeatureId;
  checkedAt: number;
}

export interface CompatibilityReport {
  /** 仅记录，不参与任何兼容性判定 */
  piWebVersion: string | null;
  features: Record<FeatureId, FeatureCompatibility>;
}

/** 主题探测脚本的返回结构（结构等价即可，不 import theme-probe.ts 以免耦合注入脚本） */
export interface ThemeProbeLike {
  name?: string;
  scheme?: string;
  vars?: Record<string, string>;
  fromPage?: boolean;
  error?: string;
}

/** 通知补丁的返回结构 */
export interface NotificationPatchLike {
  hasNotification?: boolean;
  hasDocumentHasFocus?: boolean;
  hasServiceWorkerRegistration?: boolean;
  swPatchInstalled?: boolean;
  notificationWrapped?: boolean;
  focusPatchInstalled?: boolean;
  error?: string | null;
}

/** 主题同步依赖的 CSS 变量（少于 3 个就认为没读到真实主题） */
export const THEME_REQUIRED_VAR_COUNT = 3;

export function evaluateStatusProbe(
  snapshot: GlobalStatusSnapshot | null,
  session: TabSessionProbe | null,
): CompatVerdict {
  if (snapshot && snapshot.ready && snapshot.ok) {
    return { level: "compatible", reason: "/api/agent/running 返回结构有效" };
  }
  if (snapshot && snapshot.ready) {
    return {
      level: "degraded",
      reason: "全局状态接口最近一次请求失败，沿用最后一次有效快照",
    };
  }
  if (session?.hasSelectedRow || session?.sessionSource === "url") {
    return {
      level: "degraded",
      reason: "全局状态接口尚未成功，使用页面侧栏 / URL 会话兜底",
    };
  }
  if (session?.pageReady) {
    return {
      level: "unverified",
      reason: "页面已加载但既没有接口数据也没有会话定位依据（可能是上游 DOM/API 变化）",
    };
  }
  return { level: "unverified", reason: "页面尚未初始化，等待契约检测" };
}

export function evaluateThemeProbe(payload: ThemeProbeLike | null): CompatVerdict {
  if (!payload) return { level: "unverified", reason: "尚未读到主题探测结果" };
  if (payload.error) return { level: "disabled", reason: `主题探测脚本执行失败：${payload.error}` };
  const count = Object.keys(payload.vars ?? {}).length;
  if (payload.fromPage === true && count >= THEME_REQUIRED_VAR_COUNT) {
    return { level: "compatible", reason: `读到 ${count} 个 CSS 变量，保留当前主题` };
  }
  // 读不到变量时必须保留当前主题（refreshTheme 已经这么做），不影响 pi-web 显示
  return {
    level: "degraded",
    reason: "未读到足够的 CSS 变量（页面未加载完或上游改了变量名），保留当前主题缓存",
  };
}

export function evaluateNotificationPatch(
  result: NotificationPatchLike | null,
  options: { enabled: boolean } = { enabled: true },
): CompatVerdict {
  if (!options.enabled) {
    return { level: "disabled", reason: "通知增强已关闭（非 Windows 或环境变量禁用）" };
  }
  if (!result) return { level: "unverified", reason: "等待页面注入检测" };
  if (result.error) return { level: "disabled", reason: `通知补丁注入失败：${result.error}` };
  if (!result.hasNotification || !result.hasDocumentHasFocus) {
    return { level: "degraded", reason: "Notification / document.hasFocus Web API 缺失，保留上游实现" };
  }
  if (result.hasServiceWorkerRegistration && !result.swPatchInstalled) {
    return { level: "degraded", reason: "ServiceWorker 通知回落未安装，优先降级而不是改写上游实现" };
  }
  if (!result.notificationWrapped || !result.focusPatchInstalled) {
    return { level: "degraded", reason: "通知标题/焦点同步未完整安装，保留 pi-web 原生通知" };
  }
  return { level: "compatible", reason: "通知回落、焦点同步、标题包装均已幂等安装" };
}

/**
 * 扩展输入框增强：HEAD 提交 `25d37d5 Remove composer expand feature` 已把
 * src/main/tabs/composer-expand.ts、scripts/check-composer-expand.mjs 和 README 中的
 * 相关说明全部移除。当前代码没有任何输入框注入，因此该增强恒为 disabled，
 * pi-web 原生输入框始终可用。若以后重新引入，需同时实现契约检测与安全降级。
 */
export function evaluateComposer(): CompatVerdict {
  return {
    level: "disabled",
    reason: "扩展输入框功能已移除，当前版本无输入框注入；pi-web 原生输入框不受影响",
  };
}

/** 主进程里的轻量记录器：只在结论变化时回调，避免刷日志 */
export class CompatibilityTracker {
  private readonly features = new Map<FeatureId, FeatureCompatibility>();
  private readonly options: {
    piWebVersion?: string | null;
    onChange?: (result: FeatureCompatibility) => void;
  };

  constructor(options: {
    piWebVersion?: string | null;
    onChange?: (result: FeatureCompatibility) => void;
  } = {}) {
    this.options = options;
    this.set("composer", evaluateComposer());
    this.set("statusProbe", { level: "unverified", reason: "等待首次全局状态探测" });
    this.set("themeProbe", { level: "unverified", reason: "等待首次主题探测" });
    this.set("notification", { level: "unverified", reason: "等待页面注入检测" });
  }

  set(feature: FeatureId, verdict: CompatVerdict): void {
    const previous = this.features.get(feature);
    if (previous && previous.level === verdict.level && previous.reason === verdict.reason) return;
    const next: FeatureCompatibility = { feature, ...verdict, checkedAt: Date.now() };
    this.features.set(feature, next);
    this.options.onChange?.(next);
  }

  get(feature: FeatureId): FeatureCompatibility | undefined {
    return this.features.get(feature);
  }

  report(): CompatibilityReport {
    const features = {} as Record<FeatureId, FeatureCompatibility>;
    for (const [feature, value] of this.features) features[feature] = value;
    return { piWebVersion: this.options.piWebVersion ?? null, features };
  }
}
