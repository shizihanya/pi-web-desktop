#!/usr/bin/env node
/**
 * 独立输入工作区的页面注入脚本回归（不启动 Electron）。
 *
 * 锁住最容易写坏 / 最容易造成「错误发送」的几处：
 *  - 两个脚本语法可解析（String.raw 里的正则、反斜杠很容易坏）；
 *  - 只通过 pi-web 原生 textarea + 原生提交按钮发送，绝不自己发 /api/agent/*；
 *  - React 受控输入必须走原生 value setter + input 事件；
 *  - 失败时恢复原生输入框、不清草稿；会话变化 / 作用域不明一律禁止发送；
 *  - 页面 realm 内不再注入任何可见按钮 / 常驻定时器；
 *  - payload 通过 JSON 注入，特殊字符不会破坏脚本。
 *
 *   npm run check:composer-bridge
 */
import fs from "node:fs";
import {
  COMPOSER_PROBE_SCRIPT,
  buildComposerSendScript,
  buildOpenInNativeScript,
  jsonForScript,
} from "../src/main/tabs/composer-bridge.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}
function compiles(label, code) {
  try {
    new Function(`return (${code})`);
    check(label, true);
  } catch (error) {
    check(label, false, error.message);
  }
}

/* ---------------- 语法 ---------------- */
compiles("只读探针脚本语法正确", COMPOSER_PROBE_SCRIPT);
const payload = { text: "hello", sessionKey: "session:s1", mode: "send", images: [] };
compiles("发送脚本语法正确", buildComposerSendScript(payload));
compiles("放入原生输入框脚本语法正确", buildOpenInNativeScript(payload));
compiles("steer 模式发送脚本语法正确", buildComposerSendScript({ ...payload, mode: "steer" }));
compiles("followUp 模式 + 图片发送脚本语法正确", buildComposerSendScript({
  ...payload, mode: "followUp", images: [{ data: "AAAA", mimeType: "image/png", name: "a.png" }],
}));
compiles("纯图片（空文本）发送脚本语法正确", buildComposerSendScript({
  ...payload, text: "", images: [{ data: "AAAA", mimeType: "image/png", name: "a.png" }],
}));

