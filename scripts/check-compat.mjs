#!/usr/bin/env node
/**
 * 功能级兼容性检测回归（src/main/tabs/compat.ts）。
 * 四个增强各自独立判定；不依据版本号，只依据实际探测结果。
 * 验证：检测通过 / 部分检测失败只降级相关增强 / 未知版本→未验证 /
 *       注入失败→disabled 但保留 pi-web 原生功能 / 上游通知实现变化→优先降级。
 *
 *   npm run check:compat
 */
import {
  CompatibilityTracker,
  evaluateComposer,
  evaluateNotificationPatch,
  evaluateStatusProbe,
  evaluateThemeProbe,
} from "../src/main/tabs/compat.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}
function verdict(label, actual, level) {
  check(label, actual.level === level, `得到 ${actual.level}，期望 ${level}`);
}

const snap = (overrides = {}) => ({
  runningSessionIds: [],
  awaitingInputSessionIds: [],
  subagentsActiveSessionIds: [],
  at: Date.now(),
  ready: true,
  ok: true,
  ...overrides,
});
const session = (overrides = {}) => ({
  sessionId: "s1",
  sessionSource: "url",
  domRunning: false,
  domAwaiting: false,
  hasSelectedRow: false,
  pageReady: true,
  ...overrides,
});
const notification = (overrides = {}) => ({
  hasNotification: true,
  hasDocumentHasFocus: true,
  hasServiceWorkerRegistration: true,
  swPatchInstalled: true,
  notificationWrapped: true,
  focusPatchInstalled: true,
  error: null,
  ...overrides,
});

/* ------------------------- statusProbeCompatible ------------------------- */
verdict("状态探测：接口结构有效 → compatible", evaluateStatusProbe(snap(), session()), "compatible");
verdict(
  "状态探测：最近一次请求失败 → degraded（沿用最后有效快照，不当 idle）",
  evaluateStatusProbe(snap({ ok: false }), session()),
  "degraded",
);
verdict(
  "状态探测：接口从未成功但会话可定位 → degraded（DOM/URL 兜底）",
  evaluateStatusProbe(null, session({ hasSelectedRow: true })),
  "degraded",
);
verdict(
  "未知 pi-web 版本 / 页面已加载但无依据 → unverified（做契约检测，不误报兼容）",
  evaluateStatusProbe(null, session({ sessionSource: null, sessionId: null })),
  "unverified",
);
verdict(
  "页面尚未初始化 → unverified",
  evaluateStatusProbe(null, session({ pageReady: false, sessionSource: null, sessionId: null })),
  "unverified",
);

/* ------------------------- themeProbeCompatible ------------------------- */
verdict(
  "主题：读到 CSS Variables → compatible",
  evaluateThemeProbe({ fromPage: true, vars: { "--bg": "#fff", "--text": "#000", "--accent": "#f00" } }),
  "compatible",
);
verdict(
  "主题：页面未加载完 / 上游改变量名 → degraded（保留当前主题，不影响 pi-web 显示）",
  evaluateThemeProbe({ fromPage: false, vars: {} }),
  "degraded",
);
verdict("主题：探测脚本执行失败 → disabled", evaluateThemeProbe({ error: "x" }), "disabled");
verdict("主题：尚无结果 → unverified", evaluateThemeProbe(null), "unverified");

/* ------------------------- notificationCompatible ------------------------- */
verdict(
  "通知：补丁完整安装 → compatible",
  evaluateNotificationPatch(notification(), { enabled: true }),
  "compatible",
);
verdict(
  "通知：上游移除 window.Notification → degraded（保留原生，不强行改写）",
  evaluateNotificationPatch(notification({ hasNotification: false }), { enabled: true }),
  "degraded",
);
verdict(
  "通知：上游改了 SW 通知实现、回落补丁没装上 → degraded",
  evaluateNotificationPatch(notification({ swPatchInstalled: false }), { enabled: true }),
  "degraded",
);
verdict(
  "通知：注入脚本报错 → disabled（不影响 pi-web 原生通知）",
  evaluateNotificationPatch(notification({ error: "boom" }), { enabled: true }),
  "disabled",
);
verdict(
  "通知：增强关闭（非 Windows / 环境变量） → disabled",
  evaluateNotificationPatch(notification(), { enabled: false }),
  "disabled",
);
verdict("通知：尚无结果 → unverified", evaluateNotificationPatch(null, { enabled: true }), "unverified");

/* ------------------------- composerCompatible ------------------------- */
const composer = evaluateComposer();
check(
  "扩展输入框增强已移除：恒为 disabled 且明确说明原生输入框不受影响",
  composer.level === "disabled" && composer.reason.includes("原生输入框"),
  JSON.stringify(composer),
);

/* ------------------------- 独立报告 / 去重 ------------------------- */
const changes = [];
const tracker = new CompatibilityTracker({
  piWebVersion: "0.17.0",
  onChange: (result) => changes.push(`${result.feature}:${result.level}`),
});
const initial = changes.length;
tracker.set("statusProbe", evaluateStatusProbe(snap(), session()));
tracker.set("themeProbe", evaluateThemeProbe({ fromPage: false, vars: {} }));
tracker.set("notification", evaluateNotificationPatch(notification({ error: "x" })));
const report = tracker.report();
check(
  "每个功能单独记录，互不影响",
  report.features.statusProbe.level === "compatible" &&
    report.features.themeProbe.level === "degraded" &&
    report.features.notification.level === "disabled" &&
    report.features.composer.level === "disabled",
  JSON.stringify(report.features),
);
check("版本号只记录、不参与判定", report.piWebVersion === "0.17.0");
const before = changes.length;
tracker.set("statusProbe", evaluateStatusProbe(snap(), session()));
check(
  "结论未变化时不重复回调（避免刷日志）",
  initial === 4 && changes.length === before,
  `initial=${initial} before=${before} after=${changes.length}`,
);

if (failed) process.exit(1);
console.log("功能级兼容性检测检查通过");
