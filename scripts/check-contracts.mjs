#!/usr/bin/env node
/**
 * 上游契约检查（第一阶段 P0：pi-web 更新后及时发现不兼容，而不是静默失效）。
 *
 * 两层检查，全程**只读**，绝不修改 pi-web 源码 / node_modules / 构建产物：
 *  1. 内部漂移：桌面端声明的依赖点是否还在自己的源码里（防止只改了一边）。
 *  2. 上游契约：如果本机装了 @agegr/pi-web，只读扫描它的 .next 构建，
 *     检查 API 路径/返回字段、URL 参数、DOM 选择器、CSS 变量、通知 Web API 是否还在。
 *
 * ⚠️ 这不是「完全兼容」证明：静态扫描只能发现明显的契约破坏，
 *    「仅凭选择器存在不能认定功能完全可用」。运行时还有 compat.ts 的功能级检测，
 *    升级后仍必须跑 docs/development/pi-web-compatibility.md 的回归清单。
 *
 *   npm run check:contracts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PACKAGE = "@agegr/pi-web";
const pass = (msg) => console.log(`\u001b[32m✓\u001b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exitCode = 1;
};
const info = (msg) => console.log(`\u001b[90m·\u001b[0m ${msg}`);

/** 与 smoke.mjs 一致的定位链，但只读：环境变量 → where/which → node 同级 → npm root -g */
function findPiWebRoot() {
  const candidates = [];
  const push = (script) => {
    if (script && existsSync(script)) candidates.push(dirname(dirname(script)));
  };
  const override = process.env.PI_WEB_DESKTOP_PI_WEB_ROOT;
  if (override) push(join(override, "bin", "pi-web.js"));

  const whichName = process.platform === "win32" ? "where" : "sh";
  const whichArgs = process.platform === "win32" ? ["pi-web"] : ["-lc", "command -v pi-web"];
  const which = spawnSync(whichName, whichArgs, { encoding: "utf8", windowsHide: true });
  for (const line of (which.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    push(join(dirname(line), "node_modules", PACKAGE, "bin", "pi-web.js"));
  }
  push(join(dirname(process.execPath), "node_modules", PACKAGE, "bin", "pi-web.js"));
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
    timeout: 20_000,
  });
  for (const line of (npm.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    push(join(line, PACKAGE, "bin", "pi-web.js"));
  }
  const root = candidates.find((dir) => existsSync(join(dir, "package.json")));
  if (!root) return null;
  try {
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return { root, version: String(version) };
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function filesUnder(root, relDir, pattern) {
  const dir = join(root, relDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}
/** 把所有候选文件拼起来找 needle，避开 .next 里带 hash 的文件名 */
function upstreamNeedles(root, groups) {
  let missing = [];
  let foundAny = false;
  for (const group of groups) {
    const files = filesUnder(root, group.dir, group.pattern);
    if (files.length) foundAny = true;
    const text = files.map(readText).join("\n");
    for (const needle of group.needles) {
      if (!text.includes(needle)) missing.push(needle);
    }
  }
  return { foundAny, missing };
}

const THEME_VARS = [
  "--bg:", "--bg-panel:", "--bg-hover:", "--bg-selected:", "--border:",
  "--text:", "--text-muted:", "--text-dim:", "--accent:", "--accent-hover:", "--accent-contrast:",
];

/**
 * 上游依赖清单（机器可读版；人类可读版见 docs/development/pi-web-compatibility.md）。
 * ours = 桌面端源码里必须存在的字符串；upstream = 上游构建里必须存在的字符串。
 */
const FEATURES = [
  {
    id: "urlContract",
    label: "会话定位 / 页签恢复",
    ours: [
      { file: "src/main/tabs/tab-status.ts", needles: ['.get("session")'] },
      { file: "scripts/smoke.mjs", needles: ["/?session="] },
    ],
    upstream: [
      {
        dir: ".next/static/chunks/app", pattern: /^page-.*\.js$/,
        needles: ["?session="],
      },
    ],
  },
  {
    id: "statusProbe",
    label: "Agent 状态（全局接口 + 侧栏兜底）",
    ours: [
      {
        file: "src/main/tabs/tab-status.ts",
        needles: [
          "/api/agent/running", "runningSessionIds", "awaitingInputSessionIds",
          "subagentsActiveSessionIds", ".session-tree-row.session-tree-session.is-selected",
          "data-row-key", "is-running", ".session-tree-awaiting",
        ],
      },
      {
        file: "src/main/tabs/status-model.ts",
        needles: ["runningSessionIds", "awaitingInputSessionIds", "subagentsActiveSessionIds"],
      },
    ],
    upstream: [
      {
        dir: ".next/server/app/api/agent/running", pattern: /^route\.js$/,
        needles: ["runningSessionIds", "awaitingInputSessionIds", "subagentsActiveSessionIds"],
      },
      {
        dir: ".next/static/chunks/app", pattern: /^page-.*\.js$/,
        needles: ["session-tree-session", "data-row-key", "is-running", "session-tree-awaiting"],
      },
    ],
  },
  {
    id: "themeProbe",
    label: "主题同步（CSS Variables）",
    ours: [
      { file: "src/main/tabs/theme-probe.ts", needles: ["dataset.theme", "pi-theme", ...THEME_VARS.map((v) => v.slice(0, -1))] },
    ],
    upstream: [
      { dir: ".next/static/css", pattern: /\.css$/, needles: THEME_VARS },
    ],
  },
  {
    id: "composer",
    label: "独立输入工作区（复用 pi-web 原生 Composer 发送）",
    ours: [
      {
        file: "src/main/tabs/composer-bridge.ts",
        needles: [
          ".chat-input-shell textarea.chat-input-textarea",
          "HTMLTextAreaElement.prototype",
          "dispatchEvent(new Event('input'",
          "__piDesktopDraftSending",
          "pi-enter-send-mode",
          "sessionKey",
          "getComputedStyle(ta)",
          "findButton(scope, 'steer')",
          "ClipboardEvent('paste'",
          "引导",
          "后续消息",
        ],
      },
      {
        file: "src/main/tabs/draft-model.ts",
        needles: ["sessionKeyFromPath", "verifyDraftTarget", "draftKey"],
      },
      {
        file: "src/main/tabs/draft-workspace.ts",
        needles: ["buildComposerSendScript", "COMPOSER_PROBE_SCRIPT", "evaluateComposer"],
      },
    ],
    upstream: [
      {
        dir: ".next/static/chunks/app", pattern: /^page-.*\.js$/,
        needles: ['className:"chat-input-textarea"', "chat.send", "chat-input-shell", "pi-enter-send-mode"],
      },
    ],
  },
  {
    id: "notification",
    label: "Windows 通知增强",
    ours: [
      {
        file: "src/main/tabs/notification-patch.ts",
        needles: [
          "showNotification",
          "window.Notification",
          "document.hasFocus",
          "__piDesktopWindowFocused",
          '__piDesktopNotificationBridge',
          'addEventListener("click"',
          'activeBridge.create',
        ],
      },
      {
        file: "src/preload/notification.ts",
        needles: [
          "notification:clicked",
          "notification:create",
          "notification:close",
          "notification:activated",
          "contextBridge.exposeInMainWorld",
          "ipcRenderer.sendSync",
        ],
      },
      {
        file: "src/main/ipc.ts",
        needles: ["NOTIFICATION_IPC.clicked", "registerNotificationIpc"],
      },
      {
        file: "src/main/tabs/tab-manager.ts",
        needles: ['join(__dirname, "../preload/notification.js")', "markNotificationClickSender"],
      },
      {
        file: "src/main/tabs/notification-host.ts",
        needles: [
          "handleActivation",
          "toastXml",
          "NOTIFICATION_IPC.activatedEvent",
          'details?.reason === "timedOut"',
        ],
      },
      {
        file: "src/main/tabs/notification-toast.ts",
        needles: ["<toast launch=", "escapeXml", "parseNotificationLaunchArguments"],
      },
    ],
    upstream: [
      { dir: ".next/static/chunks/app", pattern: /^page-.*\.js$/, needles: ["showNotification"] },
    ],
  },
];

let failures = 0;

/* ---------------- 1. 内部漂移（必须成立，与上游是否安装无关） ---------------- */
for (const feature of FEATURES) {
  const problems = [];
  for (const entry of feature.ours) {
    const text = readText(entry.file);
    if (!text) problems.push(`${entry.file} 不存在或不可读`);
    for (const needle of entry.needles) {
      if (!text.includes(needle)) problems.push(`${entry.file} 缺少 ${needle}`);
    }
  }
  if (problems.length) {
    fail(`[${feature.id}] 桌面端内部契约漂移：${problems.join("；")}`);
    failures += 1;
  } else {
    pass(`[${feature.id}] 桌面端声明的依赖点与源码一致`);
  }
}

// 历史回归：探测脚本绝不能读跨页签共享的全局未读集合
const statusSrc = readText("src/main/tabs/tab-status.ts");
if (/getItem\(\s*["']pi-web:unread-session-ids/.test(statusSrc)) {
  fail("[guard] 状态探测又去读了 pi-web:unread-session-ids（会让所有页签一起亮提示点）");
  failures += 1;
} else {
  pass("[guard] 状态探测没有读取 pi-web:unread-session-ids");
}
// 主题事件标记：导出常量必须与注入脚本里的字面量一致，否则事件驱动会静默失效
const themeProbe = readText("src/main/tabs/theme-probe.ts");
const markerMatch = /export const THEME_CHANGED_MARKER = "([^"]+)";/.exec(themeProbe);
if (!markerMatch || !themeProbe.includes(`console.info("${markerMatch[1]}")`)) {
  fail("[guard] THEME_CHANGED_MARKER 与主题 observer 脚本里的标记不一致");
  failures += 1;
} else {
  pass("[guard] 主题事件标记在常量与注入脚本间一致");
}
// 第三阶段拆分后，TabManager 主逻辑不应再内联页面注入脚本
const tabManager = readText("src/main/tabs/tab-manager.ts");
// 提交模式全自动：只有一个主按钮，没有 ▾ 下拉 / 独立模式栏 / 第二个「原生输入框」按钮
const tabbarHtml = readText("src/renderer/tabbar/index.html");
const noManualMode =
  !tabbarHtml.includes("draft-modebar") &&
  !tabbarHtml.includes('id="draft-native"') &&
  !tabbarHtml.includes('id="draft-submit-more"') &&
  !tabbarHtml.includes('id="draft-menu"') &&
  tabbarHtml.includes('id="draft-send"');
if (!noManualMode) {
  fail("[guard] 提交模式应全自动：只允许一个主按钮，不得有 ▾ 下拉 / 手动模式栏");
  failures += 1;
} else {
  pass("[guard] 提交模式全自动，面板只有单个主按钮");
}
// 应用退出 / 回启动页时 destroy() 会逐个 disposeTab，不能把它当成「用户关页签」清空草稿
if (!tabManager.includes("if (!options.keepWindow) this.options.onTabClosed?.(tab.id);")) {
  fail("[guard] onTabClosed 未用 keepWindow 守卫：退出时会清光 drafts.json，重启恢复永远失效");
  failures += 1;
} else {
  pass("[guard] 退出时逐个销毁视图不会误清草稿");
}
if (tabManager.includes("String.raw`")) {
  fail("[guard] tab-manager.ts 里又出现了内联注入脚本（应放在独立模块里）");
  failures += 1;
} else {
  pass("[guard] 页面注入脚本全部在独立模块中");
}
const extracted = [
  "src/main/tabs/tab-status-manager.ts",
  "src/main/tabs/notification-bridge.ts",
  "src/main/tabs/theme-manager.ts",
  "src/main/tabs/tab-lifecycle.ts",
  "src/main/tabs/tab-model.ts",
  "src/main/server/runtime-update.ts",
];
const missingModules = extracted.filter((file) => !readText(file));
if (missingModules.length) {
  fail(`[guard] 拆分后的模块缺失：${missingModules.join("、")}`);
  failures += 1;
} else {
  pass("[guard] TabManager 拆分出的 6 个独立模块都在");
}

// 零侵入：桌面端不把上游包作为本地依赖，也不使用 patch-package
const pkg = JSON.parse(readText("package.json") || "{}");
const localUpstream = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((k) => k === PACKAGE);
const patchPackage = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).includes("patch-package");
if (localUpstream.length || patchPackage) {
  fail("[guard] 检测到本地上游依赖 / patch-package，违反「不侵入 pi-web」原则");
  failures += 1;
} else {
  pass("[guard] 未修改上游：无本地 @agegr/pi-web 依赖、无 patch-package");
}

/* ---------------- 2. 上游契约（只读扫描，缺包时标 unverified） ---------------- */
const install = findPiWebRoot();
if (!install) {
  info(`未找到本机 ${PACKAGE}，上游契约检查记为「未验证」（不视为失败）`);
  info("可用 PI_WEB_DESKTOP_PI_WEB_ROOT 指向 pi-web 包目录以启用扫描");
} else {
  info(`只读扫描 ${PACKAGE} v${install.version}：${install.root}`);
  for (const feature of FEATURES) {
    const { foundAny, missing } = upstreamNeedles(install.root, feature.upstream);
    if (!foundAny) {
      info(`[${feature.id}] 未找到可扫描的上游构建文件 → 未验证`);
    } else if (missing.length) {
      fail(`[${feature.id}] 上游契约缺失：${missing.join("、")}（该增强应降级，并跑升级回归清单）`);
      failures += 1;
    } else {
      pass(`[${feature.id}] 上游契约未见破坏（不等于功能完全兼容，仍需人工回归）`);
    }
  }
  info(`composer：独立输入工作区依赖原生 Composer 选择器（含 steer/followUp 标签）；契约破坏即禁止发送、原生输入框不受影响（见 check:composer-bridge）`);
}

info(`pi-web 运行记录目录（只读，不写）：${join(homedir(), ".pi", "agent", "pi-web-run")}`);
if (failures) process.exit(1);
console.log("上游契约检查通过");
