/**
 * 页签状态探测（零侵入：不修改 pi-web 源码/构建产物，只在页面 realm 里注入一段只读脚本）。
 *
 * 数据来源（都是 pi-web 自己就在用的契约）：
 *  - `GET /api/agent/running`：`runningSessionIds` / `awaitingInputSessionIds` /
 *    `subagentsActiveSessionIds`，pi-web 侧栏的转圈/橙点也来自这里。
 *    用页面内 fetch，登录态 / cookie / Basic Auth 都自动带上，主进程不用碰密码。
 *  - `?session=<id>`（URL 契约）定位「这个页签当前选中的对话」；URL 还没有 session 时
 *    退到侧栏选中行 `.session-tree-session.is-selected[data-row-key]`。
 *
 * ⚠️ 刻意**不读** `pi-web:unread-session-ids`：它是同源 localStorage，被所有页签共享，
 *    而且 pi-web 在每个页面里都会给「非当前会话」写标记、后台页签又不会清理，长期残留
 *    一堆历史会话。它是「会话级」语义，拿来做「页签级」提示会让所有页签一起亮。
 *    「回答完毕未查看」改由主进程按页签自己追踪 running→idle 跳变（见 tab-manager.ts）。
 *
 * 同理，侧栏的 `.session-tree-unread` 也是全局未读集合算出来的，不用作判据；
 * `.is-running` / `.session-tree-awaiting` 是逐行按当前会话算的，可安全兜底。
 */

/** `window.__piDesktopTabStatus.read()` 返回的结果（纯 JSON 数据） */
export interface TabStatusProbe {
  /** 该页签当前选中的会话 id；拿不到时为 null（例如空会话 / 登录页） */
  sessionId: string | null;
  /** id 的来源：url 最可靠，dom 是侧栏选中行兜底 */
  sessionSource: "url" | "dom" | null;
  /** 正在跑（等待回答） */
  running: boolean;
  /** 在等用户确认（工具授权 / 提问） */
  awaiting: boolean;
  /** 是否至少成功拉过一次 /api/agent/running（调试用） */
  ready: boolean;
}

/** 主进程每次轮询执行的小表达式；返回 JSON 字符串，避免结构化克隆的边界问题 */
export const TAB_STATUS_READ_SCRIPT = String.raw`(() => {
  try {
    const probe = window.__piDesktopTabStatus;
    return probe ? JSON.stringify(probe.read()) : "null";
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
})()`;

/**
 * 注入脚本。幂等：dom-ready / did-finish-load 会各执行一次，重复执行直接返回。
 * 注意：用 String.raw，内部不要用模板字符串 / 正则，避免和历史上的主题探测一样被转义坑到。
 */
export const TAB_STATUS_PROBE_SCRIPT = String.raw`(() => {
  if (window.__piDesktopTabStatus) return;

  var cache = { running: [], awaiting: [], subagents: [], at: 0, ready: false };
  var polling = false;

  function selectedRow() {
    try {
      return document.querySelector(".session-tree-row.session-tree-session.is-selected");
    } catch (e) {
      return null;
    }
  }

  function currentSession(row) {
    try {
      var fromUrl = new URLSearchParams(window.location.search).get("session");
      if (fromUrl) return { id: fromUrl, source: "url" };
    } catch (e) {}
    if (!row) return { id: null, source: null };
    // data-row-key = "session:<context>:<sessionId>"
    var parts = String(row.getAttribute("data-row-key") || "").split(":");
    var id = parts.length >= 3 ? parts.slice(2).join(":") || null : null;
    return { id: id, source: id ? "dom" : null };
  }

  function has(list, id) {
    return !!id && list.indexOf(id) !== -1;
  }

  function refresh() {
    if (polling) return Promise.resolve();
    polling = true;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
    return fetch("/api/agent/running", {
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) return null;
      return response.json();
    }).then(function (data) {
      if (!data || typeof data !== "object") return;
      cache.running = Array.isArray(data.runningSessionIds) ? data.runningSessionIds : [];
      cache.awaiting = Array.isArray(data.awaitingInputSessionIds) ? data.awaitingInputSessionIds : [];
      cache.subagents = Array.isArray(data.subagentsActiveSessionIds) ? data.subagentsActiveSessionIds : [];
      cache.ready = true;
      cache.at = Date.now();
    }).catch(function () {
      // 服务重启 / 登录页 / 网络抖动：保留上一轮数据，下一次 read() 会再试
    }).then(function () {
      if (timer !== null) clearTimeout(timer);
      polling = false;
    });
  }

  function read() {
    // 后台刷新，read() 本身同步返回，主进程的轮询不会被网络拖住
    if (!cache.ready || Date.now() - cache.at > 600) void refresh();

    var row = selectedRow();
    var current = currentSession(row);
    var id = current.id;
    return {
      sessionId: id,
      sessionSource: current.source,
      running:
        has(cache.running, id) ||
        has(cache.subagents, id) ||
        !!(row && row.classList.contains("is-running")),
      awaiting:
        has(cache.awaiting, id) ||
        !!(row && row.querySelector(".session-tree-awaiting")),
      ready: cache.ready
    };
  }

  window.__piDesktopTabStatus = { read: read, refresh: refresh };
  void refresh();
})()`;
