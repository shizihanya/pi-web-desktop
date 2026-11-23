#!/usr/bin/env node
/**
 * Windows Toast XML / launch 参数的纯逻辑回归：不启动 Electron。
 *
 *   npm run check:notification-toast
 */
import {
  buildNotificationToastXml,
  escapeXml,
  parseNotificationLaunchArguments,
  sanitizeNotificationTag,
} from "../src/main/tabs/notification-toast.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const id = "11111111-2222-4333-8444-555555555555";
const xml = buildNotificationToastXml({
  title: `任务完成 <${"&"}> "标题"`,
  body: "会话 A & 会话 B",
  tag: "pi-session-complete:abc",
  silent: true,
}, id);

check("toast 根节点带 launch", xml.startsWith(`<toast launch="piweb-desktop&amp;nid=${id}">`), xml.slice(0, 90));
check("标题和正文做 XML 转义", xml.includes("&lt;") && xml.includes("&amp;") && xml.includes("&quot;"), xml);
check("silent 音频节点保留", xml.includes('<audio silent="true"/>'), xml);
check("没有注入额外按钮", !xml.includes("<actions"), xml);

check(
  "launch 参数可解析出主进程通知 ID",
  parseNotificationLaunchArguments(`piweb-desktop&nid=${id}`) === id,
  `piweb-desktop&nid=${id}`,
);
check("空参数安全返回 null", parseNotificationLaunchArguments("") === null);
check("非法 ID 安全返回 null", parseNotificationLaunchArguments("piweb-desktop&nid=<script>") === null);
check("缺少 nid 安全返回 null", parseNotificationLaunchArguments("piweb-desktop&tag=x") === null);

check("escapeXml 覆盖五个实体", escapeXml(`&<>"'`) === "&amp;&lt;&gt;&quot;&apos;");
check(
  "tag 被限制为安全字符",
  sanitizeNotificationTag("pi-session-complete:abc<>&", "fallback") === "pisessioncompleteabc",
  sanitizeNotificationTag("pi-session-complete:abc<>&", "fallback"),
);
check(
  "空 tag 回落到安全值",
  /^[A-Za-z0-9]+$/.test(sanitizeNotificationTag("", "11111111-2222-4333-8444-555555555555")),
);

if (failed) process.exit(1);
console.log("Windows Toast XML 检查通过");
