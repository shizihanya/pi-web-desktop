#!/usr/bin/env node
/**
 * 草稿状态纯逻辑回归（不启动 Electron）：
 *  - 页签 / 会话隔离、切换会话不误发、关闭面板不丢、成功清空、失败保留；
 *  - 连续快速点击发送不重复提交；
 *  - 大量文本；重启恢复按 path + sessionKey 一对一匹配。
 *
 *   npm run check:draft-model
 */
import {
  DRAFT_MAX_WIDTH,
  DRAFT_MIN_WIDTH,
  DraftStore,
  SendGate,
  clampPanelWidth,
  contextKey,
  draftKey,
  matchPersistedDrafts,
  sessionKeyFromPath,
  verifyDraftTarget,
} from "../src/main/tabs/draft-model.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const tabA = { tabId: "tab-a", sessionKey: "session:s1" };
const tabB = { tabId: "tab-b", sessionKey: "session:s1" };
const tabAs2 = { tabId: "tab-a", sessionKey: "session:s2" };
const ctxA = { ...tabA, title: "会话 1", path: "/?session=s1" };
const ctxB = { ...tabB, title: "会话 1", path: "/?session=s1" };
const ctxAs2 = { ...tabAs2, title: "会话 2", path: "/?session=s2" };
const ctxNew = { tabId: "tab-a", sessionKey: "new", title: "新会话", path: "/" };
const ctxCwd = {
  tabId: "tab-c",
  sessionKey: "cwd:D:/work",
  title: "项目",
  path: "/?cwd=D%3A%2Fwork",
};

/* ---------------- 面板宽度（拖动分隔条） ---------------- */
check("默认宽度在合法区间", clampPanelWidth(380, 1440) === 380);
check("过窄钳到下限", clampPanelWidth(50, 1440) === DRAFT_MIN_WIDTH);
check("过宽钳到上限", clampPanelWidth(99999, 1440) === DRAFT_MAX_WIDTH);
check("小窗口时上限不超过 60% 窗宽", clampPanelWidth(99999, 800) === 480);
check("NaN 回落到默认 380", clampPanelWidth(Number.NaN, 1440) === 380);

/* ---------------- 会话身份解析 ---------------- */
check("session 优先于 cwd", sessionKeyFromPath("/?session=s1&cwd=/x") === "session:s1");
check("cwd 作为新会话身份", sessionKeyFromPath("/?cwd=D%3A%2Fwork") === "cwd:D:/work");
check("无参数 = new", sessionKeyFromPath("/") === "new");
check("带 hash 也能解析", sessionKeyFromPath("/?session=s9#p") === "session:s9");
check("同一会话不同页签 key 不同", draftKey(tabA) !== draftKey(tabB));
check("同一页签不同会话 key 不同", draftKey(tabA) !== draftKey(tabAs2));
check("contextKey 含标题，标题变化可感知", contextKey(ctxA) !== contextKey({ ...ctxA, title: "改名" }));

/* ---------------- 草稿隔离 ---------------- */
const store = new DraftStore();
store.set(ctxA, "A 的长草稿");
store.set(ctxB, "B 的草稿");
store.set(ctxAs2, "A 切到会话 2 的草稿");
check("切换页签不会串用其他页签草稿", store.get(tabA) === "A 的长草稿" && store.get(tabB) === "B 的草稿");
check("同一页签切换会话不会串用旧会话草稿", store.get(tabAs2) === "A 切到会话 2 的草稿");
check("新会话草稿独立", (store.set(ctxNew, "新会话草稿"), store.get(ctxNew) === "新会话草稿"));
check("cwd 会话草稿独立", (store.set(ctxCwd, "项目草稿"), store.get(ctxCwd) === "项目草稿"));

/* ---------------- 大量文本 ---------------- */
const big = "长文本回归 ".repeat(20_000);
store.set(ctxA, big);
check("支持大量文本（>10 万字符）", store.get(tabA).length === big.length && big.length > 100_000);