/* ---------------- 只读探针 ---------------- */
const probeNeeds = [
  ".chat-input-shell textarea.chat-input-textarea",
  "textarea.chat-input-textarea",
  "new URLSearchParams(window.location.search)",
  "pi-enter-send-mode",
  "aria-busy",
  "getComputedStyle(ta)",
  "typography",
  "modes",
  "findButton(scope, 'steer')",
  "document.readyState === 'complete'",
  "resolve(JSON.stringify(out))",
  "window.setTimeout(attempt, 150)",
];
for (const needle of probeNeeds) {
  check(`探针包含 ${needle}`, COMPOSER_PROBE_SCRIPT.includes(needle));
}
check("探针绝不修改 DOM", !/appendChild|insertAdjacentHTML|innerHTML\s*=/.test(COMPOSER_PROBE_SCRIPT));
check("探针绝不发请求", !/fetch\(|XMLHttpRequest/.test(COMPOSER_PROBE_SCRIPT));

/* ---------------- 不再往 pi-web 页面注入可见入口 ---------------- */
const src = fs.readFileSync("src/main/tabs/composer-bridge.ts", "utf8");
check(
  "已删除 ⤢ 页面内入口注入脚本（只保留顶部工具区按钮）",
  !src.includes("COMPOSER_ENTRY_SCRIPT") && !src.includes("__piDesktopDraftEntry") &&
    !src.includes("__PI_DESKTOP_DRAFT_OPEN__") && !src.includes("setInterval(place"),
);
check("页面 realm 里不再 appendChild / 常驻定时器", !/document\.body\.appendChild|window\.setInterval/.test(
  COMPOSER_PROBE_SCRIPT + buildComposerSendScript(payload) + buildOpenInNativeScript(payload),
));

/* ---------------- 发送脚本：安全契约 ---------------- */
const sendNeeds = [
  ".chat-input-shell textarea.chat-input-textarea",
  "closest('.chat-input-shell')",
  "currentKey !== P.sessionKey",
  "找不到 pi-web 主输入框，禁止发送",
  "无法确认主输入框作用域，禁止错误发送",
  "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set",
  "dispatchEvent(new Event('input', { bubbles: true }))",
  "function restore()",
  "button.click()",
  "findButton(shell, kind)",
  "'steer'",
  "'followUp'",
  "ClipboardEvent('paste'",
  "new DataTransfer()",
  "window.__piDesktopDraftSending",
  "function finish(result)",
  "function buttonUsable(b)",
  "function attachmentCount()",
  "value.indexOf(baselineText) === -1",
  "草稿未清空",
];
for (const needle of sendNeeds) {
  check(`发送脚本包含 ${needle}`, src.includes(needle));
}
check("发送脚本绝不自行调用 Agent API", !/fetch\(\s*["'`]\/api\/agent|XMLHttpRequest/.test(src));
check("发送脚本不构造 prompt / message 请求体", !/type:\s*["']prompt["']/.test(src));
check("发送脚本不发送键盘模拟（避免 streaming 时误触 steer）", !/KeyboardEvent|keyCode/.test(src));
check("发送脚本不依赖旧的 #file-panel / 展开按钮", !/file-panel|file-panel-expand-button/.test(src));

/* ---------------- bug 回归：空输入时发送按钮本来就是 disabled ---------------- */
const sendScript = buildComposerSendScript(payload);
const writeAt = sendScript.indexOf("setter.call(ta, finalText)");
const buttonCheckAt = sendScript.indexOf("if (!buttonUsable(button))");
check(
  "先写入文本让 React 启用按钮，再判断该模式按钮是否可用",
  writeAt > 0 && buttonCheckAt > writeAt,
  `writeAt=${writeAt} buttonCheckAt=${buttonCheckAt}`,
);
check(
  "不再用 fieldset.disabled / aria-busy 一刀切拒绝所有模式",
  !sendScript.includes("var fieldset = ta.closest('fieldset')") &&
    !sendScript.includes("pi-web 输入框当前不可用"),
);
check(
  "按模式判断按钮可用性，并给出对应模式的失败原因",
  sendScript.includes("function buttonUsable(b)") &&
    sendScript.includes("if (!buttonUsable(button))") &&
    sendScript.includes("找不到可用的原生' + label"),
);
check(
  "纯文字 / 文字+图片 / 纯图片都允许，只有两者皆空才拒绝",
  sendScript.includes("var hasText") && sendScript.includes("if (!hasText && !hasImages)"),
);
check(
  "成功判定同时看文本清空与附件消失（纯图片 P.text 为空也不会超时误报）",
  sendScript.includes("baselineText") && sendScript.includes("imagesGone") &&
    !sendScript.includes("value.indexOf(P.text)"),
);
check(
  "重复发送闸门在任何 setTimeout 之前置位，所有出口统一 finish 释放",
  sendScript.indexOf("window.__piDesktopDraftSending = true") < sendScript.indexOf("window.setTimeout(function ()") &&
    sendScript.includes("function finish(result)") &&
    (sendScript.match(/finish\(fail\(/g) ?? []).length >= 7,
);
check(
  "提交按钮标签覆盖多语言：发送 / 引导 / 后续消息",
  ["发送", "傳送", "引导", "引導", "后续消息", "後續訊息", "Steer", "Follow-up"].every((n) => src.includes(n)),
);
check(
  "放入原生输入框脚本只搬内容、不点任何提交按钮",
  !buildOpenInNativeScript(payload).includes("button.click()") &&
    buildOpenInNativeScript(payload).includes("ta.focus()"),
);

/* ---------------- payload 注入：特殊字符不会破坏脚本 ---------------- */
const nasty = [
  "普通文本",
  '带 "双引号" 和 \\ 反斜杠',
  "带 </script> 标签与 ` 反引号",
  "带 \u2028 行分隔符与 \u2029 段分隔符",
  "带换行\n与制表\t",
  "x".repeat(100_000),
];
for (const text of nasty) {
  const code = buildComposerSendScript({ text, sessionKey: "session:s1" });
  let ok = true;
  try {
    new Function(`return (${code})`);
  } catch {
    ok = false;
  }
  check(`payload 安全嵌入（长度 ${text.length}）`, ok && code.includes("var P = "), "");
}
check("jsonForScript 转义 < 避免脚本被截断", !jsonForScript("</script>").includes("<"));
check("jsonForScript 转义 U+2028/U+2029", !jsonForScript("\u2028\u2029").includes("\u2028"));
check("buildComposerSendScript 不残留占位符", !buildComposerSendScript({ text: "a", sessionKey: "new" }).includes("__PAYLOAD__"));

if (failed) process.exit(1);
console.log("独立输入工作区注入脚本检查通过");
