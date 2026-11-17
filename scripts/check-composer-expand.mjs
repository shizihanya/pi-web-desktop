/**
 * 大输入框注入脚本的回归检查：不启动 Electron，只做语法 + 关键契约检查。
 * String.raw 里的正则/换行很容易写坏，这个脚本锁住最容易断的几处。
 *
 *   node scripts/check-composer-expand.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const src = fs.readFileSync("src/main/tabs/composer-expand.ts", "utf8");
const match = /export const COMPOSER_EXPAND_SCRIPT = String\.raw`([\s\S]*?)`;/.exec(src);
if (!match) throw new Error("COMPOSER_EXPAND_SCRIPT 未找到");
const code = match[1];

try {
  new Function(code);
} catch (error) {
  console.error("注入脚本语法错误：", error.message);
  process.exit(1);
}

const required = [
  "textarea.chat-input-textarea", // pi-web 主输入框的稳定 class
  "file-panel", // 编辑器停靠在 pi-web 的右侧面板里
  "right-panel-open",
  "aria-controls=\"file-panel\"",
  "findSendButton(ta, true)", // ⤢ 贴着发送按钮定位
  "展开大输入框",
  "发送到对话",
  "HTMLTextAreaElement.prototype",
  "dispatchEvent(new Event('input'", // React 受控输入必须走原生 setter + input 事件
  "pi-enter-send-mode", // Enter / Ctrl+Enter 发送模式
  "var(--bg-panel", // 跟随 pi-web 主题
];

const missing = required.filter((needle) => !code.includes(needle));
if (missing.length) {
  console.error("注入脚本缺少关键契约：", missing.join(", "));
  process.exit(1);
}
console.log("大输入框注入脚本检查通过");

// 顺带核对本机 pi-web 的页面契约：升级后如果选择器变了，这里会直接报出来
let piWebDir;
try {
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  piWebDir = path.join(root, "@agegr", "pi-web");
} catch {
  piWebDir = null;
}
if (piWebDir && fs.existsSync(piWebDir)) {
  const appDir = path.join(piWebDir, ".next", "static", "chunks", "app");
  const page = fs.existsSync(appDir)
    ? fs.readdirSync(appDir).find((name) => /^page-.*\.js$/.test(name))
    : null;
  if (!page) {
    console.warn("⚠ 找到 pi-web 但没找到页面 chunk，跳过上游契约检查");
  } else {
    const bundle = fs.readFileSync(path.join(appDir, page), "utf8");
    const contracts = [
      ['输入框 class', 'className:"chat-input-textarea"'],
      ['发送按钮标签', 'chat.send'],
      ['右侧面板', 'id:"file-panel"'],
      ['面板展开按钮', 'file-panel-expand-button'],
      ['完成事件', 'agent_end'],
    ];
    const broken = contracts.filter(([, needle]) => !bundle.includes(needle)).map(([label]) => label);
    if (broken.length) {
      console.error("✗ 本机 pi-web 契约已变化，注入功能可能失效：", broken.join(", "));
      process.exit(1);
    }
    const version = JSON.parse(fs.readFileSync(path.join(piWebDir, "package.json"), "utf8")).version;
    console.log(`✓ 本机 pi-web ${version} 的页面契约仍匹配`);
  }
} else {
  console.log("· 未找到本机 pi-web，跳过上游契约检查");
}