/* ---------------- 关闭面板不丢 / 成功清空 / 失败保留 ---------------- */
// 面板开合不改 store，所以「收起」前后草稿内容不变
const beforeClose = store.get(tabA);
check("关闭编辑面板不丢草稿", beforeClose === big);
// 发送成功：clear；发送失败：不 clear
store.clear(tabA);
check("发送成功后清空本次草稿", store.get(tabA) === "");
store.set(tabA, "失败保留的草稿");
check("发送失败时保留草稿（不调用 clear）", store.get(tabA) === "失败保留的草稿");
check("清空 A 不影响 B / A-s2", store.clear(tabA) === undefined && store.get(tabB) === "B 的草稿" && store.get(tabAs2) === "A 切到会话 2 的草稿");
check("清空空串等于删除", (store.set(ctxA, ""), store.get(tabA) === ""));

/* ---------------- 发送前目标复核 ---------------- */
check("目标一致 → 允许发送", verifyDraftTarget({ tabId: "tab-a", sessionKey: "session:s1" }, tabA).ok);
check(
  "目标页签已关闭 → 禁止发送",
  !verifyDraftTarget(null, tabA).ok && verifyDraftTarget(null, tabA).reason.includes("已关闭"),
);
check(
  "当前页签已切换 → 禁止发送",
  !verifyDraftTarget({ tabId: "tab-z", sessionKey: "session:s1" }, tabA).ok,
);
check(
  "会话已切换 → 禁止发送旧会话草稿",
  !verifyDraftTarget({ tabId: "tab-a", sessionKey: "session:s2" }, tabA).ok,
);

/* ---------------- 连续快速点击 ---------------- */
const gate = new SendGate();
const key = draftKey(tabA);
check("第一次点击放行", gate.begin(key) === true);
check("第二次 / 第三次点击被拦住", gate.begin(key) === false && gate.begin(key) === false);
check("结果回来后可再次发送", (gate.end(key), gate.begin(key) === true));
gate.end(key);
check("不同草稿互不阻塞", gate.begin(key) === true && gate.begin(draftKey(tabB)) === true);
gate.end(key);
gate.end(draftKey(tabB));
check("闸门清空", gate.size === 0);

/* ---------------- 页签关闭清理 / 重启恢复 ---------------- */
const closing = new DraftStore();
closing.set(ctxA, "A-1");
closing.set(ctxAs2, "A-2");
closing.set(ctxB, "B-1");
closing.clearTab("tab-a");
check("页签关闭清掉它名下所有会话草稿", closing.get(tabA) === "" && closing.get(tabAs2) === "" && closing.get(tabB) === "B-1");

const restored = matchPersistedDrafts(
  [{ ...ctxA, tabId: "new-uuid-1" }, { ...ctxB, tabId: "new-uuid-2" }, { ...ctxAs2, tabId: "new-uuid-3" }],
  [
    { path: "/?session=s1", sessionKey: "session:s1", text: "恢复-A" },
    { path: "/?session=s2", sessionKey: "session:s2", text: "恢复-A2" },
  ],
);
check("重启按 path + sessionKey 恢复，不按会变的 tabId", restored.length === 2);
check(
  "同一个持久化条目不会同时恢复到两个页签（一对一）",
  matchPersistedDrafts([{ ...ctxA, tabId: "x" }, { ...ctxA, tabId: "y" }], [
    { path: "/?session=s1", sessionKey: "session:s1", text: "只有一份" },
  ]).length === 1,
);
const hydrated = new DraftStore();
hydrated.hydrate(restored);
check("hydrate 后可用新 tabId 取到草稿", hydrated.get({ tabId: "new-uuid-1", sessionKey: "session:s1" }) === "恢复-A");

if (failed) process.exit(1);
console.log("草稿状态纯逻辑检查通过");
